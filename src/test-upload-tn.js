require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const readline        = require('readline');
const { getDb, getErpMapping, saveTnProduct } = require('./db');
const { mapMlItemToTn }        = require('./ml-to-tn-mapper');
const { createProduct } = require('./tn-api');

function confirm(question) {
  // Si stdin no es TTY (pipe/redireccionado), auto-confirmar
  if (!process.stdin.isTTY) {
    console.log(`${question} (s/n): s [auto]`);
    return Promise.resolve(true);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} (s/n): `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 's');
    });
  });
}

async function getItemFromDb(db, withVariations) {
  const query = withVariations
    ? `SELECT i.raw_json, i.description
       FROM ml_items i
       JOIN ml_variations v ON v.item_id = i.id
       WHERE i.status = 'active'
       GROUP BY i.id
       LIMIT 1`
    : `SELECT i.raw_json, i.description
       FROM ml_items i
       WHERE i.status = 'active'
       AND i.id NOT IN (SELECT DISTINCT item_id FROM ml_variations)
       LIMIT 1`;

  const result = db.exec(query);
  if (!result[0]?.values?.length) return null;

  const cols = result[0].columns;
  const row  = result[0].values[0];
  const item = Object.fromEntries(cols.map((c, i) => [c, row[i]]));

  const full = JSON.parse(item.raw_json);
  full.description = item.description;
  return full;
}

async function testProduct(db, label, withVariations) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Producto ${label}`);
  console.log('='.repeat(50));

  const item = await getItemFromDb(db, withVariations);
  if (!item) {
    console.log(`No se encontró ningún producto activo ${withVariations ? 'con' : 'sin'} variaciones.`);
    return;
  }

  console.log(`ML ID:  ${item.id}`);
  console.log(`Título: ${item.title}`);
  console.log(`Precio: $${item.price}`);
  console.log(`Stock:  ${item.available_quantity}`);
  if (withVariations) {
    console.log(`Variaciones: ${item.variations?.length}`);
    item.variations?.forEach(v => {
      const label = v.attribute_combinations?.map(c => `${c.name}: ${c.value_name}`).join(' | ');
      console.log(`  - ${label} | stock: ${v.available_quantity} | precio: $${v.price}`);
    });
  }
  console.log(`Imágenes: ${item.pictures?.length ?? 0}`);

  const payload = mapMlItemToTn(item);
  console.log('\nPayload que se enviará a TN:');
  console.log(JSON.stringify(payload, null, 2));

  const ok = await confirm('\n¿Subir este producto a TiendaNube?');
  if (!ok) {
    console.log('Saltado.');
    return;
  }

  try {
    const result = await createProduct(payload);
    console.log(`\n✓ Creado en TN — ID: ${result.id}`);
    console.log(`  Admin: https://integraldeco5.mitiendanube.com/admin/products/${result.id}`);

    // Guardar mapeo ml_item_id → tn_product_id en SQLite
    saveTnProduct(item.id, String(result.id));
    console.log(`  Guardado en DB: ${item.id} → TN ${result.id}`);

    const mapping = getErpMapping(item.id);
    if (mapping) {
      console.log(`  erp_sku:  ${mapping.erp_sku}`);
      console.log(`  is_combo: ${mapping.is_combo ? 'true' : 'false'}`);
    } else {
      console.log(`  (sin mapeo ERP para ${item.id})`);
    }
  } catch (err) {
    const msg = err.response?.data ?? err.message;
    console.error('Error:', JSON.stringify(msg, null, 2));
  }
}

async function main() {
  if (!process.env.TN_ACCESS_TOKEN || !process.env.TN_STORE_ID) {
    console.error('ERROR: Faltan TN_ACCESS_TOKEN y TN_STORE_ID en el .env');
    process.exit(1);
  }

  const db = await getDb();

  await testProduct(db, 'SIMPLE (sin variaciones)', false);
  await testProduct(db, 'CON VARIACIONES',          true);
}

main().catch(console.error);
