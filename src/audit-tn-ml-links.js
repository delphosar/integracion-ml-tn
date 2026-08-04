/**
 * audit-tn-ml-links.js
 *
 * Audita TODAS las publicaciones de TiendaNube y verifica si tienen un MLA
 * válido y activo asociado.
 *
 * Fuentes de mapeo TN → ML (en orden de prioridad):
 *   1. Tabla tn_products en SQLite (productos migrados por nosotros)
 *   2. SKU de variante en formato MLA (productos vinculados via EcomExperts)
 *
 * Categorías de resultado:
 *   ok_active    – ML existe y está activo
 *   ok_paused    – ML existe pero está pausado/cerrado (sync ignorado)
 *   ml_not_found – Tiene ID de ML pero retorna 404 (publicación eliminada)
 *   no_ml_id     – No se encontró ningún ML ID → necesita revisión manual
 *
 * Uso:
 *   node src/audit-tn-ml-links.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path  = require('path');
const fs    = require('fs');
const axios = require('axios');
const { getDb }         = require('./db');
const { getValidToken } = require('./ml-auth');
const { fetchItemsBatch } = require('./ml-api');

const TN_DELAY_MS = 1200;   // entre requests TN (safe para rate limit)
const ML_DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const ML_BATCH    = 20;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extrae el ML item ID de un SKU de variante TN.
// Formatos: "MLA123456" o "MLA123456-9876543"  o  "MLA123456-9876543-attr"
function mlIdFromSku(sku) {
  if (!sku) return null;
  const m = sku.match(/^(MLA\d+)(-\d+)?/);
  return m ? m[1] : null;
}

// ─── TN: obtener todos los productos paginado ──────────────────────────────
async function getAllTnProducts() {
  const BASE = 'https://api.tiendanube.com/v1';
  const storeId = process.env.TN_STORE_ID;
  const headers = {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'User-Agent': process.env.TN_USER_AGENT ?? 'ML-TN-Sync (dev)',
  };

  const all = [];
  let page = 1;

  while (true) {
    const { data } = await axios.get(`${BASE}/${storeId}/products`, {
      headers,
      params: { per_page: 200, page },
    });
    all.push(...data);
    process.stdout.write(`\r  TN productos obtenidos: ${all.length}  `);
    if (data.length < 200) break;
    page++;
    await sleep(TN_DELAY_MS);
  }
  console.log();
  return all;
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('[audit-tn-ml-links] Iniciando...');

  const token = await getValidToken();
  const db    = await getDb();

  // 1. Cargar mapa de tn_products desde SQLite
  const dbMapRes = db.exec(`SELECT tn_product_id, ml_item_id FROM tn_products`);
  const dbMap = new Map(); // tn_product_id (string) → ml_item_id
  for (const [tnId, mlId] of (dbMapRes[0]?.values ?? [])) {
    dbMap.set(String(tnId), mlId);
  }
  console.log(`  DB: ${dbMap.size} entradas en tn_products`);

  // 2. Obtener todos los productos TN
  console.log('\n  Obteniendo productos de TiendaNube...');
  const tnProducts = await getAllTnProducts();
  console.log(`  Total TN productos: ${tnProducts.length}`);

  // 3. Para cada TN product, determinar su ML ID
  const items = []; // { tnId, tnName, mlId, source, skuFound }

  for (const p of tnProducts) {
    const tnId = String(p.id);
    const tnName = p.name?.es ?? p.name ?? '(sin nombre)';

    let mlId   = null;
    let source = null;
    let skuFound = null;

    // Prioridad 1: nuestro DB
    if (dbMap.has(tnId)) {
      mlId   = dbMap.get(tnId);
      source = 'db';
    } else {
      // Prioridad 2: SKU de variante en formato MLA
      for (const v of p.variants ?? []) {
        const id = mlIdFromSku(v.sku);
        if (id) {
          mlId     = id;
          source   = 'sku';
          skuFound = v.sku;
          break;
        }
      }
    }

    items.push({ tnId, tnName, mlId, source, skuFound });
  }

  const withMlId    = items.filter(x => x.mlId);
  const withoutMlId = items.filter(x => !x.mlId);
  console.log(`\n  Con ML ID identificado: ${withMlId.length}`);
  console.log(`  Sin ML ID:              ${withoutMlId.length}`);

  // 4. Batch-verificar todos los ML IDs contra la API
  console.log('\n  Verificando ML IDs contra la API de ML...');
  const mlStatusMap = new Map(); // mlId → { status, title }

  const uniqueMlIds = [...new Set(withMlId.map(x => x.mlId))];
  console.log(`  ML IDs únicos a verificar: ${uniqueMlIds.length}`);

  for (let i = 0; i < uniqueMlIds.length; i += ML_BATCH) {
    const batch = uniqueMlIds.slice(i, i + ML_BATCH);
    try {
      const results = await fetchItemsBatch(batch, token);
      await sleep(ML_DELAY_MS);
      for (let j = 0; j < results.length; j++) {
        const { code, body } = results[j];
        const mlId = (code === 200 && body?.id) ? body.id : batch[j];
        if (code === 200 && body?.id) {
          mlStatusMap.set(mlId, { status: body.status, title: body.title });
        } else {
          mlStatusMap.set(mlId, { status: 'not_found', title: null });
        }
      }
    } catch (err) {
      console.error(`\n  Error batch ML [${i}]: ${err.message}`);
      batch.forEach(id => mlStatusMap.set(id, { status: 'error', title: null }));
    }
    process.stdout.write(`\r  ML verificados: ${Math.min(i + ML_BATCH, uniqueMlIds.length)} / ${uniqueMlIds.length}  `);
  }
  console.log();

  // 5. Clasificar resultados
  const report = {
    timestamp:    new Date().toISOString(),
    total:        tnProducts.length,
    summary:      {},
    ok_active:    [],
    ok_paused:    [],
    ml_not_found: [],
    no_ml_id:     [],
  };

  for (const item of items) {
    if (!item.mlId) {
      report.no_ml_id.push({
        tnId:   item.tnId,
        tnName: item.tnName,
        skus:   (tnProducts.find(p => String(p.id) === item.tnId)?.variants ?? []).map(v => v.sku).filter(Boolean),
      });
      continue;
    }

    const ml = mlStatusMap.get(item.mlId);
    const entry = {
      tnId:    item.tnId,
      tnName:  item.tnName,
      mlId:    item.mlId,
      source:  item.source,
      skuFound: item.skuFound,
      mlStatus: ml?.status,
      mlTitle:  ml?.title,
    };

    if (!ml || ml.status === 'not_found' || ml.status === 'error') {
      report.ml_not_found.push(entry);
    } else if (ml.status === 'active') {
      report.ok_active.push(entry);
    } else {
      // paused, closed, inactive, under_review
      report.ok_paused.push(entry);
    }
  }

  report.summary = {
    total:        report.total,
    ok_active:    report.ok_active.length,
    ok_paused:    report.ok_paused.length,
    ml_not_found: report.ml_not_found.length,
    no_ml_id:     report.no_ml_id.length,
  };

  // 6. Output
  console.log('\n[audit-tn-ml-links] Resultado:');
  console.log(`  Total publicaciones TN:          ${report.summary.total}`);
  console.log(`  ✓ Con MLA activo:                ${report.summary.ok_active}`);
  console.log(`  ~ Con MLA pausado/cerrado:       ${report.summary.ok_paused}`);
  console.log(`  ✗ MLA no encontrado (404/error): ${report.summary.ml_not_found}`);
  console.log(`  ? Sin ningún ML ID:              ${report.summary.no_ml_id}`);

  if (report.no_ml_id.length > 0) {
    console.log('\n  [SIN ML ID] — necesitan revisión:');
    report.no_ml_id.forEach(x => {
      const skuStr = x.skus.length ? ' | skus: ' + x.skus.join(', ') : ' | (sin skus)';
      console.log(`    TN:${x.tnId}  "${x.tnName.substring(0, 50)}"${skuStr}`);
    });
  }

  if (report.ml_not_found.length > 0) {
    console.log('\n  [MLA NO ENCONTRADO] — MLA borrado o inválido:');
    report.ml_not_found.forEach(x => {
      console.log(`    TN:${x.tnId}  ML:${x.mlId}  "${x.tnName.substring(0, 40)}"  [${x.source}]`);
    });
  }

  const outFile = path.join(__dirname, '..', 'data', 'audit-tn-ml-links.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(`\n  Reporte completo guardado en: data/audit-tn-ml-links.json`);
}

main().catch(err => {
  console.error('[audit-tn-ml-links] Error fatal:', err.message);
  process.exit(1);
});
