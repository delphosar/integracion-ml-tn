require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getDb, upsertItem, saveTnProduct, saveToFile, getTnCategoryByMlId } = require('./db');
const { getValidToken }   = require('./ml-auth');
const { getAllItemIds, getItemDetail, getItemDescription } = require('./ml-api');
const { mapMlItemToTn }   = require('./ml-to-tn-mapper');
const { createProduct, updateProductCategories } = require('./tn-api');

const DRY_RUN  = process.argv.includes('--dry-run');
const DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const TN_DELAY = parseInt(process.env.TN_REQUEST_DELAY_MS  ?? '1000', 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Retorna el conjunto de ml_item_id que ya existen en tn_products
function loadKnownIds(db) {
  const result = db.exec(`SELECT ml_item_id FROM tn_products`);
  return new Set((result[0]?.values ?? []).map(([id]) => id));
}

// ─── Por item ────────────────────────────────────────────────────────────────

async function migrateItem(db, mlId, index, total) {
  const prefix = `[${index}/${total}]`;

  // 1. Fetch detalle + descripción desde ML
  let item;
  try {
    item = await getItemDetail(mlId);
    await sleep(DELAY_MS);
    item._description = await getItemDescription(mlId);
    await sleep(DELAY_MS);
  } catch (err) {
    const msg = err.response?.data?.message ?? err.message;
    console.error(`${prefix} ✗ ${mlId} — error ML: ${msg}`);
    return 'error';
  }

  // 2. Saltar si no es active (puede haberse pausado entre getAllItemIds y ahora)
  if (item.status !== 'active') {
    console.log(`${prefix} ~ ${mlId} — status "${item.status}", se saltea`);
    return 'skipped';
  }

  // 3. Guardar en SQLite (para mantener la DB actualizada)
  if (!DRY_RUN) {
    upsertItem(item);
  }

  // 4. Mapear al formato TN
  let payload;
  try {
    payload = mapMlItemToTn(item);
  } catch (err) {
    console.error(`${prefix} ✗ ${mlId} — error de mapeo: ${err.message}`);
    return 'map_error';
  }

  if (DRY_RUN) {
    console.log(`${prefix} [DRY] ${mlId} — "${item.title.slice(0, 60)}"`);
    return 'dry';
  }

  // 5. Crear en TiendaNube
  let tnProduct;
  try {
    tnProduct = await createProduct(payload);
    saveTnProduct(mlId, String(tnProduct.id));
    console.log(`${prefix} ✓ ${mlId} → TN ${tnProduct.id} | "${item.title.slice(0, 50)}"`);
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    const msg = typeof detail === 'object' ? JSON.stringify(detail) : detail;
    console.error(`${prefix} ✗ ${mlId} — error TN: ${msg}`);
    return 'error';
  }

  // 6. Asignar categoría si existe el mapeo en tn_categories
  if (item.category_id) {
    const cat = getTnCategoryByMlId(item.category_id);
    if (cat?.tn_category_id) {
      try {
        await sleep(DELAY_MS);
        await updateProductCategories(String(tnProduct.id), [cat.tn_category_id]);
        console.log(`${prefix}   categoría asignada: ${cat.name} (TN cat ${cat.tn_category_id})`);
      } catch (err) {
        console.warn(`${prefix}   advertencia: no se pudo asignar categoría — ${err.message}`);
      }
    } else {
      console.log(`${prefix}   sin categoría mapeada para ML cat ${item.category_id}`);
    }
  }

  return 'ok';
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(60));
  console.log('  Sync nuevos productos ML → TiendaNube');
  console.log('='.repeat(60));
  if (DRY_RUN) console.log('  MODO: DRY RUN (no se crea nada en TN)');
  console.log();

  // Token válido (con auto-refresh)
  await getValidToken();  // solo para refrescar si hace falta; getAllItemIds usa process.env

  // Cargar DB y conocer IDs ya migrados
  const db = await getDb();
  const knownIds = loadKnownIds(db);
  console.log(`  Productos ya en TN: ${knownIds.size}`);

  // Obtener lista completa de IDs activos en ML
  console.log('  Obteniendo IDs de ML...');
  const allMlIds = await getAllItemIds(process.env.ML_USER_ID);
  console.log(`  Total en ML: ${allMlIds.length}`);

  // Calcular diferencia
  const newIds = allMlIds.filter((id) => !knownIds.has(id));
  console.log(`  Nuevos (no en TN): ${newIds.length}\n`);

  if (newIds.length === 0) {
    console.log('  Nada nuevo. Todo al día.');
    return;
  }

  // Migrar cada nuevo item
  const stats = { ok: 0, error: 0, map_error: 0, skipped: 0, dry: 0 };
  const startedAt = Date.now();

  for (let i = 0; i < newIds.length; i++) {
    const result = await migrateItem(db, newIds[i], i + 1, newIds.length);
    stats[result] = (stats[result] ?? 0) + 1;

    if (!DRY_RUN && result === 'ok' && i < newIds.length - 1) {
      await sleep(TN_DELAY);
    }
  }

  if (!DRY_RUN && stats.ok > 0) saveToFile();

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('  RESUMEN');
  console.log('='.repeat(60));
  if (DRY_RUN) {
    console.log(`  Encontrados: ${stats.dry ?? 0}`);
  } else {
    console.log(`  Migrados OK:   ${stats.ok ?? 0}`);
    console.log(`  Salteados:     ${stats.skipped ?? 0}`);
    console.log(`  Errores TN:    ${stats.error ?? 0}`);
    console.log(`  Errores mapa:  ${stats.map_error ?? 0}`);
  }
  console.log(`  Tiempo total: ${elapsed}s`);
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('[sync-new-items] Error fatal:', err.message);
  process.exit(1);
});
