/**
 * diagnose-sku.js
 * Diagnóstico del estado de SKUs en TN vs EcomExperts.
 * Objetivo: evaluar qué hace falta para habilitar la integración EcomExperts ↔ TN.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getDb } = require('./db');

async function main() {
  const db = await getDb();

  // ── 1. Totales generales ───────────────────────────────────────────────────
  const [[totalTn]]    = db.exec(`SELECT COUNT(*) FROM tn_products`)[0].values;
  const [[totalItems]] = db.exec(`SELECT COUNT(*) FROM ml_items WHERE status = 'active'`)[0].values;
  const [[totalMapping]] = db.exec(`SELECT COUNT(*) FROM ecom_ml_mapping`)[0].values;

  console.log('='.repeat(70));
  console.log('  DIAGNÓSTICO SKUs: TN vs EcomExperts');
  console.log('='.repeat(70));
  console.log(`  Items ML activos:     ${totalItems}`);
  console.log(`  Productos en TN:      ${totalTn}`);
  console.log(`  Filas ecom_ml_mapping:${totalMapping}`);
  console.log('');

  // ── 2. Productos SIN variaciones: SKU en TN = MLA code (incorrecto) ────────
  // Son los que en migrate se les puso sku = item.id
  // Identificamos: items en tn_products que NO tienen variaciones en ml_variations
  const simpleRes = db.exec(`
    SELECT
      tp.ml_item_id,
      tp.tn_product_id,
      m.erp_sku,
      m.is_combo,
      i.title
    FROM tn_products tp
    JOIN ml_items i ON i.id = tp.ml_item_id
    LEFT JOIN ecom_ml_mapping m ON m.ml_item_id = tp.ml_item_id
    WHERE tp.ml_item_id NOT IN (SELECT DISTINCT item_id FROM ml_variations)
    ORDER BY tp.ml_item_id
  `);
  const simpleItems = simpleRes[0]?.values ?? [];

  const simpleWithErp    = simpleItems.filter(r => r[2] !== null);
  const simpleWithoutErp = simpleItems.filter(r => r[2] === null);
  const simpleCombo      = simpleItems.filter(r => r[3] === 1);

  console.log('─'.repeat(70));
  console.log(`  PRODUCTOS SIMPLES (sin variaciones): ${simpleItems.length}`);
  console.log(`    → con ERP SKU mapeado:   ${simpleWithErp.length}`);
  console.log(`    → sin ERP SKU (sin mapeo):${simpleWithoutErp.length}`);
  console.log(`    → combos:                 ${simpleCombo.length}`);
  console.log(`    SKU actual en TN = MLA code (INCORRECTO para integración EcomExperts)`);
  console.log('');

  // ── 3. Productos CON variaciones: revisar seller_custom_field ─────────────
  const varRes = db.exec(`
    SELECT
      tp.ml_item_id,
      tp.tn_product_id,
      COUNT(v.id)                                          AS total_vars,
      SUM(CASE WHEN v.seller_custom_field IS NOT NULL AND v.seller_custom_field != '' THEN 1 ELSE 0 END) AS vars_con_sku,
      SUM(CASE WHEN v.seller_custom_field IS NULL OR v.seller_custom_field = '' THEN 1 ELSE 0 END)       AS vars_sin_sku,
      m.erp_sku,
      m.is_combo
    FROM tn_products tp
    JOIN ml_items i ON i.id = tp.ml_item_id
    JOIN ml_variations v ON v.item_id = tp.ml_item_id
    LEFT JOIN ecom_ml_mapping m ON m.ml_item_id = tp.ml_item_id
    GROUP BY tp.ml_item_id
    ORDER BY vars_sin_sku DESC, tp.ml_item_id
  `);
  const varItems = varRes[0]?.values ?? [];

  const varOk      = varItems.filter(r => r[4] === 0);  // todas las vars tienen SKU
  const varPartial = varItems.filter(r => r[4] > 0 && r[3] > 0);  // algunas sí, algunas no
  const varNone    = varItems.filter(r => r[3] === 0);  // ninguna var tiene SKU

  console.log('─'.repeat(70));
  console.log(`  PRODUCTOS CON VARIACIONES: ${varItems.length}`);
  console.log(`    → todas las vars tienen seller_custom_field: ${varOk.length}   ✓`);
  console.log(`    → algunas vars con SKU, otras sin:           ${varPartial.length}   ⚠`);
  console.log(`    → ninguna variación tiene SKU:               ${varNone.length}   ✗`);
  console.log('');

  if (varNone.length) {
    console.log('  Productos sin ningún seller_custom_field (muestra, max 10):');
    varNone.slice(0, 10).forEach(r => {
      console.log(`    ${r[0]} → TN ${r[1]} | vars: ${r[2]} | erp_sku: ${r[5] ?? 'sin mapeo'} | "${r[6] ?? ''}" `);
    });
    console.log('');
  }

  // ── 4. Duplicados por ERP SKU ──────────────────────────────────────────────
  // Cuántos ERP SKUs tienen más de 1 producto en TN
  const dupeRes = db.exec(`
    SELECT
      m.erp_sku,
      COUNT(tp.ml_item_id) AS qty,
      GROUP_CONCAT(tp.ml_item_id, ', ') AS ml_ids,
      GROUP_CONCAT(tp.tn_product_id, ', ') AS tn_ids,
      m.is_combo
    FROM ecom_ml_mapping m
    JOIN tn_products tp ON tp.ml_item_id = m.ml_item_id
    WHERE m.erp_sku IS NOT NULL AND m.erp_sku != ''
    GROUP BY m.erp_sku
    HAVING COUNT(tp.ml_item_id) > 1
    ORDER BY qty DESC, m.erp_sku
  `);
  const dupes = dupeRes[0]?.values ?? [];

  const totalDupeSkus     = dupes.length;
  const totalExtraTnProds = dupes.reduce((acc, r) => acc + (r[1] - 1), 0);

  console.log('─'.repeat(70));
  console.log(`  DUPLICADOS EN TN (mismo ERP SKU → múltiples TN products):`);
  console.log(`    → ERP SKUs con más de 1 producto TN: ${totalDupeSkus}`);
  console.log(`    → Productos TN "extra" a eliminar:   ${totalExtraTnProds}`);
  console.log('');

  if (dupes.length) {
    console.log('  Detalle duplicados (muestra, max 15):');
    dupes.slice(0, 15).forEach(r => {
      const [erp_sku, qty, ml_ids, tn_ids, is_combo] = r;
      console.log(`    SKU ${erp_sku}${is_combo ? ' (combo)' : ''} → ${qty}x → TN: [${tn_ids}]`);
      console.log(`         ML: [${ml_ids}]`);
    });
    console.log('');
  }

  // ── 5. SKUs únicos OK: 1 TN product por ERP SKU ───────────────────────────
  const uniqueRes = db.exec(`
    SELECT COUNT(DISTINCT m.erp_sku)
    FROM ecom_ml_mapping m
    JOIN tn_products tp ON tp.ml_item_id = m.ml_item_id
    WHERE m.erp_sku IS NOT NULL AND m.erp_sku != ''
    GROUP BY m.erp_sku
    HAVING COUNT(tp.ml_item_id) = 1
  `);
  const uniqueSkus = uniqueRes[0]?.values?.length ?? 0;

  // ── 6. ERP SKUs sin producto en TN ────────────────────────────────────────
  const noTnRes = db.exec(`
    SELECT m.erp_sku, m.ml_item_id, m.titulo_articulo
    FROM ecom_ml_mapping m
    WHERE m.erp_sku IS NOT NULL
      AND m.ml_item_id NOT IN (SELECT ml_item_id FROM tn_products)
    ORDER BY m.erp_sku
  `);
  const noTn = noTnRes[0]?.values ?? [];

  console.log('─'.repeat(70));
  console.log(`  ERP SKUs con exactamente 1 producto TN (ya OK): ${uniqueSkus}`);
  console.log(`  ERP SKUs sin ningún producto en TN:              ${noTn.length}`);
  console.log('');

  // ── 7. Resumen ejecutivo ───────────────────────────────────────────────────
  console.log('='.repeat(70));
  console.log('  RESUMEN — LO QUE HAY QUE RESOLVER');
  console.log('='.repeat(70));
  console.log(`  1. Actualizar SKU de ${simpleWithErp.length} productos simples (cambiar MLA → ERP SKU)`);
  if (simpleWithoutErp.length)
    console.log(`     ⚠  ${simpleWithoutErp.length} productos simples SIN mapeo en ecom_ml_mapping (quedarían sin SKU)`);
  if (varNone.length)
    console.log(`  2. ${varNone.length} productos con variaciones sin seller_custom_field → SKU es fallback MLA-varId`);
  console.log(`  3. Eliminar ${totalExtraTnProds} productos TN duplicados (${totalDupeSkus} SKUs afectados)`);
  console.log('='.repeat(70));
}

main().catch(console.error);
