/**
 * delete-tn-duplicates.js
 *
 * Elimina productos TN duplicados, conservando 1 por ERP SKU (el que tiene SKU correcto).
 * Lee la lista generada por tmp-analyze-duplicates.js.
 *
 * Opciones:
 *   --dry-run    Solo loguea qué eliminaría, sin borrar nada
 *   --resume     Saltea los que ya fueron eliminados en una corrida previa
 *   --limit N    Procesa solo los primeros N
 *
 * Uso: node src/delete-tn-duplicates.js [--dry-run] [--resume] [--limit N]
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs   = require('fs');
const path = require('path');
const { deleteProduct } = require('./tn-api');

const DATA    = path.join(__dirname, '..', 'data');
const INPUT   = path.join(DATA, 'tn-duplicates-to-delete.json');
const RESULTS = path.join(DATA, 'delete-tn-duplicates-results.json');

const DRY_RUN = process.argv.includes('--dry-run');
const RESUME  = process.argv.includes('--resume');
const LIMIT   = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? parseInt(process.argv[i + 1], 10) : null;
})();

const DELAY_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmt(n, total) {
  const pct = ((n / total) * 100).toFixed(1);
  return `[${String(n).padStart(String(total).length)}/${total} ${pct}%]`;
}

(async () => {
  console.log(`\n=== delete-tn-duplicates ${DRY_RUN ? '[DRY RUN]' : ''} ===\n`);

  const { toDelete, noKeeper } = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  console.log(`Total a eliminar:          ${toDelete.length}`);
  console.log(`Grupos sin keeper (skip):  ${noKeeper.length}`);

  if (noKeeper.length) {
    console.log('\nGrupos sin keeper (se saltean):');
    noKeeper.forEach(g => {
      console.log(`  SKU: ${g.erpSku} → TN: ${g.entries.map(e => e.tnProductId).join(', ')}`);
    });
  }

  // Cargar resultados previos si --resume
  const prevDeleted = new Set();
  if (RESUME && fs.existsSync(RESULTS)) {
    const prev = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    prev.filter(r => r.status === 'ok').forEach(r => prevDeleted.add(r.deleteTn));
    console.log(`\n[resume] ${prevDeleted.size} ya eliminados, se saltearán.`);
  }

  let entries = toDelete;
  if (LIMIT) entries = entries.slice(0, LIMIT);

  const total = entries.length;
  let okCount = 0, skippedCount = 0, errCount = 0;
  const results = [];

  console.log(`\nProcesando ${total} productos...\n`);

  for (let i = 0; i < entries.length; i++) {
    const { erpSku, keepTn, deleteTn, deleteMla, deleteStatus } = entries[i];
    const prefix = fmt(i + 1, total);

    if (RESUME && prevDeleted.has(deleteTn)) {
      skippedCount++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`${prefix} [dry] TN ${deleteTn} (${deleteStatus}) | SKU: ${erpSku} | keeper: TN ${keepTn}`);
      results.push({ erpSku, keepTn, deleteTn, deleteMla, status: 'dry' });
      okCount++;
      continue;
    }

    try {
      await deleteProduct(deleteTn);
      console.log(`${prefix} [ok] TN ${deleteTn} eliminado | SKU: ${erpSku} | keeper: TN ${keepTn}`);
      results.push({ erpSku, keepTn, deleteTn, deleteMla, status: 'ok' });
      okCount++;
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`${prefix} ERROR TN ${deleteTn}: ${err.message}`);
      results.push({ erpSku, keepTn, deleteTn, deleteMla, status: 'error', error: err.message });
      errCount++;
    }
  }

  // Merge con previos si resume
  let finalResults = results;
  if (RESUME && fs.existsSync(RESULTS)) {
    const prev = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
    const newIds = new Set(results.map(r => r.deleteTn));
    finalResults = [...prev.filter(r => !newIds.has(r.deleteTn)), ...results];
  }
  fs.writeFileSync(RESULTS, JSON.stringify(finalResults, null, 2));

  console.log(`
=== Resumen ${DRY_RUN ? '[DRY RUN]' : ''} ===
  eliminados:  ${okCount}
  salteados:   ${skippedCount}
  errores:     ${errCount}
  sin keeper:  ${noKeeper.length} grupos (ver arriba)
  ─────────────
  TOTAL lista: ${total}

[saved] ${RESULTS}
`);

})().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
