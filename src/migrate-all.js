require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { getDb, getErpMapping, saveTnProduct } = require('./db');
const { mapMlItemToTn }                        = require('./ml-to-tn-mapper');
const { createProduct }                        = require('./tn-api');

const DELAY_MS  = parseInt(process.env.TN_REQUEST_DELAY_MS ?? '1000', 10);
const DRY_RUN   = process.argv.includes('--dry-run');
const ONLY_ACTIVE = !process.argv.includes('--all-status');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Helpers ────────────────────────────────────────────────────────────────

function loadPendingItems(db) {
  const statusFilter = ONLY_ACTIVE ? `AND i.status = 'active'` : '';
  const result = db.exec(`
    SELECT i.raw_json, i.description
    FROM   ml_items i
    WHERE  i.id NOT IN (SELECT ml_item_id FROM tn_products)
    ${statusFilter}
    ORDER  BY i.id
  `);
  if (!result[0]?.values?.length) return [];

  return result[0].values.map((row) => {
    const item = JSON.parse(row[0]);
    item.description = row[1];
    return item;
  });
}

function fmt(n, total) {
  const pct = ((n / total) * 100).toFixed(1);
  return `[${String(n).padStart(String(total).length)}/${total}  ${pct}%]`;
}

// ─── Por producto ────────────────────────────────────────────────────────────

async function uploadItem(db, item, index, total) {
  const prefix = fmt(index, total);

  let payload;
  try {
    payload = mapMlItemToTn(item);
  } catch (err) {
    return { status: 'map_error', id: item.id, error: err.message };
  }

  if (DRY_RUN) {
    const mapping = getErpMapping(item.id);
    console.log(`${prefix} [DRY] ${item.id} — "${item.title.slice(0, 60)}" | erp: ${mapping?.erp_sku ?? '-'}`);
    return { status: 'dry', id: item.id };
  }

  try {
    const result = await createProduct(payload);
    saveTnProduct(item.id, String(result.id));

    const mapping = getErpMapping(item.id);
    const erpInfo = mapping ? `erp: ${mapping.erp_sku}${mapping.is_combo ? ' (combo)' : ''}` : 'sin erp';
    console.log(`${prefix} ✓ ${item.id} → TN ${result.id} | ${erpInfo} | "${item.title.slice(0, 50)}"`);
    return { status: 'ok', id: item.id, tnId: result.id };
  } catch (err) {
    const detail = err.response?.data ?? err.message;
    const msg    = typeof detail === 'object' ? JSON.stringify(detail) : detail;
    console.error(`${prefix} ✗ ${item.id} — ${msg}`);
    return { status: 'error', id: item.id, error: msg };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.TN_ACCESS_TOKEN || !process.env.TN_STORE_ID) {
    console.error('ERROR: Faltan TN_ACCESS_TOKEN y TN_STORE_ID en el .env');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  Migración masiva ML → TiendaNube');
  console.log('='.repeat(60));
  if (DRY_RUN)     console.log('  MODO: DRY RUN (no se crea nada en TN)');
  if (!ONLY_ACTIVE) console.log('  Incluyendo productos pausados (--all-status)');
  console.log(`  Delay entre requests: ${DELAY_MS}ms`);
  console.log('='.repeat(60));

  const db    = await getDb();
  const items = loadPendingItems(db);

  if (!items.length) {
    console.log('\nNo hay productos pendientes de migrar. Todo al día.');
    return;
  }

  console.log(`\nProductos pendientes: ${items.length}\n`);

  const stats = { ok: 0, error: 0, map_error: 0, dry: 0 };
  const errors = [];
  const startedAt = Date.now();

  for (let i = 0; i < items.length; i++) {
    const res = await uploadItem(db, items[i], i + 1, items.length);
    stats[res.status] = (stats[res.status] ?? 0) + 1;
    if (res.status === 'error' || res.status === 'map_error') {
      errors.push({ id: res.id, error: res.error });
    }

    // Rate limit: esperar entre requests (excepto en dry run)
    if (!DRY_RUN && i < items.length - 1) await sleep(DELAY_MS);
  }

  // ─── Resumen ─────────────────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
  const ss = String(elapsed % 60).padStart(2, '0');

  console.log('\n' + '='.repeat(60));
  console.log('  RESUMEN');
  console.log('='.repeat(60));
  if (DRY_RUN) {
    console.log(`  Simulados:    ${stats.dry ?? 0}`);
  } else {
    console.log(`  Subidos OK:   ${stats.ok ?? 0}`);
    console.log(`  Errores TN:   ${stats.error ?? 0}`);
    console.log(`  Errores map:  ${stats.map_error ?? 0}`);
  }
  console.log(`  Tiempo total: ${mm}:${ss}`);

  if (errors.length) {
    console.log('\nDetalle de errores:');
    errors.forEach((e) => console.log(`  ${e.id}: ${e.error}`));
  }
  console.log('='.repeat(60));
}

main().catch(console.error);
