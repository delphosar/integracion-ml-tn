/**
 * resolve-no-keeper-groups.js
 *
 * Para los 7 grupos sin keeper (todos needs-review):
 *  1. Puntúa cada TN product según cuántas de sus variantes matchean con ERP
 *  2. Conserva el de mayor puntaje (o el primero si empatan)
 *  3. Elimina los demás
 *  4. Reporta cuál quedó para asignarle SKU manualmente
 *
 * Opciones:
 *   --dry-run   Solo muestra qué haría, sin borrar ni actualizar
 *
 * Uso: node src/resolve-no-keeper-groups.js [--dry-run]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const { getProduct, deleteProduct } = require('./tn-api');

const DATA    = path.join(__dirname, '..', 'data');
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function norm(s) {
  return String(s ?? '').toLowerCase().trim();
}

function tnVariantValues(tnVariant) {
  return (tnVariant.values ?? []).map(v =>
    norm(v.es ?? v.en ?? Object.values(v)[0] ?? '')
  ).filter(Boolean);
}

function erpVariantValues(erpVariant) {
  return (erpVariant.variantAttributes ?? []).map(a => norm(a.options ?? '')).filter(Boolean);
}

function scoreProduct(tnVariants, erpVariants) {
  // Cuántas variantes TN tienen al menos 1 match con alguna variante ERP (score >= 0.5)
  let matched = 0;
  for (const tnVar of tnVariants) {
    const tnVals = tnVariantValues(tnVar);
    if (!tnVals.length) continue;
    for (const erp of erpVariants) {
      const erpVals = erpVariantValues(erp);
      if (!erpVals.length) continue;
      const hits = erpVals.filter(v => tnVals.includes(v)).length;
      const score = hits / Math.max(erpVals.length, tnVals.length);
      if (score >= 0.5) { matched++; break; }
    }
  }
  return matched;
}

(async () => {
  console.log(`\n=== resolve-no-keeper-groups ${DRY_RUN ? '[DRY RUN]' : ''} ===\n`);

  const noKeeperData = JSON.parse(fs.readFileSync(path.join(DATA, 'tn-duplicates-to-delete.json'), 'utf8'));
  const mlListings   = JSON.parse(fs.readFileSync(path.join(DATA, 'ecom-ml-listings-all.json'), 'utf8'));
  const erpVariants  = JSON.parse(fs.readFileSync(path.join(DATA, 'ecom-variants.json'), 'utf8'));

  // mlaId → erpProductId
  const mlaToErpProductId = new Map();
  for (const l of mlListings) {
    const pl = l.productListings?.[0];
    if (pl?.productId) mlaToErpProductId.set(l.ownerId, String(pl.productId));
  }

  // erpProductId → [variants]
  const erpByProduct = new Map();
  for (const v of erpVariants) {
    const pid = String(v.product?.id ?? '');
    if (!pid) continue;
    if (!erpByProduct.has(pid)) erpByProduct.set(pid, []);
    erpByProduct.get(pid).push(v);
  }

  const keptProducts = [];   // los que conservamos (necesitan SKU manual)
  let deletedCount = 0;
  let errCount = 0;

  for (const grupo of noKeeperData.noKeeper) {
    console.log(`\n── ERP SKU: ${grupo.erpSku} ──`);

    // Puntuar cada TN product del grupo
    const scored = [];
    for (const entry of grupo.entries) {
      try {
        const p = await getProduct(entry.tnProductId);
        await sleep(300);
        const erpPid  = mlaToErpProductId.get(entry.mlaId);
        const erpVars = erpPid ? (erpByProduct.get(erpPid) ?? []) : [];
        const score   = scoreProduct(p.variants ?? [], erpVars);
        const nombre  = p.name?.es ?? p.name?.en ?? Object.values(p.name||{})[0] ?? '';
        scored.push({ ...entry, score, variantCount: (p.variants||[]).length, nombre });
        console.log(`  TN ${entry.tnProductId} "${nombre}" | ${p.variants?.length} variantes | score: ${score}`);
      } catch(e) {
        console.log(`  TN ${entry.tnProductId} ERROR: ${e.message}`);
        scored.push({ ...entry, score: -1, error: e.message });
      }
    }

    // Ordenar por score desc, luego por variantCount desc (más completo)
    scored.sort((a, b) => b.score - a.score || b.variantCount - a.variantCount);

    const keeper  = scored[0];
    const toDelete = scored.slice(1);

    console.log(`  → KEEPER: TN ${keeper.tnProductId} "${keeper.nombre}" (score ${keeper.score})`);
    keptProducts.push({ erpSku: grupo.erpSku, tnProductId: keeper.tnProductId, mlaId: keeper.mlaId, nombre: keeper.nombre, score: keeper.score });

    for (const d of toDelete) {
      if (d.score === -1) {
        console.log(`  → SKIP TN ${d.tnProductId} (error al leer)`);
        continue;
      }
      if (DRY_RUN) {
        console.log(`  → [dry] eliminaría TN ${d.tnProductId} "${d.nombre}"`);
        deletedCount++;
      } else {
        try {
          await deleteProduct(d.tnProductId);
          console.log(`  → [ok] eliminado TN ${d.tnProductId} "${d.nombre}"`);
          deletedCount++;
          await sleep(DELAY_MS);
        } catch(e) {
          console.error(`  → ERROR eliminando TN ${d.tnProductId}: ${e.message}`);
          errCount++;
        }
      }
    }
  }

  // Guardar keepers para revisión manual de SKU
  const outPath = path.join(DATA, 'no-keeper-resolved.json');
  fs.writeFileSync(outPath, JSON.stringify(keptProducts, null, 2));

  console.log(`
=== Resumen ${DRY_RUN ? '[DRY RUN]' : ''} ===
  eliminados:  ${deletedCount}
  errores:     ${errCount}
  keepers:     ${keptProducts.length} (necesitan SKU manual)

[saved] ${outPath}
`);

  console.log('Productos keeper que necesitan SKU manual:');
  keptProducts.forEach(k => console.log(`  TN ${k.tnProductId} | ERP SKU: ${k.erpSku} | "${k.nombre}"`));

})().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
