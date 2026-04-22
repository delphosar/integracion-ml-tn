/**
 * Inspecciona la estructura de precios de variaciones en items que tienen descuento.
 * Uso: node src/inspect-variation-prices.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('./db');

async function main() {
  const db = await getDb();

  // Buscar items con original_price Y variaciones
  const result = db.exec(`
    SELECT i.id, i.price, i.original_price, i.title, i.raw_json
    FROM   ml_items i
    WHERE  i.original_price IS NOT NULL
      AND  i.original_price > i.price
      AND  i.id IN (SELECT DISTINCT item_id FROM ml_variations)
    ORDER  BY i.id
    LIMIT  5
  `);

  if (!result[0]?.values?.length) {
    console.log('No se encontraron items con original_price y variaciones.');
    return;
  }

  for (const [id, price, original_price, title, raw_json] of result[0].values) {
    console.log('\n' + '='.repeat(70));
    console.log(`${id} — ${title?.slice(0, 60)}`);
    console.log(`  item.price: ${price}  |  item.original_price: ${original_price}`);
    console.log('  Variaciones:');

    const item = JSON.parse(raw_json);
    for (const v of item.variations ?? []) {
      console.log(`    var ${v.id}:`);
      console.log(`      price:          ${v.price}`);
      console.log(`      original_price: ${v.original_price ?? '(no existe)'}`);
      console.log(`      sale_terms:     ${JSON.stringify(v.sale_terms ?? [])}`);
      console.log(`      price === item.price: ${v.price === price}`);
    }
  }
}

main().catch(console.error);
