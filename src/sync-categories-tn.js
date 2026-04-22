/**
 * sync-categories-tn.js
 *
 * FASE 1: Lee ml_categories locales, crea en TN las que no existen,
 *         guarda el mapeo ml_category_id → tn_category_id en tn_categories.
 *
 * FASE 2: Actualiza los 1239 productos ya subidos en TN asignándoles
 *         la categoría correspondiente.
 *
 * Uso:
 *   npm run sync-categories           → ejecuta fase 1 y 2
 *   npm run sync-categories -- --phase1   → solo crea categorías en TN
 *   npm run sync-categories -- --phase2   → solo asigna categorías a productos
 *   npm run sync-categories -- --force    → re-asigna incluso productos ya sincronizados
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  getDb, saveToFile,
  getAllCategories,
  saveTnCategory, getTnCategoryByMlId, getExistingTnCategoryMlIds,
  getProductsForCategoryUpdate, markProductSynced,
} = require('./db');
const { getCategories, createCategory, updateProductCategories } = require('./tn-api');

const DELAY_MS = parseInt(process.env.TN_REQUEST_DELAY_MS ?? '1000', 10);
const FORCE    = process.argv.includes('--force');
const ONLY_P1  = process.argv.includes('--phase1');
const ONLY_P2  = process.argv.includes('--phase2');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── FASE 1: Crear categorías en TN ─────────────────────────────────────────

async function phase1() {
  console.log('\n── FASE 1: Crear categorías en TiendaNube ──────────────────────');

  const mlCats     = getAllCategories();               // [{ id, name, full_path }]
  const alreadyMapped = getExistingTnCategoryMlIds(); // Set de ml_category_id ya mapeados

  const pending = mlCats.filter((c) => !alreadyMapped.has(c.id));

  console.log(`Categorías ML locales:   ${mlCats.length}`);
  console.log(`Ya mapeadas a TN:        ${alreadyMapped.size}`);
  console.log(`Por crear/verificar:     ${pending.length}`);

  if (pending.length === 0) {
    console.log('Nada que hacer en fase 1.');
    return;
  }

  // Obtener categorías existentes en TN para evitar duplicados
  console.log('\nObteniendo categorías existentes en TN...');
  let tnExisting = [];
  try {
    tnExisting = await getCategories();
  } catch (err) {
    console.error('Error al obtener categorías de TN:', err.response?.data ?? err.message);
    process.exit(1);
  }

  // Índice por nombre (lowercase) → tn_category_id
  const tnByName = {};
  for (const cat of tnExisting) {
    const nameEs = cat.name?.es ?? cat.name ?? '';
    tnByName[nameEs.toLowerCase()] = String(cat.id);
  }
  console.log(`Categorías existentes en TN: ${tnExisting.length}`);

  let created = 0;
  let reused  = 0;
  let errors  = 0;

  for (let i = 0; i < pending.length; i++) {
    const { id: mlId, name } = pending[i];
    process.stdout.write(`  [${i + 1}/${pending.length}] ${mlId} "${name}"...`);

    // ¿Ya existe en TN con ese nombre?
    const existingTnId = tnByName[name.toLowerCase()];
    if (existingTnId) {
      saveTnCategory(mlId, existingTnId, name);
      process.stdout.write(` reutilizada (TN ${existingTnId})\n`);
      reused++;
      continue;
    }

    // Crear en TN
    try {
      const result = await createCategory(name);
      const tnId = String(result.id);
      saveTnCategory(mlId, tnId, name);
      tnByName[name.toLowerCase()] = tnId; // actualizar índice local
      process.stdout.write(` creada (TN ${tnId})\n`);
      created++;
      await sleep(DELAY_MS);
    } catch (err) {
      const msg = err.response?.data ?? err.message;
      process.stdout.write(` ✗ ${JSON.stringify(msg)}\n`);
      errors++;
    }
  }

  saveToFile();
  console.log(`\nFase 1 completada — Creadas: ${created} | Reutilizadas: ${reused} | Errores: ${errors}`);
}

// ─── FASE 2: Asignar categorías a productos en TN ────────────────────────────

async function phase2() {
  console.log('\n── FASE 2: Asignar categorías a productos en TN ────────────────');

  const products = getProductsForCategoryUpdate(FORCE);
  console.log(`Productos a actualizar: ${products.length}${FORCE ? ' (--force: todos)' : ' (sin categoría asignada aún)'}`);

  if (products.length === 0) {
    console.log('Nada que hacer en fase 2. Usá --force para reasignar todos.');
    return;
  }

  let ok = 0, skipped = 0, errors = 0;
  const errList = [];

  for (let i = 0; i < products.length; i++) {
    const { ml_item_id, tn_product_id, category_id } = products[i];
    const prefix = `  [${String(i + 1).padStart(String(products.length).length)}/${products.length}]`;

    // Buscar el tn_category_id correspondiente
    const mapped = getTnCategoryByMlId(category_id);
    if (!mapped) {
      process.stdout.write(`${prefix} ⚠ ${ml_item_id} — categoría ${category_id} no mapeada, se saltea\n`);
      skipped++;
      continue;
    }

    try {
      await updateProductCategories(tn_product_id, [mapped.tn_category_id]);
      markProductSynced(ml_item_id);
      process.stdout.write(`${prefix} ✓ TN ${tn_product_id} → cat "${mapped.name}" (${mapped.tn_category_id})\n`);
      ok++;
    } catch (err) {
      const msg = err.response?.data ?? err.message;
      const detail = typeof msg === 'object' ? JSON.stringify(msg) : msg;
      process.stdout.write(`${prefix} ✗ TN ${tn_product_id} — ${detail}\n`);
      errors++;
      errList.push({ ml_item_id, tn_product_id, error: detail });
    }

    if (i < products.length - 1) await sleep(DELAY_MS);

    // Guardar en disco cada 50 productos
    if ((i + 1) % 50 === 0) saveToFile();
  }

  saveToFile();
  console.log(`\nFase 2 completada — OK: ${ok} | Salteados: ${skipped} | Errores: ${errors}`);
  if (errList.length) {
    console.log('\nDetalle de errores:');
    errList.forEach(({ ml_item_id, tn_product_id, error }) =>
      console.log(`  ${ml_item_id} (TN ${tn_product_id}): ${error}`)
    );
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.TN_ACCESS_TOKEN || !process.env.TN_STORE_ID) {
    console.error('ERROR: Faltan TN_ACCESS_TOKEN y TN_STORE_ID en el .env');
    process.exit(1);
  }

  console.log('='.repeat(60));
  console.log('  Sync Categorías ML → TiendaNube');
  console.log('='.repeat(60));
  if (FORCE) console.log('  MODO: --force (reasigna todos los productos)');
  console.log(`  Delay entre requests: ${DELAY_MS}ms`);

  await getDb();

  if (!ONLY_P2) await phase1();
  if (!ONLY_P1) await phase2();

  console.log('\n' + '='.repeat(60));
  console.log('  Listo!');
  console.log('='.repeat(60));
}

main().catch((err) => {
  console.error('\nError inesperado:', err.message);
  process.exit(1);
});
