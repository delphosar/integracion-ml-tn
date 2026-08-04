/**
 * fix-skus-not-simple.js
 *
 * Para los productos TN con SKU formato "MLA{itemId}-{varId}" (multi-variante
 * sin DB), consulta EcomExperts para obtener el SKU ERP de cada variante ML
 * y actualiza las variantes de TN con el SKU correcto.
 *
 * Input:  data/fix-skus-nodb-results.json  (entradas con status: 'not-simple')
 * Output: data/fix-skus-not-simple-results.json
 *
 * Uso:
 *   node src/fix-skus-not-simple.js [--dry-run] [--limit=N] [--resume]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const { graphql } = require('./ecom-api');
const tnApi = require('./tn-api');

const DRY_RUN  = process.argv.includes('--dry-run');
const RESUME   = process.argv.includes('--resume');
const LIMIT    = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0', 10) || null;
const DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '400', 10);

const NODB_RESULTS_PATH   = path.join(__dirname, '..', 'data', 'fix-skus-nodb-results.json');
const RESULTS_PATH        = path.join(__dirname, '..', 'data', 'fix-skus-not-simple-results.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Patrón de SKU: MLA{itemId}-{varId}
const SKU_VAR_RE = /^(MLA\d+)-(\d+)$/;

/**
 * Consulta EcomExperts por el ML item ID y devuelve un mapa:
 *   mlVarId (string) → erpVariantSku (string)
 *
 * Usa productListings[].productVariantListings[].ownerId → .variant.sku
 */
async function getVarSkuMap(mlItemId) {
  const result = await graphql(`{
    mlListings {
      find(page: 1, searchTerm: { value: "${mlItemId}" }) {
        data {
          id
          ownerId
          productListings {
            id
            productVariantListings {
              id
              ownerId
              variant {
                id
                sku
              }
            }
          }
        }
      }
    }
  }`);

  const items = result?.mlListings?.find?.data ?? [];
  const map = {};

  for (const item of items) {
    if (item.ownerId !== mlItemId) continue;
    for (const pl of item.productListings ?? []) {
      for (const pvl of pl.productVariantListings ?? []) {
        if (pvl.ownerId && pvl.variant?.sku) {
          map[String(pvl.ownerId)] = pvl.variant.sku;
        }
      }
    }
  }

  return map;
}

async function main() {
  console.log(`[fix-skus-not-simple] Iniciando${DRY_RUN ? ' (DRY RUN)' : ''}${RESUME ? ' (RESUME)' : ''}${LIMIT ? ` (limit ${LIMIT})` : ''}...`);
  const started = Date.now();

  // --- Leer not-simple entries del resultado previo ---
  if (!fs.existsSync(NODB_RESULTS_PATH)) {
    console.error(`No se encontró: ${NODB_RESULTS_PATH}`);
    process.exit(1);
  }

  const nodbResults = JSON.parse(fs.readFileSync(NODB_RESULTS_PATH, 'utf8'));
  const notSimpleEntries = nodbResults.filter(r => r.status === 'not-simple');

  // Deduplicar por tnId (hay duplicados en el archivo)
  const seen = new Set();
  const targets = [];
  for (const entry of notSimpleEntries) {
    if (seen.has(entry.tnId)) continue;
    seen.add(entry.tnId);

    // Verificar que tiene SKUs con formato MLA{id}-{varId}
    const hasVarSku = (entry.skus ?? []).some(s => SKU_VAR_RE.test(s));
    if (!hasVarSku) {
      console.log(`  Saltando TN ${entry.tnId} (sin SKU MLA{id}-{varId}): ${JSON.stringify(entry.skus)}`);
      continue;
    }

    targets.push(entry);
  }

  console.log(`  ${notSimpleEntries.length} not-simple en nodb-results → ${targets.length} únicos con sufijo ML`);

  // --- Resume ---
  const SKIP_STATUSES = new Set(['updated', 'no-var-listings', 'error']);
  const prevResults = RESUME && fs.existsSync(RESULTS_PATH)
    ? JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'))
    : [];
  const doneIds = new Set(
    prevResults
      .filter(r => SKIP_STATUSES.has(r.status))
      .map(r => r.tnId)
  );

  let work = RESUME ? targets.filter(t => !doneIds.has(t.tnId)) : targets;
  if (RESUME) console.log(`  Resume: ${doneIds.size} saltados, quedan ${work.length}`);
  if (LIMIT) work = work.slice(0, LIMIT);

  console.log(`  ${work.length} a procesar\n`);

  const results = RESUME ? [...prevResults.filter(r => SKIP_STATUSES.has(r.status))] : [];
  const stats = { updated: 0, noVarListings: 0, partialNoSku: 0, errors: 0 };

  for (let i = 0; i < work.length; i++) {
    const { tnId, titulo } = work[i];
    const label = `[${i + 1}/${work.length}] TN ${tnId}`;

    // 1. Obtener producto TN
    let tnProduct;
    try {
      tnProduct = await tnApi.getProduct(tnId);
      await sleep(DELAY_MS);
    } catch (err) {
      if (err.response?.status === 404) {
        console.log(`  ${label}: 404 not found`);
        results.push({ tnId, status: 'not-found' });
        continue;
      }
      console.error(`  ${label}: Error TN → ${err.message}`);
      stats.errors++;
      results.push({ tnId, status: 'error', error: err.message });
      continue;
    }

    const variants = tnProduct.variants ?? [];

    // 2. Extraer ML item ID único de los SKUs
    const mlItemIds = new Set();
    for (const v of variants) {
      const m = SKU_VAR_RE.exec(v.sku);
      if (m) mlItemIds.add(m[1]);
    }

    if (mlItemIds.size === 0) {
      console.log(`  ${label}: No hay variantes con SKU MLA{id}-{varId} (ya fixed?)`);
      results.push({ tnId, titulo, status: 'already-ok' });
      continue;
    }

    // 3. Consultar EcomExperts para cada ML item ID y construir mapa varId→erpSku
    const varSkuMap = {};
    for (const mlItemId of mlItemIds) {
      let map;
      try {
        map = await getVarSkuMap(mlItemId);
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`  ${label}: Error EcomExperts para ${mlItemId} → ${err.message}`);
        stats.errors++;
        results.push({ tnId, mlItemId, status: 'error', error: err.message });
        continue;
      }

      if (Object.keys(map).length === 0) {
        console.log(`  ${label}: ${mlItemId} → sin productVariantListings en EcomExperts`);
        stats.noVarListings++;
        results.push({ tnId, titulo, mlItemId, status: 'no-var-listings' });
        continue;
      }

      Object.assign(varSkuMap, map);
      console.log(`  ${label}: ${mlItemId} → ${Object.keys(map).length} variantListings`);
    }

    if (Object.keys(varSkuMap).length === 0) continue;

    // 4. Actualizar cada variante TN con el ERP SKU correspondiente
    let updatedCount = 0;
    let noSkuCount = 0;
    const variantResults = [];

    for (const variant of variants) {
      const m = SKU_VAR_RE.exec(variant.sku);
      if (!m) {
        variantResults.push({ varId: variant.id, sku: variant.sku, action: 'skip-no-match' });
        continue;
      }

      const mlVarId = m[2];
      const erpSku = varSkuMap[mlVarId];

      if (!erpSku) {
        console.log(`    Variante ${variant.id} (SKU ${variant.sku}): varId ${mlVarId} no encontrado en map`);
        noSkuCount++;
        variantResults.push({ varId: variant.id, sku: variant.sku, mlVarId, action: 'no-erp-sku' });
        continue;
      }

      if (DRY_RUN) {
        console.log(`    [DRY] Variante ${variant.id}: ${variant.sku} → "${erpSku}"`);
        updatedCount++;
        variantResults.push({ varId: variant.id, oldSku: variant.sku, newSku: erpSku, action: 'dry-run' });
        continue;
      }

      try {
        await tnApi.updateVariant(tnId, variant.id, { sku: erpSku });
        await sleep(DELAY_MS);
        console.log(`    Variante ${variant.id}: ${variant.sku} → "${erpSku}" ✓`);
        updatedCount++;
        variantResults.push({ varId: variant.id, oldSku: variant.sku, newSku: erpSku, action: 'updated' });
      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error(`    Error variante ${variant.id}: ${detail}`);
        stats.errors++;
        variantResults.push({ varId: variant.id, sku: variant.sku, action: 'error', error: detail });
      }
    }

    if (noSkuCount > 0) stats.partialNoSku++;

    const status = updatedCount > 0 ? 'updated' : (noSkuCount > 0 ? 'no-erp-sku' : 'no-action');
    if (updatedCount > 0) stats.updated++;

    results.push({
      tnId,
      titulo,
      status,
      updatedCount,
      noSkuCount,
      variants: variantResults,
    });

    if (!DRY_RUN) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  }

  if (!DRY_RUN) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[fix-skus-not-simple] Completado en ${elapsed}s`);
  console.log(`  Productos actualizados: ${stats.updated}`);
  console.log(`  Sin productVariantListings: ${stats.noVarListings}`);
  console.log(`  Con variantes sin SKU parcial: ${stats.partialNoSku}`);
  console.log(`  Errores: ${stats.errors}`);
  if (!DRY_RUN) console.log(`  Resultados en data/fix-skus-not-simple-results.json`);
  console.log(`\n  PRÓXIMO PASO: re-correr "Vincular Productos Existentes" en el admin de EcomExperts.`);
}

main().catch(err => {
  console.error('[fix-skus-not-simple] Error fatal:', err.message);
  process.exit(1);
});
