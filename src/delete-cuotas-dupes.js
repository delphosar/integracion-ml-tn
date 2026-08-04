/**
 * delete-cuotas-dupes.js
 *
 * Elimina duplicados de TiendaNube que provienen de publicaciones ML
 * "en cuotas" (mismo producto, dos publicaciones distintas en ML).
 *
 * Fuente: data/tn-similar-groups.json (generado por group-similar-names.js)
 * Salida: data/delete-cuotas-results.json (log completo de cada eliminación)
 *
 * Reglas para elegir qué conservar:
 *   same-sku     → conservar menor TN ID
 *   erp-vs-uuid  → conservar el que tiene SKU ERP
 *   erp-vs-ml    → conservar el que tiene SKU ERP
 *   uuid-vs-ml   → conservar el que tiene UUID (más antiguo)
 *   two-ml-ids   → conservar menor TN ID
 *
 * Casos excluidos (necesitan revisión manual):
 *   two-erp-skus → ambos tienen SKUs ERP distintos
 *
 * Uso:
 *   node src/delete-cuotas-dupes.js --dry-run
 *   node src/delete-cuotas-dupes.js
 *   node src/delete-cuotas-dupes.js --resume
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const tnApi = require('./tn-api');

const DRY_RUN = process.argv.includes('--dry-run');
const RESUME  = process.argv.includes('--resume');
const DELAY_MS = 600;

const GROUPS_PATH  = path.join(__dirname, '..', 'data', 'tn-similar-groups.json');
const ALL_PRODS    = path.join(__dirname, '..', 'data', 'tn-all-products.json');
const RESULTS_PATH = path.join(__dirname, '..', 'data', 'delete-cuotas-results.json');
const REVIEW_PATH  = path.join(__dirname, '..', 'data', 'delete-cuotas-needs-review.json');

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const ML_ID_RE = /^MLA\d+/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function skuType(sku) {
  if (!sku) return 'null';
  if (UUID_RE.test(sku)) return 'uuid';
  if (ML_ID_RE.test(sku)) return 'ml-id';
  return 'erp';
}

function getName(nameObj) {
  if (!nameObj) return '';
  if (typeof nameObj === 'string') return nameObj;
  return nameObj.es ?? nameObj.pt ?? nameObj.en ?? Object.values(nameObj)[0] ?? '';
}

/**
 * Analiza un grupo de productos con título idéntico y determina:
 *   - qué TN ID conservar
 *   - qué TN IDs eliminar
 *   - la razón
 *   - si necesita revisión manual
 */
function analyzeGroup(group, productsById) {
  const members = group.members.map(m => ({
    ...m,
    type: skuType(m.sku),
    created_at: productsById[m.tn_product_id]?.created_at ?? null,
  }));

  const erp  = members.filter(m => m.type === 'erp');
  const uuid = members.filter(m => m.type === 'uuid');
  const ml   = members.filter(m => m.type === 'ml-id');

  const uniqueSkus = new Set(members.map(m => (m.sku || '').toLowerCase().trim()));

  // Mismo SKU exacto (incluyendo mismo ML-ID): conservar menor TN ID
  if (uniqueSkus.size === 1) {
    const sorted = [...members].sort((a, b) => Number(a.tn_product_id) - Number(b.tn_product_id));
    return {
      reason: 'same-sku',
      keep: sorted[0],
      toDelete: sorted.slice(1),
      needsReview: false,
    };
  }

  // ERP vs UUID: conservar ERP
  if (erp.length === 1 && uuid.length > 0 && ml.length === 0) {
    return {
      reason: 'erp-vs-uuid',
      keep: erp[0],
      toDelete: uuid,
      needsReview: false,
    };
  }

  // ERP vs ML-ID: conservar ERP
  if (erp.length === 1 && ml.length > 0 && uuid.length === 0) {
    return {
      reason: 'erp-vs-ml',
      keep: erp[0],
      toDelete: ml,
      needsReview: false,
    };
  }

  // UUID vs ML-ID (sin ERP): conservar UUID (producto más antiguo en TN)
  if (uuid.length > 0 && ml.length > 0 && erp.length === 0) {
    // Si hay varios UUID, conservar el de menor TN ID
    const uuidSorted = [...uuid].sort((a, b) => Number(a.tn_product_id) - Number(b.tn_product_id));
    return {
      reason: 'uuid-vs-ml',
      keep: uuidSorted[0],
      toDelete: [...uuidSorted.slice(1), ...ml],
      needsReview: false,
    };
  }

  // Dos ML IDs distintos (sin ERP ni UUID): conservar menor TN ID
  if (ml.length >= 2 && erp.length === 0 && uuid.length === 0) {
    const sorted = [...members].sort((a, b) => Number(a.tn_product_id) - Number(b.tn_product_id));
    return {
      reason: 'two-ml-ids',
      keep: sorted[0],
      toDelete: sorted.slice(1),
      needsReview: false,
    };
  }

  // Caso ambiguo → revisión manual
  return {
    reason: members.every(m => m.type === 'erp') ? 'two-erp-skus' : 'mixed-unknown',
    keep: null,
    toDelete: [],
    needsReview: true,
    members,
  };
}

async function main() {
  console.log(`[delete-cuotas-dupes] Iniciando${DRY_RUN ? ' (DRY RUN)' : ''}${RESUME ? ' (RESUME)' : ''}...\n`);

  const groups = JSON.parse(fs.readFileSync(GROUPS_PATH, 'utf8'));
  const allProducts = JSON.parse(fs.readFileSync(ALL_PRODS, 'utf8'));

  // Índice por TN product ID
  const productsById = {};
  allProducts.forEach(p => {
    productsById[String(p.id)] = {
      id: String(p.id),
      title: getName(p.name),
      created_at: p.created_at,
      variants: p.variants,
    };
  });

  // Solo grupos con título IDÉNTICO
  const exactGroups = groups.filter(g => {
    const titles = g.members.map(m => m.title.trim().toLowerCase().replace(/\s+/g, ' '));
    return (new Set(titles)).size === 1;
  });

  console.log(`Grupos con título idéntico: ${exactGroups.length}`);

  const deletePlan = [];
  const needsReview = [];

  for (const g of exactGroups) {
    const result = analyzeGroup(g, productsById);
    if (result.needsReview) {
      needsReview.push({
        reason: result.reason,
        title: g.members[0].title,
        members: result.members ?? g.members,
      });
    } else {
      for (const member of result.toDelete) {
        const prod = productsById[member.tn_product_id];
        deletePlan.push({
          tn_product_id: member.tn_product_id,
          title: prod?.title ?? member.title,
          sku: member.sku,
          sku_type: member.type,
          reason: result.reason,
          kept_tn_product_id: result.keep.tn_product_id,
          kept_sku: result.keep.sku,
          kept_sku_type: result.keep.type,
        });
      }
    }
  }

  // Guardar listado de necesita revisión
  fs.writeFileSync(REVIEW_PATH, JSON.stringify(needsReview, null, 2));
  console.log(`Grupos para revisión manual: ${needsReview.length} (guardados en data/delete-cuotas-needs-review.json)`);
  needsReview.forEach(g => {
    console.log(`  [${g.reason}] "${g.title}"`);
    g.members.forEach(m => console.log(`    TN:${m.tn_product_id}  SKU:${m.sku}  [${m.type}]`));
  });

  console.log(`\nProductos a eliminar: ${deletePlan.length}`);
  deletePlan.forEach(d => {
    console.log(`  TN:${d.tn_product_id}  SKU:${d.sku}  [${d.reason}]  → keep TN:${d.kept_tn_product_id}`);
  });

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No se eliminó nada. Ejecutar sin --dry-run para eliminar.');
    return;
  }

  // --- Resume: cargar resultados anteriores ---
  const prevResults = RESUME && fs.existsSync(RESULTS_PATH)
    ? JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'))
    : [];
  const doneIds = new Set(prevResults.filter(r => r.status === 'deleted').map(r => r.tn_product_id));

  const work = deletePlan.filter(d => !doneIds.has(d.tn_product_id));
  if (RESUME) console.log(`\nResume: ${doneIds.size} ya eliminados, quedan ${work.length}`);

  const results = [...prevResults];
  const stats = { deleted: 0, notFound: 0, errors: 0 };

  console.log(`\nEliminando ${work.length} productos...\n`);

  for (let i = 0; i < work.length; i++) {
    const d = work[i];
    const label = `[${i + 1}/${work.length}] TN:${d.tn_product_id}`;

    try {
      await tnApi.deleteProduct(d.tn_product_id);
      stats.deleted++;
      const entry = {
        ...d,
        status: 'deleted',
        deleted_at: new Date().toISOString(),
        error: null,
      };
      results.push(entry);
      console.log(`  ✓ ${label}  "${d.title.substring(0, 50)}"  (${d.reason})`);
    } catch (err) {
      if (err.response?.status === 404) {
        stats.notFound++;
        results.push({ ...d, status: 'not-found', deleted_at: new Date().toISOString(), error: null });
        console.log(`  ~ ${label}  404 not found (ya eliminado)`);
      } else {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        stats.errors++;
        results.push({ ...d, status: 'error', deleted_at: new Date().toISOString(), error: detail });
        console.error(`  ✗ ${label}  ERROR: ${detail}`);
      }
    }

    await sleep(DELAY_MS);

    // Guardar resultados cada 5 eliminaciones
    if ((i + 1) % 5 === 0 || i === work.length - 1) {
      fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    }
  }

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  console.log(`\n[delete-cuotas-dupes] Completado`);
  console.log(`  Eliminados: ${stats.deleted}`);
  console.log(`  No encontrados (ya eliminados): ${stats.notFound}`);
  console.log(`  Errores: ${stats.errors}`);
  console.log(`  Resultados en data/delete-cuotas-results.json`);
  console.log(`  Revisión manual en data/delete-cuotas-needs-review.json`);
}

main().catch(err => {
  console.error('[delete-cuotas-dupes] Error fatal:', err.message);
  process.exit(1);
});
