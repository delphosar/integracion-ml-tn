/**
 * diagnose-price-match.js
 *
 * Diagnostica el estado de precios TiendaNube vs MercadoLibre y opcionalmente
 * los corrige.
 *
 * Estrategia para productos CON variaciones:
 *   En lugar de intentar el match por SKU individual (que falla cuando los SKUs
 *   no coinciden entre ML y TN), se aplica el precio de la publicación padre ML
 *   a TODAS las variantes TN del producto. Esto cubre tanto productos migrados
 *   por nosotros como los vinculados vía la integración nativa de EcomExperts.
 *
 * Flujo:
 *   Fase 1 – Batch-fetch ML (rápido, ~60 requests):
 *     Obtiene precios actuales de ML y compara vs SQLite DB.
 *   Fase 2 – TN fetch (por producto, solo los desactualizados o --all-tn):
 *     Verifica precios reales en TN y detecta discrepancias.
 *   Fase 3 – Fix (solo con --fix):
 *     Aplica precio padre ML a todas las variantes TN.
 *
 * Uso:
 *   node src/diagnose-price-match.js                → solo diagnóstico (DRY-RUN)
 *   node src/diagnose-price-match.js --all-tn        → diagnóstico completo (verifica TN en todos)
 *   node src/diagnose-price-match.js --fix            → corrige los desactualizados
 *   node src/diagnose-price-match.js --fix --all-tn   → verifica y corrige todos
 *   node src/diagnose-price-match.js --fix --limit=50 → solo primeros 50
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path  = require('path');
const fs    = require('fs');
const { getDb, saveToFile } = require('./db');
const { getValidToken }     = require('./ml-auth');
const { fetchItemsBatch }   = require('./ml-api');
const tnApi                 = require('./tn-api');

const FIX      = process.argv.includes('--fix');
const ALL_TN   = process.argv.includes('--all-tn');
const LIMIT    = (() => { const a = process.argv.find(x => x.startsWith('--limit=')); return a ? parseInt(a.split('=')[1], 10) : null; })();
const DELAY_MS    = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
// TN tiene rate limit ~40 req/min. Con --all-tn usamos delay mayor para no saturar.
const TN_DELAY_MS = (() => {
  const a = process.argv.find(x => x.startsWith('--tn-delay='));
  return a ? parseInt(a.split('=')[1], 10) : (ALL_TN ? 1600 : DELAY_MS);
})();
const BATCH    = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function n(v) { return v ?? null; }

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const modeLabel = FIX ? 'FIX MODE' : 'DRY-RUN';
  const tnLabel   = ALL_TN ? ' --all-tn (verifica TN en todos)' : ' (verifica TN solo en desactualizados)';
  console.log(`[diagnose-price-match] Iniciando (${modeLabel})${tnLabel}...`);

  const token = await getValidToken();
  const db    = await getDb();

  // ── Cargar todos los pares ────────────────────────────────────────────────
  const pairsRes = db.exec(`
    SELECT tp.ml_item_id, tp.tn_product_id,
           i.price           AS db_price,
           i.original_price  AS db_orig,
           i.status          AS db_status
    FROM   tn_products tp
    JOIN   ml_items i ON i.id = tp.ml_item_id
    ORDER  BY tp.ml_item_id
  `);
  let pairs = (pairsRes[0]?.values ?? []).map(([mlId, tnId, dbPrice, dbOrig, dbStatus]) => ({
    mlId, tnId, dbPrice, dbOrig, dbStatus,
  }));
  if (LIMIT) pairs = pairs.slice(0, LIMIT);
  console.log(`  ${pairs.length} pares cargados del DB`);

  const report = {
    timestamp: new Date().toISOString(),
    mode: FIX ? 'fix' : 'dry-run',
    allTn: ALL_TN,
    total: pairs.length,
    summary: {},
    mlNotFound:    [],   // ML retornó ≠200
    mlNotActive:   [],   // ML item inactivo/pausado
    tnNotFound:    [],   // TN retornó 404
    priceOk:       [],   // precios correctos
    priceMismatch: [],   // precios incorrectos en TN
    fixed:         [],   // corregidos (solo si --fix)
    errors:        [],
  };

  // ── Fase 1: Batch-fetch ML ───────────────────────────────────────────────
  console.log('\n[Fase 1] Obteniendo precios actuales de ML...');
  const mlMap = new Map(); // mlId → { price, original_price, status, variations[] }

  for (let i = 0; i < pairs.length; i += BATCH) {
    const batch = pairs.slice(i, i + BATCH);
    const ids   = batch.map(p => p.mlId);

    try {
      const results = await fetchItemsBatch(ids, token);
      await sleep(DELAY_MS);

      for (let j = 0; j < results.length; j++) {
        const { code, body: item } = results[j];
        // ML devuelve resultados en el mismo orden que los IDs enviados
        const pair = (code === 200 && item?.id)
          ? batch.find(p => p.mlId === item.id) ?? batch[j]
          : batch[j];
        if (!pair) continue;

        if (code !== 200 || !item?.id) {
          report.mlNotFound.push({ mlId: pair.mlId, tnId: pair.tnId, code });
        } else {
          mlMap.set(item.id, {
            price:          item.price,
            original_price: item.original_price ?? null,
            status:         item.status,
            variations:     item.variations ?? [],
          });
        }
      }
    } catch (err) {
      console.error(`\n  Error batch ML [${i}–${i + BATCH}]: ${err.message}`);
      batch.forEach(p => report.errors.push({ mlId: p.mlId, tnId: p.tnId, error: `ML fetch: ${err.message}` }));
    }

    process.stdout.write(`\r  ML progress: ${Math.min(i + BATCH, pairs.length)} / ${pairs.length}  `);
  }
  console.log();
  console.log(`  ML obtenidos: ${mlMap.size} | No encontrados: ${report.mlNotFound.length}`);

  // ── Fase 2 + 3: Verificar TN y opcionalmente fijar ──────────────────────
  // Determinar qué pares chequear en TN
  const toCheck = pairs.filter(p => {
    if (!mlMap.has(p.mlId)) return false;
    const ml = mlMap.get(p.mlId);
    if (ml.status !== 'active') {
      report.mlNotActive.push({ mlId: p.mlId, tnId: p.tnId, status: ml.status });
      return false;
    }
    if (ALL_TN) return true;
    // Solo verificar en TN si el precio difiere del DB (síntoma de cambio no sincronizado)
    return ml.price !== p.dbPrice ||
           (ml.original_price ?? null) !== (p.dbOrig ?? null);
  });

  const skippedTN = pairs.length - report.mlNotFound.length - report.mlNotActive.length - toCheck.length;
  const estimatedMin = Math.ceil(toCheck.length * TN_DELAY_MS / 1000 / 60);
  console.log(`\n[Fase 2] Verificando TN para ${toCheck.length} items${ALL_TN ? '' : ` (${skippedTN} sin cambios en ML — asumidos OK)`}...`);
  console.log(`  Delay TN: ${TN_DELAY_MS}ms por request | Estimado: ~${estimatedMin} min`);
  if (!ALL_TN && skippedTN > 0) {
    console.log(`  (Para verificar TODOS los TN, usar --all-tn)`);
  }

  let tnDone = 0;

  for (const pair of toCheck) {
    const ml = mlMap.get(pair.mlId);

    // Obtener producto TN
    let tnProduct;
    try {
      tnProduct = await tnApi.getProduct(pair.tnId);
      await sleep(TN_DELAY_MS);
    } catch (err) {
      if (err.response?.status === 404) {
        report.tnNotFound.push({ mlId: pair.mlId, tnId: pair.tnId });
      } else {
        report.errors.push({ mlId: pair.mlId, tnId: pair.tnId, error: `TN fetch: ${err.message}` });
      }
      tnDone++;
      process.stdout.write(`\r  TN progress: ${tnDone} / ${toCheck.length}  `);
      continue;
    }

    const tnVariants = tnProduct.variants ?? [];
    const hasVariations = ml.variations.length > 0;

    // Precios esperados en TN (usando precio padre ML para todas las variantes)
    const expectedRegular = (ml.original_price && ml.original_price > ml.price)
      ? ml.original_price
      : ml.price;
    const expectedPromo = (ml.original_price && ml.original_price > ml.price)
      ? ml.price
      : null;

    // Verificar cada variante TN
    const mismatchedVars = [];
    for (const v of tnVariants) {
      const tnPrice = parseFloat(v.price ?? '0');
      const tnPromo = (v.promotional_price && parseFloat(v.promotional_price) > 0)
        ? parseFloat(v.promotional_price)
        : null;

      const regularOk = Math.abs(tnPrice - expectedRegular) < 0.01;
      const promoOk   = expectedPromo
        ? (tnPromo !== null && Math.abs(tnPromo - expectedPromo) < 0.01)
        : (tnPromo === null);

      if (!regularOk || !promoOk) {
        mismatchedVars.push({
          varId: v.id,
          sku:   v.sku ?? null,
          tnPrice,
          tnPromo,
          expectedRegular,
          expectedPromo,
        });
      }
    }

    if (mismatchedVars.length === 0) {
      report.priceOk.push({ mlId: pair.mlId, tnId: pair.tnId });
    } else {
      report.priceMismatch.push({
        mlId: pair.mlId,
        tnId: pair.tnId,
        tnTitle: tnProduct.name?.es ?? tnProduct.name ?? null,
        mlPrice:         ml.price,
        mlOrigPrice:     ml.original_price,
        expectedRegular,
        expectedPromo,
        hasVariations,
        totalTnVariants: tnVariants.length,
        mismatchedCount: mismatchedVars.length,
        mismatchedVars,
      });

      // ── Fase 3: Fix ──────────────────────────────────────────────────────
      if (FIX) {
        let fixOk = 0;
        let fixErr = 0;
        const payload = expectedPromo
          ? { price: String(expectedRegular), promotional_price: String(expectedPromo) }
          : { price: String(expectedRegular), promotional_price: null };

        for (const tnVar of tnVariants) {
          try {
            await tnApi.updateVariant(pair.tnId, tnVar.id, payload);
            await sleep(TN_DELAY_MS);
            fixOk++;
          } catch (err) {
            fixErr++;
            report.errors.push({
              mlId: pair.mlId, tnId: pair.tnId,
              varId: tnVar.id,
              error: `TN update variant: ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`,
            });
          }
        }

        if (fixOk > 0) {
          // Actualizar SQLite para que el delta sync no re-intente
          db.run(
            `UPDATE ml_items SET price = ?, original_price = ?, synced_at = datetime('now') WHERE id = ?`,
            [n(ml.price), n(ml.original_price), pair.mlId]
          );
          report.fixed.push({ mlId: pair.mlId, tnId: pair.tnId, variantsFixed: fixOk, variantErrors: fixErr });
        }
      }
    }

    tnDone++;
    process.stdout.write(`\r  TN progress: ${tnDone} / ${toCheck.length}  `);
  }
  console.log();

  // ── Summary ──────────────────────────────────────────────────────────────
  report.summary = {
    total:            pairs.length,
    mlNotFound:       report.mlNotFound.length,
    mlNotActive:      report.mlNotActive.length,
    tnNotFound:       report.tnNotFound.length,
    notCheckedInTN:   skippedTN,
    priceOkInTN:      report.priceOk.length,
    priceMismatch:    report.priceMismatch.length,
    fixed:            report.fixed.length,
    errors:           report.errors.length,
  };

  console.log('\n[diagnose-price-match] Completado');
  console.log(`  Total pares:                 ${report.summary.total}`);
  console.log(`  ML no encontrado (no-200):   ${report.summary.mlNotFound}`);
  console.log(`  ML inactivo/pausado:         ${report.summary.mlNotActive}`);
  console.log(`  TN no encontrado (404):      ${report.summary.tnNotFound}`);
  if (!ALL_TN)
    console.log(`  Sin cambio en ML (TN no verificado): ${report.summary.notCheckedInTN}`);
  console.log(`  ✓ Precios correctos en TN:   ${report.summary.priceOkInTN}`);
  console.log(`  ✗ Precios incorrectos en TN: ${report.summary.priceMismatch}`);
  if (FIX)
    console.log(`  Corregidos en TN:            ${report.summary.fixed}`);
  console.log(`  Errores:                     ${report.summary.errors}`);

  const outFile = path.join(__dirname, '..', 'data', 'diagnose-price-report.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n  Reporte guardado en: data/diagnose-price-report.json`);

  if (FIX && report.fixed.length > 0) saveToFile();
}

main().catch(err => {
  console.error('[diagnose-price-match] Error fatal:', err.message);
  process.exit(1);
});
