/**
 * fix-skus-nodb.js
 *
 * Para los productos de TN que tienen un ML ID como SKU (ej: "MLA3164701388")
 * en lugar del SKU del ERP, este script:
 *   1. Consulta EcomExperts para obtener el SKU ERP de cada ML ID
 *   2. Actualiza la variante de TN con el SKU ERP correcto
 *
 * Una vez actualizado el SKU en TN, hay que re-correr "Vincular Productos
 * Existentes" en el admin de EcomExperts para que los asocie automáticamente.
 *
 * Uso:
 *   node src/fix-skus-nodb.js [--dry-run] [--limit=N] [--resume]
 *
 * Input:  ../publis-sin-articulo-asociado.xlsx  (export de EcomExperts)
 * Output: ../data/fix-skus-nodb-results.json
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const fs   = require('fs');
const XLSX = require('xlsx');
const initSqlJs = require('sql.js');
const { graphql } = require('./ecom-api');
const tnApi = require('./tn-api');

const DRY_RUN  = process.argv.includes('--dry-run');
const RESUME   = process.argv.includes('--resume');
const LIMIT    = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0', 10) || null;
const DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '400', 10);
const RESULTS_PATH = path.join(__dirname, '..', 'data', 'fix-skus-nodb-results.json');
const EXCEL_PATH   = path.join(__dirname, '..', '..', 'publis-sin-articulo-asociado.xlsx');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Consulta EcomExperts para obtener el SKU de la VARIANTE ERP de un ML item ID.
// Usa productVariantId para encontrar el SKU exacto de la variante (no del producto padre).
// Retorna string con el SKU o null si no se encuentra.
async function getErpSkuFromMl(mlId) {
  const result = await graphql(`{
    mlListings {
      find(page: 1, searchTerm: { value: "${mlId}" }) {
        data {
          id ownerId
          productListings {
            id
            productVariantId
            product { sku variants { id sku } }
          }
        }
      }
    }
  }`);
  const items = result?.mlListings?.find?.data ?? [];
  for (const item of items) {
    if (item.ownerId !== mlId) continue;
    const pl = item.productListings?.[0];
    if (!pl) continue;

    // Preferir el SKU de la variante específica (productVariantId)
    if (pl.productVariantId && pl.product?.variants?.length) {
      const variant = pl.product.variants.find(v => String(v.id) === String(pl.productVariantId));
      if (variant?.sku) return variant.sku;
    }

    // Fallback: SKU del producto si no hay variante específica
    if (pl.product?.sku) return pl.product.sku;
  }
  return null;
}

async function main() {
  console.log(`[fix-skus-nodb] Iniciando${DRY_RUN ? ' (DRY RUN)' : ''}${RESUME ? ' (RESUME)' : ''}${LIMIT ? ` (limit ${LIMIT})` : ''}...`);
  const started = Date.now();

  // --- Leer Excel ---
  if (!fs.existsSync(EXCEL_PATH)) {
    console.error(`No se encontró el archivo: ${EXCEL_PATH}`);
    process.exit(1);
  }
  const wb = XLSX.readFile(EXCEL_PATH);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  const excelData = rows.slice(2).filter(r => r.__EMPTY && typeof r.__EMPTY === 'number');
  console.log(`  ${excelData.length} publicaciones en el Excel`);

  // --- Cargar DB para identificar los que ya están en nuestra DB ---
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(path.join(__dirname, '..', 'data', 'ml_products.db')));

  // Filtrar: solo los NO en nuestra DB (los nuevos con ML ID como SKU)
  // Y que sean "simples" (un solo ML ID, sin sufijo de variación)
  const targets = excelData
    .map(row => ({ tnId: String(row.__EMPTY), titulo: row.__EMPTY_2 }))
    .filter(({ tnId }) => {
      const r = db.exec('SELECT 1 FROM tn_products WHERE tn_product_id = ?', [tnId]);
      return !r[0]?.values?.length; // no están en nuestra DB
    });

  console.log(`  ${targets.length} sin DB (candidatos)`);

  // --- Resume: cargar resultados anteriores ---
  const SKIP_STATUSES = new Set(['updated', 'no-erp-sku', 'not-simple', 'not-found']);
  const prevResults = RESUME && fs.existsSync(RESULTS_PATH)
    ? JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'))
    : [];
  const doneTnIds = new Set(prevResults.filter(r => SKIP_STATUSES.has(r.status)).map(r => r.tnId));

  let work = RESUME ? targets.filter(t => !doneTnIds.has(t.tnId)) : targets;
  if (RESUME) console.log(`  Resume: ${doneTnIds.size} saltados, quedan ${work.length}`);
  if (LIMIT) work = work.slice(0, LIMIT);

  console.log(`  ${work.length} a procesar\n`);

  const results = RESUME ? [...prevResults.filter(r => SKIP_STATUSES.has(r.status))] : [];
  const stats = { updated: 0, noErpSku: 0, notSimple: 0, notFound: 0, errors: 0 };

  for (let i = 0; i < work.length; i++) {
    const { tnId, titulo } = work[i];

    // Obtener TN product para verificar el SKU actual
    let tnProduct;
    try {
      tnProduct = await tnApi.getProduct(tnId);
      await sleep(DELAY_MS);
    } catch (err) {
      if (err.response?.status === 404) {
        stats.notFound++;
        results.push({ tnId, status: 'not-found' });
        continue;
      }
      console.error(`\n  Error al obtener TN ${tnId}: ${err.message}`);
      stats.errors++;
      results.push({ tnId, status: 'error', error: err.message });
      continue;
    }

    const variants = tnProduct.variants ?? [];

    // Verificar que sea un producto "simple" (todos los SKUs = ML ID sin sufijo de variación)
    const mlIds = [...new Set(variants.map(v => v.sku).filter(s => s?.match(/^MLA\d+$/)))];
    const hasVariationSuffix = variants.some(v => v.sku?.match(/^MLA\d+-\d+$/));

    if (hasVariationSuffix || mlIds.length === 0) {
      stats.notSimple++;
      results.push({ tnId, titulo: titulo.substring(0, 50), status: 'not-simple', skus: variants.map(v => v.sku) });
      continue;
    }

    const mlId = mlIds[0]; // debe haber solo uno para simples

    // Consultar EcomExperts para obtener el ERP SKU
    let erpSku;
    try {
      erpSku = await getErpSkuFromMl(mlId);
      await sleep(DELAY_MS);
    } catch (err) {
      console.error(`\n  Error EcomExperts para ${mlId}: ${err.message}`);
      stats.errors++;
      results.push({ tnId, mlId, status: 'error', error: err.message });
      continue;
    }

    if (!erpSku) {
      stats.noErpSku++;
      results.push({ tnId, mlId, titulo: titulo.substring(0, 50), status: 'no-erp-sku' });
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY] TN:${tnId} | ${mlId} → "${erpSku}" | ${titulo.substring(0, 40)}`);
      stats.updated++;
      results.push({ tnId, mlId, erpSku, titulo: titulo.substring(0, 50), status: 'dry-run' });
      continue;
    }

    // Actualizar todas las variantes del producto con el nuevo SKU
    // (para simples hay solo 1 variante)
    let ok = true;
    for (const variant of variants) {
      try {
        await tnApi.updateVariant(tnId, variant.id, { sku: erpSku });
        await sleep(DELAY_MS);
      } catch (err) {
        const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        console.error(`\n  Error actualizando variante TN ${tnId}/${variant.id}: ${detail}`);
        stats.errors++;
        results.push({ tnId, mlId, erpSku, status: 'error', error: detail });
        ok = false;
        break;
      }
    }

    if (ok) {
      stats.updated++;
      results.push({ tnId, mlId, erpSku, titulo: titulo.substring(0, 50), status: 'updated' });
    }

    if ((i + 1) % 10 === 0 || i === work.length - 1) {
      process.stdout.write(`\r  Progreso: ${i + 1} / ${work.length}  `);
      if (!DRY_RUN) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
    }
  }

  if (!DRY_RUN) fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n\n[fix-skus-nodb] Completado en ${elapsed}s`);
  console.log(`  Actualizados: ${stats.updated} | Sin SKU ERP: ${stats.noErpSku} | Multi-variante (salteado): ${stats.notSimple} | No encontrados: ${stats.notFound} | Errores: ${stats.errors}`);
  if (!DRY_RUN) console.log(`  Resultados en data/fix-skus-nodb-results.json`);
  console.log(`\n  PRÓXIMO PASO: re-correr "Vincular Productos Existentes" en el admin de EcomExperts.`);
}

main().catch(err => {
  console.error('[fix-skus-nodb] Error fatal:', err.message);
  process.exit(1);
});
