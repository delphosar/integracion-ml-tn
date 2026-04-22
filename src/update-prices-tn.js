/**
 * update-prices-tn.js
 *
 * Actualiza precio regular y precio promocional en TiendaNube para todos los
 * productos que ya fueron migrados y tienen descuento activo en ML
 * (es decir, tienen original_price en la tabla ml_items).
 *
 * Uso:
 *   node src/update-prices-tn.js            → actualiza todos
 *   node src/update-prices-tn.js --dry-run  → solo muestra qué haría
 */

require('dotenv').config();
const { getDb } = require('./db');
const { getProduct, updateVariant } = require('./tn-api');

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const db = await getDb();

  // Traer todos los productos migrados que tienen descuento en ML
  const rows = db.exec(`
    SELECT
      i.id            AS ml_item_id,
      i.title,
      i.price         AS selling_price,
      i.original_price,
      t.tn_product_id
    FROM ml_items i
    JOIN tn_products t ON t.ml_item_id = i.id
    WHERE i.original_price IS NOT NULL
      AND i.original_price > i.price
      AND i.status = 'active'
    ORDER BY i.id
  `);

  if (!rows.length) {
    console.log('No hay productos con precio promocional en la base de datos.');
    return;
  }

  const [{ columns, values }] = rows;
  const col = (name) => columns.indexOf(name);

  console.log(`Productos con precio promocional: ${values.length}`);
  if (DRY_RUN) console.log('[DRY-RUN activado — no se harán cambios en TN]\n');

  let ok = 0;
  let errors = 0;

  for (const row of values) {
    const mlId    = row[col('ml_item_id')];
    const tnId    = row[col('tn_product_id')];
    const title   = row[col('title')];
    const selling = row[col('selling_price')];
    const original = row[col('original_price')];

    console.log(`\n[${mlId}] ${title.slice(0, 60)}`);
    console.log(`  TN ID: ${tnId} | precio regular: $${original} | promo: $${selling}`);

    if (DRY_RUN) {
      ok++;
      continue;
    }

    try {
      // Obtenemos las variantes actuales del producto en TN
      const product = await getProduct(tnId);

      let variantOk = 0;
      let variantErr = 0;

      for (const v of product.variants ?? []) {
        // Siempre derivar desde los datos de ML, ignorando el estado actual de TN.
        // Garantiza que TN quede con exactamente los mismos valores que ML,
        // sin importar si la variante ya tenía o no promotional_price seteado antes.
        const varOriginal = original;
        const varPromo    = selling;

        // Sanidad: no enviar si el promo termina >= al precio regular
        if (varPromo >= varOriginal) {
          console.log(`  ⚠ Variante ${v.id}: promo ($${varPromo}) >= regular ($${varOriginal}), se omite`);
          continue;
        }

        try {
          // Actualizar via PUT /products/{tnId}/variants/{variantId}
          await updateVariant(tnId, v.id, {
            price:             String(varOriginal),
            promotional_price: String(varPromo),
          });
          variantOk++;
        } catch (varErr) {
          const msg = varErr.response?.data ?? varErr.message;
          console.error(`  ✗ Variante ${v.id} error:`, JSON.stringify(msg));
          variantErr++;
        }

        await sleep(DELAY_MS);
      }

      console.log(`  ✓ Variantes: ${variantOk} OK, ${variantErr} errores`);
      if (variantErr === 0) ok++; else errors++;

    } catch (err) {
      const msg = err.response?.data ?? err.message;
      console.error(`  ✗ Error al obtener producto TN:`, JSON.stringify(msg));
      errors++;
    }
  }

  console.log(`\n===================================`);
  console.log(`Resultado: ${ok} productos OK, ${errors} con errores`);
  if (DRY_RUN) console.log('(DRY-RUN: no se realizaron cambios)');
}

main().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
