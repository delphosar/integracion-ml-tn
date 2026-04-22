/**
 * find-tn-orphans.js
 *
 * Lista los productos que existen en TiendaNube pero NO están en nuestra
 * tabla tn_products (es decir, no fueron creados por la migración).
 *
 * Uso:
 *   node src/find-tn-orphans.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios  = require('axios');
const { getDb } = require('./db');

const BASE_URL   = 'https://api.tiendanube.com/v1';
const PER_PAGE   = 200;
const DELAY_MS   = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getHeaders() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'User-Agent':   process.env.TN_USER_AGENT ?? 'ML-TN-Sync (dev)',
  };
}

const storeId = () => process.env.TN_STORE_ID;

async function fetchAllTnProducts() {
  const all = [];
  let page  = 1;

  while (true) {
    process.stdout.write(`\r  Obteniendo página ${page}... (${all.length} hasta ahora)`);
    const { data } = await axios.get(`${BASE_URL}/${storeId()}/products`, {
      headers: getHeaders(),
      params:  { page, per_page: PER_PAGE, fields: 'id,name,created_at,variants' },
    });

    if (!data?.length) break;
    all.push(...data);
    if (data.length < PER_PAGE) break;

    page++;
    await sleep(DELAY_MS);
  }

  console.log();
  return all;
}

function getKnownTnIds(db) {
  const result = db.exec(`SELECT tn_product_id FROM tn_products`);
  if (!result[0]?.values?.length) return new Set();
  return new Set(result[0].values.map(([id]) => String(id)));
}

async function main() {
  if (!process.env.TN_ACCESS_TOKEN || !process.env.TN_STORE_ID) {
    console.error('ERROR: Faltan TN_ACCESS_TOKEN y TN_STORE_ID en el .env');
    process.exit(1);
  }

  console.log('\n=== Buscando productos huérfanos en TiendaNube ===\n');

  const db      = await getDb();
  const known   = getKnownTnIds(db);

  console.log(`Productos conocidos en nuestra DB: ${known.size}`);
  console.log('Obteniendo todos los productos de TN...');

  const tnProducts = await fetchAllTnProducts();
  console.log(`Total productos en TN: ${tnProducts.length}`);

  const orphans = tnProducts.filter((p) => !known.has(String(p.id)));

  console.log(`\nHuérfanos (en TN pero no en nuestra DB): ${orphans.length}`);

  if (!orphans.length) {
    console.log('No hay huérfanos. Todo coincide.');
    return;
  }

  console.log('\n' + '─'.repeat(80));
  console.log(`${'TN ID'.padEnd(12)} ${'Creado'.padEnd(22)} ${'SKUs'.padEnd(30)} Nombre`);
  console.log('─'.repeat(80));

  for (const p of orphans) {
    const skus = (p.variants ?? []).map((v) => v.sku).filter(Boolean).join(', ') || '(sin sku)';
    const name = (p.name?.es ?? p.name ?? '').slice(0, 40);
    const created = (p.created_at ?? '').slice(0, 19).replace('T', ' ');
    console.log(`${String(p.id).padEnd(12)} ${created.padEnd(22)} ${skus.slice(0, 30).padEnd(30)} ${name}`);
  }

  console.log('─'.repeat(80));
  console.log(`\nTotal: ${orphans.length} productos huérfanos`);
  console.log('\nPara eliminarlos, entrá al admin de TN y buscalos por ID o nombre.');
}

main().catch((err) => {
  console.error('\nError inesperado:', err.message);
  process.exit(1);
});
