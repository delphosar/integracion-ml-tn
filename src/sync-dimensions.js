/**
 * sync-dimensions.js
 *
 * Lee las dimensiones del paquete de ML (SELLER_PACKAGE_*) para cada producto
 * y las asigna en TiendaNube (weight, width, height, depth).
 *
 * Uso:
 *   node src/sync-dimensions.js [--dry-run] [--limit=N] [--resume]
 *
 *   --dry-run  : muestra cambios sin aplicarlos en TN
 *   --limit=N  : procesa como máximo N productos
 *   --resume   : saltea los ya procesados en sync-dimensions-results.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const { getDb } = require('./db');
const tnApi     = require('./tn-api');

const DRY_RUN    = process.argv.includes('--dry-run');
const RESUME     = process.argv.includes('--resume');
const LIMIT      = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0', 10) || null;
const DELAY_MS   = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const RESULTS_PATH = path.join(__dirname, '..', 'data', 'sync-dimensions-results.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// "82 cm" → 82   |   "25800 g" → 25800   |   null si no parseable
function parseNum(str) {
  if (!str) return null;
  const m = str.match(/[\d]+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

// Construye payload TN de dimensiones para un item dado su mapa de atributos y shipping.dimensions
function buildDimPayload(pkgAttrs, shippingDims) {
  const payload = {};

  // Fuente 1: SELLER_PACKAGE_* (preferida — cada campo con nombre explícito)
  if (pkgAttrs) {
    const w  = parseNum(pkgAttrs.SELLER_PACKAGE_WIDTH);
    const h  = parseNum(pkgAttrs.SELLER_PACKAGE_HEIGHT);
    const d  = parseNum(pkgAttrs.SELLER_PACKAGE_LENGTH);
    const wg = parseNum(pkgAttrs.SELLER_PACKAGE_WEIGHT); // gramos

    if (w  != null) payload.width  = Math.round(w);
    if (h  != null) payload.height = Math.round(h);
    if (d  != null) payload.depth  = Math.round(d);
    if (wg != null) payload.weight = (wg / 1000).toFixed(3); // kg como string
  }

  // Fuente 2: shipping.dimensions "WxHxD,weightGrams" (fallback si no hay attrs)
  if (Object.keys(payload).length === 0 && shippingDims) {
    const m = shippingDims.match(/^(\d+\.?\d*)x(\d+\.?\d*)x(\d+\.?\d*),(\d+\.?\d*)$/);
    if (m) {
      payload.width  = Math.round(parseFloat(m[1]));
      payload.height = Math.round(parseFloat(m[2]));
      payload.depth  = Math.round(parseFloat(m[3]));
      payload.weight = (parseFloat(m[4]) / 1000).toFixed(3);
    }
  }

  if (Object.keys(payload).length === 0) return null;

  // Descartar si todos los valores numéricos son 0 (dato inválido en ML)
  const numericVals = [payload.width, payload.height, payload.depth, parseFloat(payload.weight ?? '0')];
  if (numericVals.every(v => !v || v === 0)) return null;

  return payload;
}

async function main() {
  console.log(`[sync-dimensions] Iniciando${DRY_RUN ? ' (DRY RUN)' : ''}${RESUME ? ' (RESUME)' : ''}${LIMIT ? ` (limit ${LIMIT})` : ''}...`);
  const started = Date.now();

  const db = await getDb();

  // --- Cargar pares ml_item_id ↔ tn_product_id ---
  const pairsRes = db.exec(`
    SELECT tp.ml_item_id, tp.tn_product_id
    FROM   tn_products tp
    JOIN   ml_items i ON i.id = tp.ml_item_id
    ORDER  BY tp.ml_item_id
  `);
  let pairs = (pairsRes[0]?.values ?? []).map(([mlId, tnId]) => ({ mlId, tnId }));

  // --- Precarga: atributos de paquete ---
  const attrsRes = db.exec(`
    SELECT item_id, attribute_id, value_name
    FROM   ml_attributes
    WHERE  attribute_id IN (
      'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_HEIGHT',
      'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT'
    )
  `);
  const attrsMap = new Map(); // mlId → { SELLER_PACKAGE_WIDTH, ... }
  for (const [itemId, attrId, valueName] of attrsRes[0]?.values ?? []) {
    if (!attrsMap.has(itemId)) attrsMap.set(itemId, {});
    attrsMap.get(itemId)[attrId] = valueName;
  }

  // --- Precarga: shipping.dimensions desde raw_json ---
  const shipRes = db.exec(`
    SELECT id, json_extract(raw_json, '$.shipping.dimensions') as dims
    FROM   ml_items
    WHERE  json_extract(raw_json, '$.shipping.dimensions') IS NOT NULL
  `);
  const shipMap = new Map(); // mlId → "WxHxD,weightG"
  for (const [id, dims] of shipRes[0]?.values ?? []) {
    shipMap.set(id, dims);
  }

  // --- Resume: cargar resultados anteriores ---
  const prevResults = RESUME && fs.existsSync(RESULTS_PATH)
    ? JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'))
    : [];
  // Saltear: ya actualizados, sin datos en ML, y eliminados en TN (no tiene sentido reintentar)
  const SKIP_STATUSES = new Set(['updated', 'no-data', 'not-found']);
  const doneMlIds = new Set(prevResults.filter(r => SKIP_STATUSES.has(r.status)).map(r => r.mlId));
  if (RESUME) {
    const before = pairs.length;
    pairs = pairs.filter(p => !doneMlIds.has(p.mlId));
    const retrying = pairs.length;
    console.log(`  Resume: ${doneMlIds.size} saltados, reintentando ${retrying} (de ${before})`);
  }

  if (LIMIT) pairs = pairs.slice(0, LIMIT);

  console.log(`  ${pairs.length} productos a procesar`);
  if (attrsMap.size) console.log(`  ${attrsMap.size} items con atributos SELLER_PACKAGE_*`);
  if (shipMap.size)  console.log(`  ${shipMap.size} items con shipping.dimensions`);

  const results = [...prevResults.filter(r => SKIP_STATUSES.has(r.status))];
  const stats = { updated: 0, skipped: 0, notFound: 0, errors: 0 };

  for (let i = 0; i < pairs.length; i++) {
    const { mlId, tnId } = pairs[i];

    const payload = buildDimPayload(attrsMap.get(mlId), shipMap.get(mlId));

    if (!payload) {
      stats.skipped++;
      results.push({ mlId, tnId, status: 'no-data' });
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY] ${mlId} → TN:${tnId}  ${JSON.stringify(payload)}`);
      stats.updated++;
      results.push({ mlId, tnId, status: 'dry-run', payload });
      continue;
    }

    try {
      // Las dimensiones en TN están a nivel de variante, no de producto.
      // Actualizamos todas las variantes del producto con las mismas medidas del paquete.
      const tnProduct = await tnApi.getProduct(tnId);
      await sleep(DELAY_MS);

      for (const variant of tnProduct.variants ?? []) {
        await tnApi.updateVariant(tnId, variant.id, payload);
        await sleep(DELAY_MS);
      }

      stats.updated++;
      results.push({ mlId, tnId, status: 'updated', payload });
    } catch (err) {
      if (err.response?.status === 404) {
        // Producto eliminado de TN (ej: duplicado borrado) — ignorar silenciosamente
        stats.notFound++;
        results.push({ mlId, tnId, status: 'not-found' });
      } else {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error(`\n  Error TN ${tnId}: ${detail}`);
        stats.errors++;
        results.push({ mlId, tnId, status: 'error', error: detail });
      }
    }

    await sleep(DELAY_MS);

    if ((i + 1) % 50 === 0 || i === pairs.length - 1) {
      process.stdout.write(`\r  Progreso: ${i + 1} / ${pairs.length}  `);
      // Guardar resultados parciales
      if (!DRY_RUN) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    }
  }

  if (!DRY_RUN) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n\n[sync-dimensions] Completado en ${elapsed}s`);
  console.log(`  Actualizados: ${stats.updated} | Sin datos: ${stats.skipped} | No encontrados (eliminados): ${stats.notFound} | Errores: ${stats.errors}`);
  if (!DRY_RUN) console.log(`  Resultados guardados en data/sync-dimensions-results.json`);
}

main().catch(err => {
  console.error('[sync-dimensions] Error fatal:', err.message);
  process.exit(1);
});
