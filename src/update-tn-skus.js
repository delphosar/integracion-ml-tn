/**
 * update-tn-skus.js
 *
 * Actualiza los SKUs de variantes en TiendaNube para que coincidan con
 * los SKUs del ERP (EcomExperts), necesario para activar la integración nativa.
 *
 * Estrategia:
 *   - Productos con 1 variante TN  → sku = erpSku directo
 *   - Productos con N variantes TN → matching por atributos vs. variantes ERP
 *
 * Opciones:
 *   --dry-run       No aplica cambios, solo loguea qué haría
 *   --only-simple   Solo productos con 1 variante TN (más seguro para empezar)
 *   --limit N       Procesa solo los primeros N productos
 *   --resume        Saltea productos ya procesados (lee results previos)
 *
 * Uso: node src/update-tn-skus.js [--dry-run] [--only-simple] [--limit N] [--resume]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const { getProduct, updateVariant } = require('./tn-api');

const DATA    = path.join(__dirname, '..', 'data');
const RESULTS = path.join(DATA, 'update-tn-skus-results.json');

const DRY_RUN     = process.argv.includes('--dry-run');
const ONLY_SIMPLE = process.argv.includes('--only-simple');
const RESUME      = process.argv.includes('--resume');
const LIMIT       = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : null;
})();

const DELAY_MS = 600; // TN rate limit: ~2 req/s, dejamos margen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(name) {
  const p = path.join(DATA, name);
  if (!fs.existsSync(p)) { console.error(`Falta: ${p}`); process.exit(1); }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function fmt(n, total) {
  const pct = ((n / total) * 100).toFixed(1);
  return `[${String(n).padStart(String(total).length)}/${total} ${pct}%]`;
}

// Normaliza string para comparación: minúsculas, sin espacios extra
function norm(s) {
  return String(s ?? '').toLowerCase().trim();
}

// Extrae los valores de atributo de una variante TN
// variant.values es [{es:"Rojo"}, {es:"Grande"}] → ["rojo","grande"]
function tnVariantValues(tnVariant) {
  return (tnVariant.values ?? []).map(v =>
    norm(v.es ?? v.en ?? Object.values(v)[0] ?? '')
  ).filter(Boolean);
}

// Extrae los valores de atributo de una variante ERP
// variantAttributes es [{name:"Color", options:"Rojo"}] → ["rojo"]
function erpVariantValues(erpVariant) {
  return (erpVariant.variantAttributes ?? []).map(a =>
    norm(a.options ?? '')
  ).filter(Boolean);
}

// Busca la variante ERP que mejor coincide con los atributos de una variante TN.
// Retorna { erpVariant, score } o null si no hay match.
function matchErpVariant(tnVariant, erpVariants) {
  const tnVals = tnVariantValues(tnVariant);
  if (!tnVals.length) return null;

  let best = null;
  let bestScore = 0;

  for (const erp of erpVariants) {
    const erpVals = erpVariantValues(erp);
    if (!erpVals.length) continue;

    // Cuántos valores ERP aparecen en los valores TN (y viceversa)
    const matched = erpVals.filter(v => tnVals.includes(v)).length;
    const score = matched / Math.max(erpVals.length, tnVals.length);

    if (score > bestScore) {
      bestScore = score;
      best = erp;
    }
  }

  return bestScore >= 0.5 ? { erpVariant: best, score: bestScore } : null;
}

(async () => {
  console.log(`\n=== update-tn-skus ${DRY_RUN ? '[DRY RUN]' : ''} ===\n`);

  // ─── Cargar datos ───────────────────────────────────────────────────────────

  const skuMapping   = loadJson('sku-mapping-analysis.json');
  const mlListings   = loadJson('ecom-ml-listings-all.json');
  const erpVariants  = loadJson('ecom-variants.json');

  // mlaId → ERP productId (primer productListing)
  const mlaToErpProductId = new Map();
  for (const l of mlListings) {
    const pl = l.productListings?.[0];
    if (pl?.productId) mlaToErpProductId.set(l.ownerId, String(pl.productId));
  }

  // ERP productId → [erpVariant]
  const erpProductVariants = new Map();
  for (const v of erpVariants) {
    const pid = String(v.product?.id ?? '');
    if (!pid) continue;
    if (!erpProductVariants.has(pid)) erpProductVariants.set(pid, []);
    erpProductVariants.get(pid).push(v);
  }

  // Cargar resultados previos si --resume
  const prevResults = new Map();
  if (RESUME && fs.existsSync(RESULTS)) {
    const prev = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    for (const r of prev) {
      if (r.status === 'ok' || r.status === 'already-ok') {
        prevResults.set(r.tnProductId, r);
      }
    }
    console.log(`[resume] ${prevResults.size} productos ya procesados, se saltearán.\n`);
  }

  // Solo entradas con tnProductId
  let entries = skuMapping.filter(e => e.tnProductId !== null);
  if (LIMIT) entries = entries.slice(0, LIMIT);

  const total = entries.length;
  console.log(`Productos a procesar: ${total}`);
  if (ONLY_SIMPLE) console.log(`(--only-simple: se saltearán multi-variante)\n`);

  // ─── Contadores ─────────────────────────────────────────────────────────────

  let okSimple = 0, okMatched = 0, alreadyOk = 0,
      skippedMulti = 0, needsReview = 0, errCount = 0;
  const results = [];

  // ─── Procesar ───────────────────────────────────────────────────────────────

  for (let i = 0; i < entries.length; i++) {
    const { mlaId, erpSku, tnProductId } = entries[i];
    const prefix = fmt(i + 1, total);

    // Skip si ya procesado
    if (RESUME && prevResults.has(tnProductId)) {
      alreadyOk++;
      continue;
    }

    let tnProduct;
    try {
      tnProduct = await getProduct(tnProductId);
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`${prefix} ERROR GET TN ${tnProductId}: ${err.message}`);
      results.push({ mlaId, erpSku, tnProductId, status: 'error', error: err.message });
      errCount++;
      continue;
    }

    const variants = tnProduct.variants ?? [];

    // ── Caso 1: producto simple (1 variante) ──────────────────────────────────
    if (variants.length === 1) {
      const v = variants[0];
      if (v.sku === erpSku) {
        console.log(`${prefix} [already-ok] TN ${tnProductId} var ${v.id} sku="${erpSku}"`);
        results.push({ mlaId, erpSku, tnProductId, status: 'already-ok' });
        alreadyOk++;
        continue;
      }

      if (DRY_RUN) {
        console.log(`${prefix} [dry] TN ${tnProductId} var ${v.id}  "${v.sku}" → "${erpSku}"`);
        results.push({ mlaId, erpSku, tnProductId, status: 'dry', oldSku: v.sku });
        okSimple++;
        continue;
      }

      try {
        await updateVariant(tnProductId, v.id, { sku: erpSku });
        console.log(`${prefix} [ok-simple] TN ${tnProductId} var ${v.id}  "${v.sku}" → "${erpSku}"`);
        results.push({ mlaId, erpSku, tnProductId, variantId: v.id, status: 'ok', oldSku: v.sku });
        okSimple++;
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`${prefix} ERROR UPDATE TN ${tnProductId}: ${err.message}`);
        results.push({ mlaId, erpSku, tnProductId, status: 'error', error: err.message });
        errCount++;
      }
      continue;
    }

    // ── Caso 2: múltiples variantes ───────────────────────────────────────────
    if (ONLY_SIMPLE) {
      console.log(`${prefix} [skip-multi] TN ${tnProductId} (${variants.length} variantes)`);
      results.push({ mlaId, erpSku, tnProductId, status: 'skipped-multi', variantCount: variants.length });
      skippedMulti++;
      continue;
    }

    // Buscar variantes ERP del mismo producto
    const erpPid = mlaToErpProductId.get(mlaId);
    const erpVars = erpPid ? (erpProductVariants.get(erpPid) ?? []) : [];

    if (!erpVars.length) {
      console.log(`${prefix} [needs-review] TN ${tnProductId} — sin variantes ERP para producto ${erpPid ?? '?'}`);
      results.push({ mlaId, erpSku, tnProductId, status: 'needs-review', reason: 'no-erp-variants' });
      needsReview++;
      continue;
    }

    // Intentar matching por atributos
    const updates = [];
    const unmatched = [];

    for (const tnVar of variants) {
      // Si ya tiene SKU de ERP correcto, skip
      const match = matchErpVariant(tnVar, erpVars);
      if (!match) {
        unmatched.push(tnVar.id);
        continue;
      }
      const targetSku = match.erpVariant.sku ?? match.erpVariant.product?.sku ?? erpSku;
      if (tnVar.sku !== targetSku) {
        updates.push({ tnVarId: tnVar.id, oldSku: tnVar.sku, newSku: targetSku, score: match.score });
      }
    }

    if (unmatched.length) {
      console.log(`${prefix} [needs-review] TN ${tnProductId} — ${unmatched.length} variantes sin match (de ${variants.length})`);
      results.push({
        mlaId, erpSku, tnProductId, status: 'needs-review',
        reason: 'unmatched-variants', unmatched, variantCount: variants.length,
      });
      needsReview++;
      continue;
    }

    if (!updates.length) {
      console.log(`${prefix} [already-ok] TN ${tnProductId} (${variants.length} variantes, SKUs ya correctos)`);
      results.push({ mlaId, erpSku, tnProductId, status: 'already-ok' });
      alreadyOk++;
      continue;
    }

    if (DRY_RUN) {
      for (const u of updates) {
        console.log(`${prefix} [dry-multi] TN ${tnProductId} var ${u.tnVarId}  "${u.oldSku}" → "${u.newSku}" (score ${u.score.toFixed(2)})`);
      }
      results.push({ mlaId, erpSku, tnProductId, status: 'dry', updates });
      okMatched++;
      continue;
    }

    // Aplicar updates de variantes
    let anyError = false;
    const appliedUpdates = [];
    for (const u of updates) {
      try {
        await updateVariant(tnProductId, u.tnVarId, { sku: u.newSku });
        console.log(`${prefix} [ok-match] TN ${tnProductId} var ${u.tnVarId}  "${u.oldSku}" → "${u.newSku}"`);
        appliedUpdates.push(u);
        await sleep(DELAY_MS);
      } catch (err) {
        console.error(`${prefix} ERROR UPDATE var ${u.tnVarId}: ${err.message}`);
        anyError = true;
        errCount++;
      }
    }
    if (!anyError) {
      results.push({ mlaId, erpSku, tnProductId, status: 'ok', updates: appliedUpdates });
      okMatched++;
    } else {
      results.push({ mlaId, erpSku, tnProductId, status: 'error', updates: appliedUpdates });
    }
  }

  // ─── Guardar resultados ──────────────────────────────────────────────────────

  // Si resume, merge con previos
  let finalResults = results;
  if (RESUME && fs.existsSync(RESULTS)) {
    const prev = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    const newIds = new Set(results.map(r => r.tnProductId));
    finalResults = [...prev.filter(r => !newIds.has(r.tnProductId)), ...results];
  }
  fs.writeFileSync(RESULTS, JSON.stringify(finalResults, null, 2));

  // ─── Resumen ──────────────────────────────────────────────────────────────────

  console.log(`
=== Resumen ${DRY_RUN ? '[DRY RUN]' : ''} ===
  ok-simple:     ${okSimple}
  ok-matched:    ${okMatched}
  already-ok:    ${alreadyOk}
  skipped-multi: ${skippedMulti}
  needs-review:  ${needsReview}
  errors:        ${errCount}
  ─────────────
  TOTAL:         ${total}

[saved] ${RESULTS}
`);

})().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
