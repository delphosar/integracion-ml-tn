/**
 * fetch-ml-categories.js
 *
 * Lee los category_id distintos de ml_items, consulta la API de ML para
 * obtener nombre y ruta completa de cada uno, y los guarda en la tabla
 * ml_categories de la DB local.
 *
 * Uso:
 *   npm run fetch-categories
 *   npm run fetch-categories -- --force   (re-fetcha incluso los ya guardados)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const {
  getDb,
  saveToFile,
  saveMlCategory,
  getDistinctCategoryIds,
  getExistingCategoryIds,
  getAllCategories,
} = require('./db');

const BASE_URL   = 'https://api.mercadolibre.com';
const DELAY_MS   = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const FORCE      = process.argv.includes('--force');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getHeaders() {
  return { Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}` };
}

async function fetchCategory(categoryId) {
  const { data } = await axios.get(`${BASE_URL}/categories/${categoryId}`, {
    headers: getHeaders(),
  });

  // Construir ruta legible: "Hogar y Muebles > Decoración > Alfombras"
  const full_path = (data.path_from_root ?? [])
    .map((n) => n.name)
    .join(' > ');

  return {
    id:        data.id,
    name:      data.name,
    full_path: full_path || data.name,
  };
}

async function main() {
  if (!process.env.ML_ACCESS_TOKEN) {
    console.error('ERROR: Falta ML_ACCESS_TOKEN en el .env');
    process.exit(1);
  }

  await getDb();

  const allCats    = getDistinctCategoryIds();   // [{ id, count }]
  const existing   = FORCE ? new Set() : getExistingCategoryIds();
  const pending    = allCats.filter((c) => !existing.has(c.id));

  console.log(`\n=== Fetch ML Categories ===`);
  console.log(`Categorías distintas en DB:  ${allCats.length}`);
  console.log(`Ya guardadas:                ${existing.size}`);
  console.log(`Por fetchear:                ${pending.length}`);
  if (FORCE && allCats.length > 0) console.log('  (modo --force: re-fetchea todas)');
  console.log('');

  if (pending.length === 0) {
    console.log('Nada que hacer. Usá --force para refrescar.');
    printTable();
    return;
  }

  let ok = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i++) {
    const { id, count } = pending[i];
    process.stdout.write(`\r  [${i + 1}/${pending.length}] ${id} (${count} prods)...`);

    try {
      const cat = await fetchCategory(id);
      saveMlCategory(cat);
      process.stdout.write(`  → "${cat.full_path}"\n`);
      ok++;
    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.message ?? err.message;
      process.stdout.write(`  ✗ Error HTTP ${status ?? '?'}: ${msg}\n`);
      errors++;
    }

    if (i < pending.length - 1) await sleep(DELAY_MS);
  }

  saveToFile();

  console.log(`\n=== Resultado ===`);
  console.log(`  OK:     ${ok}`);
  console.log(`  Errors: ${errors}`);
  console.log('');
  printTable();
}

function printTable() {
  const cats = getAllCategories();
  if (!cats.length) return;

  console.log('Categorías en DB local:');
  console.log('─'.repeat(80));

  // Obtener conteos desde la DB para el resumen
  const { getDb: _getDb, getDistinctCategoryIds: getCats } = require('./db');
  const counts = Object.fromEntries(getCats().map(({ id, count }) => [id, count]));

  for (const { id, name, full_path } of cats) {
    const n = counts[id] ?? '?';
    const path = full_path !== name ? full_path : name;
    console.log(`  ${id.padEnd(12)} ${String(n).padStart(4)} prods  ${path}`);
  }
  console.log('─'.repeat(80));
  console.log(`  Total: ${cats.length} categorías`);
}

main().catch((err) => {
  console.error('\nError inesperado:', err.message);
  process.exit(1);
});
