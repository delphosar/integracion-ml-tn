require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb, saveToFile } = require('./db');
const { getValidToken } = require('./ml-auth');
const { fetchItemsBatch } = require('./ml-api');
const tnApi = require('./tn-api');

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const BATCH_SIZE = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function n(v) { return v ?? null; }

async function main() {
  console.log(`[sync-delta] Iniciando${DRY_RUN ? ' (DRY RUN — sin cambios en TN)' : ''}...`);
  const started = Date.now();

  // 1. Obtener token válido
  const token = await getValidToken();

  // 2. Cargar DB y todos los pares ml_item_id ↔ tn_product_id (solo activos)
  const db = await getDb();

  const pairsResult = db.exec(`
    SELECT tp.ml_item_id, tp.tn_product_id
    FROM   tn_products tp
    JOIN   ml_items i ON i.id = tp.ml_item_id
    WHERE  i.status = 'active'
    ORDER  BY tp.ml_item_id
  `);
  const pairs = (pairsResult[0]?.values ?? []).map(([mlId, tnId]) => ({ mlId, tnId }));
  console.log(`  ${pairs.length} productos activos a verificar`);

  const stats = { checked: 0, changed: 0, updated: 0, errors: 0 };

  // 3. Procesar en batches de 20
  for (let i = 0; i < pairs.length; i += BATCH_SIZE) {
    const batch = pairs.slice(i, i + BATCH_SIZE);
    const ids = batch.map(p => p.mlId);

    let mlResults;
    try {
      mlResults = await fetchItemsBatch(ids, token);
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`\n  Error fetching batch [${i}–${i + BATCH_SIZE}]: ${err.message}`);
      stats.errors += batch.length;
      continue;
    }

    for (const { code, body: mlItem } of mlResults) {
      if (code !== 200 || !mlItem?.id) { stats.errors++; continue; }

      stats.checked++;
      const pair = batch.find(p => p.mlId === mlItem.id);
      if (!pair) continue;

      // Leer valores actuales de SQLite
      const dbItemRes = db.exec(
        `SELECT price, original_price, available_quantity FROM ml_items WHERE id = ?`,
        [mlItem.id]
      );
      if (!dbItemRes[0]?.values?.length) continue;
      const [dbPrice, dbOrigPrice, dbQty] = dbItemRes[0].values[0];

      const changes = detectChanges(mlItem, dbPrice, dbOrigPrice, dbQty, db);
      if (!changes.hasChanges) continue;

      stats.changed++;
      logChanges(mlItem.id, pair.tnId, changes, dbPrice, dbOrigPrice, dbQty);

      if (!DRY_RUN) {
        try {
          await applyChanges(mlItem, pair.tnId, changes, db);
          stats.updated++;
        } catch (err) {
          const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
          console.error(`    Error actualizando TN ${pair.tnId}: ${detail}`);
          stats.errors++;
        }
      }
    }

    process.stdout.write(`\r  Progreso: ${Math.min(i + BATCH_SIZE, pairs.length)} / ${pairs.length}  `);
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n\n[sync-delta] Completado en ${elapsed}s`);
  console.log(`  Verificados: ${stats.checked} | Cambios detectados: ${stats.changed} | Actualizados en TN: ${stats.updated} | Errores: ${stats.errors}`);

  if (!DRY_RUN && stats.updated > 0) saveToFile();
}

// ---------------------------------------------------------------------------
// Detección de cambios
// ---------------------------------------------------------------------------

function detectChanges(mlItem, dbPrice, dbOrigPrice, dbQty, db) {
  const changes = {
    hasChanges: false,
    priceChanged: false,
    stockChanged: false,
    variationsChanged: [],
  };

  const hasVariations = mlItem.variations?.length > 0;

  if (!hasVariations) {
    if (mlItem.price !== dbPrice || (mlItem.original_price ?? null) !== (dbOrigPrice ?? null)) {
      changes.priceChanged = true;
      changes.hasChanges = true;
    }
    if (mlItem.available_quantity !== dbQty) {
      changes.stockChanged = true;
      changes.hasChanges = true;
    }
    return changes;
  }

  // Con variaciones: comparar cada variante contra ml_variations en SQLite
  const dbVarsRes = db.exec(
    `SELECT id, price, available_quantity, seller_custom_field FROM ml_variations WHERE item_id = ?`,
    [mlItem.id]
  );
  const dbVarsMap = new Map();
  for (const [id, price, qty, scf] of (dbVarsRes[0]?.values ?? [])) {
    dbVarsMap.set(id, { price, qty, scf });
  }

  for (const v of mlItem.variations) {
    const dbVar = dbVarsMap.get(v.id);
    if (!dbVar) continue;
    const varChange = { variation: v, dbVar };
    if (v.price !== dbVar.price) varChange.priceChanged = true;
    if (v.available_quantity !== dbVar.qty) varChange.stockChanged = true;
    if (varChange.priceChanged || varChange.stockChanged) {
      changes.variationsChanged.push(varChange);
      changes.hasChanges = true;
    }
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Aplicar cambios en TiendaNube
// ---------------------------------------------------------------------------

async function applyChanges(mlItem, tnId, changes, db) {
  const hasVariations = mlItem.variations?.length > 0;

  if (!hasVariations) {
    await applySimpleProduct(mlItem, tnId, changes, db);
  } else {
    await applyVariationsProduct(mlItem, tnId, changes, db);
  }
}

async function applySimpleProduct(mlItem, tnId, changes, db) {
  const tnProduct = await tnApi.getProduct(tnId);
  await sleep(DELAY_MS);

  const variant = tnProduct.variants?.[0];
  if (!variant) throw new Error(`TN producto ${tnId} no tiene variantes`);

  const payload = buildVariantPayload(changes, mlItem.price, mlItem.original_price, mlItem.available_quantity);
  await tnApi.updateVariant(tnId, variant.id, payload);
  await sleep(DELAY_MS);

  // Actualizar SQLite
  db.run(
    `UPDATE ml_items SET price = ?, original_price = ?, available_quantity = ?, synced_at = datetime('now') WHERE id = ?`,
    [n(mlItem.price), n(mlItem.original_price), n(mlItem.available_quantity), mlItem.id]
  );
}

async function applyVariationsProduct(mlItem, tnId, changes, db) {
  const tnProduct = await tnApi.getProduct(tnId);
  await sleep(DELAY_MS);

  // Construir mapa SKU → variante TN
  const tnVariantsMap = new Map();
  for (const v of tnProduct.variants ?? []) {
    if (v.sku) tnVariantsMap.set(v.sku, v);
  }

  for (const { variation, priceChanged, stockChanged } of changes.variationsChanged) {
    const sku = variation.seller_custom_field ?? `${mlItem.id}-${variation.id}`;
    const tnVariant = tnVariantsMap.get(sku);
    if (!tnVariant) {
      console.warn(`    Variante SKU "${sku}" no encontrada en TN ${tnId} — se saltea`);
      continue;
    }

    const varChanges = { priceChanged, stockChanged };
    // Para precio de variaciones, usamos el ratio del item padre para calcular el tachado
    const varPayload = buildVariantPayload(
      varChanges,
      variation.price,
      computeVariationOriginalPrice(mlItem, variation.price),
      variation.available_quantity
    );

    await tnApi.updateVariant(tnId, tnVariant.id, varPayload);
    await sleep(DELAY_MS);

    // Actualizar SQLite
    db.run(
      `UPDATE ml_variations SET price = ?, available_quantity = ? WHERE id = ? AND item_id = ?`,
      [n(variation.price), n(variation.available_quantity), variation.id, mlItem.id]
    );
  }

  // Actualizar campos del item en SQLite (precio y qty total)
  const totalQty = mlItem.variations.reduce((s, v) => s + (v.available_quantity ?? 0), 0);
  db.run(
    `UPDATE ml_items SET price = ?, original_price = ?, available_quantity = ?, synced_at = datetime('now') WHERE id = ?`,
    [n(mlItem.price), n(mlItem.original_price), n(totalQty), mlItem.id]
  );
}

// Calcula el precio "original" (tachado) de una variación.
// Si la variación tiene el mismo precio que el item, usa original_price directo
// para evitar diferencias de redondeo flotante.
function computeVariationOriginalPrice(mlItem, variationPrice) {
  if (!mlItem.original_price || !mlItem.price || mlItem.price === 0) return null;
  if (variationPrice === mlItem.price) return mlItem.original_price;
  const ratio = mlItem.original_price / mlItem.price;
  return Math.round(variationPrice * ratio * 100) / 100;
}

// Construye el payload para updateVariant según los cambios detectados
function buildVariantPayload(changes, price, originalPrice, qty) {
  const payload = {};
  if (changes.priceChanged) {
    if (originalPrice) {
      payload.price = String(originalPrice);
      payload.promotional_price = String(price);
    } else {
      payload.price = String(price);
      payload.promotional_price = null;
    }
  }
  if (changes.stockChanged) {
    payload.stock = qty;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Logging de cambios
// ---------------------------------------------------------------------------

function logChanges(mlId, tnId, changes, dbPrice, dbOrigPrice, dbQty) {
  const lines = [`  [CAMBIO] ${mlId} → TN:${tnId}`];
  if (changes.priceChanged) {
    lines.push(`    precio: ${dbPrice} → ${changes.newPrice ?? '?'} | original: ${dbOrigPrice} → ${changes.newOrigPrice ?? '?'}`);
  }
  if (changes.stockChanged) {
    lines.push(`    stock: ${dbQty} → ${changes.newQty ?? '?'}`);
  }
  if (changes.variationsChanged?.length) {
    lines.push(`    variaciones con cambios: ${changes.variationsChanged.length}`);
    for (const { variation, priceChanged, stockChanged, dbVar } of changes.variationsChanged) {
      const parts = [];
      if (priceChanged) parts.push(`precio ${dbVar.price} → ${variation.price}`);
      if (stockChanged) parts.push(`stock ${dbVar.qty} → ${variation.available_quantity}`);
      lines.push(`      var ${variation.id}: ${parts.join(', ')}`);
    }
  }
  console.log(lines.join('\n'));
}

main().catch(err => {
  console.error('[sync-delta] Error fatal:', err.message);
  process.exit(1);
});
