/**
 * analyze-sku-mapping.js
 *
 * Cruza los datos de EcomExperts con SQLite para entender qué SKUs
 * tenemos disponibles y qué porcentaje de TN puede actualizarse.
 *
 * Lee:
 *   data/ecom-ml-listings-all.json  → MLA → productVariantId (ERP)
 *   data/ecom-variants.json         → variantId → sku + variantAttributes
 *   SQLite: tn_products             → ml_item_id → tn_product_id
 *   SQLite: ecom_ml_mapping         → ml_item_id → erp_sku (backup)
 *
 * Uso: node src/analyze-sku-mapping.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { getDb, rawQuery } = require('./db');

const DATA = path.join(__dirname, '..', 'data');

function loadJson(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) { console.error(`Falta: ${p}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

(async () => {
  await getDb();

  // ─── Cargar JSONs ───
  const mlListings = loadJson('ecom-ml-listings-all.json');
  const erpVariants = loadJson('ecom-variants.json');

  // ─── Mapas auxiliares ───

  // variantId → { sku, productId, productSku, productTitle, attrs }
  const variantMap = new Map();
  for (const v of erpVariants) {
    variantMap.set(String(v.id), {
      sku: v.sku ?? null,
      productId: String(v.product?.id ?? ''),
      productSku: v.product?.sku ?? null,
      productTitle: v.product?.title ?? '',
      attrs: (v.variantAttributes ?? []).map(a => `${a.name}:${a.options}`).join(' | '),
    });
  }

  // productId → Set de variant skus (para productos simples sin variantId)
  const productVariantSkus = new Map();
  for (const v of erpVariants) {
    const pid = String(v.product?.id ?? '');
    if (!productVariantSkus.has(pid)) productVariantSkus.set(pid, []);
    if (v.sku) productVariantSkus.get(pid).push({ variantId: String(v.id), sku: v.sku });
  }

  // SQLite: ml_item_id → tn_product_id
  const tnMap = new Map();
  for (const row of rawQuery(`SELECT ml_item_id, tn_product_id FROM tn_products`)) {
    tnMap.set(row.ml_item_id, row.tn_product_id);
  }

  // SQLite: ml_item_id → erp_sku (del Excel)
  const ecomSkuMap = new Map();
  for (const row of rawQuery(`SELECT ml_item_id, erp_sku FROM ecom_ml_mapping WHERE erp_sku IS NOT NULL`)) {
    ecomSkuMap.set(row.ml_item_id, row.erp_sku);
  }

  // ─── Análisis de variantes ERP ───
  const variantsWithSku = erpVariants.filter(v => v.sku).length;
  const variantsNullSku = erpVariants.filter(v => !v.sku).length;
  console.log('\n=== Variantes ERP ===');
  console.log(`  Total:         ${erpVariants.length}`);
  console.log(`  Con SKU:       ${variantsWithSku}`);
  console.log(`  Sin SKU:       ${variantsNullSku}`);

  // Muestra ejemplos con y sin SKU
  const withSku = erpVariants.filter(v => v.sku).slice(0, 3);
  const noSku   = erpVariants.filter(v => !v.sku).slice(0, 3);
  console.log('\n  Ejemplos CON SKU:');
  withSku.forEach(v => console.log(`    variant ${v.id} | SKU: ${v.sku} | product.sku: ${v.product?.sku} | ${v.product?.title}`));
  console.log('\n  Ejemplos SIN SKU (productSku?):');
  noSku.forEach(v => console.log(`    variant ${v.id} | SKU: null | product.sku: ${v.product?.sku} | ${v.product?.title} | attrs: ${(v.variantAttributes??[]).map(a=>`${a.name}:${a.options}`).join(', ')}`));

  // ─── Análisis de ML Listings ───
  console.log('\n=== ML Listings ===');
  console.log(`  Total listings:          ${mlListings.length}`);
  const withPL = mlListings.filter(l => l.productListings?.length > 0);
  const withVariantId = mlListings.filter(l => l.productListings?.some(pl => pl.productVariantId));
  const withNullVariant = mlListings.filter(l => l.productListings?.length > 0 && l.productListings.every(pl => !pl.productVariantId));
  console.log(`  Con productListings:     ${withPL.length}`);
  console.log(`  Con productVariantId:    ${withVariantId.length}`);
  console.log(`  Solo productId (simple): ${withNullVariant.length}`);

  // ─── Cruce: MLA → ERP SKU ───
  console.log('\n=== Cruce MLA → ERP SKU ===');

  let fromVariantSku = 0;
  let fromProductSku = 0;
  let fromExcelMapping = 0;
  let noSkuFound = 0;
  const noSkuExamples = [];

  // Para cada MLA con productListings, intentar resolver SKU
  const resolvedMap = new Map(); // mlaId → erpSku

  for (const listing of mlListings) {
    const mlaId = listing.ownerId;
    if (!mlaId) continue;

    // Buscar la mejor variant/product linking
    let resolvedSku = null;

    for (const pl of (listing.productListings ?? [])) {
      if (resolvedSku) break;
      const vid = pl.productVariantId ? String(pl.productVariantId) : null;
      const pid = pl.productId ? String(pl.productId) : null;

      if (vid) {
        const v = variantMap.get(vid);
        if (v?.sku) { resolvedSku = v.sku; fromVariantSku++; break; }
        if (v?.productSku) { resolvedSku = v.productSku; fromProductSku++; break; }
      }
      if (pid && !resolvedSku) {
        // Simple product: tomar primer variant con sku de ese producto
        const variants = productVariantSkus.get(pid) ?? [];
        if (variants.length === 1) { resolvedSku = variants[0].sku; fromProductSku++; break; }
        if (variants.length > 1) {
          // Múltiples variantes: no podemos determinar cuál sin más info
        }
      }
    }

    // Fallback: Excel mapping
    if (!resolvedSku && ecomSkuMap.has(mlaId)) {
      resolvedSku = ecomSkuMap.get(mlaId);
      fromExcelMapping++;
    }

    if (resolvedSku) {
      resolvedMap.set(mlaId, resolvedSku);
    } else {
      noSkuFound++;
      if (noSkuExamples.length < 5) noSkuExamples.push(listing);
    }
  }

  console.log(`  SKU desde variant.sku:   ${fromVariantSku}`);
  console.log(`  SKU desde product.sku:   ${fromProductSku}`);
  console.log(`  SKU desde Excel mapping: ${fromExcelMapping}`);
  console.log(`  Sin SKU resuelto:        ${noSkuFound}`);
  console.log(`  TOTAL resueltos:         ${resolvedMap.size} / ${mlListings.length}`);

  if (noSkuExamples.length) {
    console.log('\n  Ejemplos SIN SKU resuelto:');
    noSkuExamples.forEach(l => {
      const pls = l.productListings.map(pl => `(prod:${pl.productId} var:${pl.productVariantId})`).join(', ');
      console.log(`    MLA ${l.ownerId} → ${pls || '(sin productListings)'}`);
    });
  }

  // ─── TN products cubiertos ───
  console.log('\n=== Cobertura TN products ===');
  let tnCovered = 0;
  let tnNotCovered = 0;
  const tnNotCoveredEx = [];

  for (const [mlaId, tnProductId] of tnMap) {
    if (resolvedMap.has(mlaId)) {
      tnCovered++;
    } else {
      tnNotCovered++;
      if (tnNotCoveredEx.length < 5) tnNotCoveredEx.push({ mlaId, tnProductId });
    }
  }

  console.log(`  TN products con SKU ERP resuelto: ${tnCovered}`);
  console.log(`  TN products SIN SKU ERP:          ${tnNotCovered}`);
  if (tnNotCoveredEx.length) {
    console.log('  Ejemplos sin cubrir:');
    tnNotCoveredEx.forEach(({ mlaId, tnProductId }) => console.log(`    MLA ${mlaId} → TN ${tnProductId}`));
  }

  // ─── Guardar mapa resuelto ───
  const output = Array.from(resolvedMap.entries()).map(([mlaId, sku]) => ({
    mlaId,
    erpSku: sku,
    tnProductId: tnMap.get(mlaId) ?? null,
  }));
  const outPath = path.join(DATA, 'sku-mapping-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\n[saved] ${outPath}`);

})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
