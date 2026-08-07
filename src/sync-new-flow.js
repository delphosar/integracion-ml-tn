/**
 * sync-new-flow.js
 *
 * Flujo semi-automático: detecta publis nuevas en ML y las replica en TN,
 * luego completa el vínculo con EcomExperts cuando este las descubre.
 *
 * Phase A — Detectar y crear en TN:
 *   1. Obtiene todos los IDs actuales de ML (scroll)
 *   2. Compara contra ml_items en DB → encuentra nuevos
 *   3. Para cada nuevo activo: crea en TN, guarda en tn_products con ecom_link_pending=1
 *
 * Phase B — Completar link EcomExperts:
 *   1. Busca items con ecom_link_pending=1
 *   2. Para cada uno: consulta si EcomExperts ya descubrió el producto TN
 *   3. Si sí: obtiene ERP IDs vía mlListings.read y ejecuta listings.link()
 *   4. Marca ecom_link_pending=0 al completar
 *
 * Flags:
 *   --dry-run      No crea nada en TN ni linkea en EcomExperts
 *   --skip-create  Salta Phase A (solo corre Phase B)
 *   --skip-link    Salta Phase B (solo corre Phase A)
 *   --limit=N      Máximo N items a crear en Phase A (default: 20)
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  getDb, upsertItem, saveToFile, rawQuery,
  saveTnProductPending, getPendingEcomLinks, markEcomLinked,
} = require('./db');
const { getValidToken }        = require('./ml-auth');
const { getAllItemIds, getItemDetail, getItemDescription, getItemPromotions } = require('./ml-api');
const { mapMlItemToTn }        = require('./ml-to-tn-mapper');
const tnApi                    = require('./tn-api');
const { getListingByTnProduct, getMlListingProducts, linkListingToErp, assignAndApplyStockRule } = require('./ecom-api');

const DRY_RUN     = process.argv.includes('--dry-run');
const SKIP_CREATE = process.argv.includes('--skip-create');
const SKIP_LINK   = process.argv.includes('--skip-link');
const LIMIT_ARG   = (process.argv.find(a => a.startsWith('--limit=')) ?? '').replace('--limit=', '');
const LIMIT       = LIMIT_ARG ? parseInt(LIMIT_ARG, 10) : 20;
const DELAY_MS    = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const TN_DELAY_MS = parseInt(process.env.TN_DELAY_MS ?? '1600', 10);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Sobreescribe price/original_price del item si hay una promo activa en ML
// (misma lógica que sync-delta — necesario para SMART/DEAL que no tocan el item directamente)
async function applyActivePromo(item) {
  const promos = await getItemPromotions(item.id, process.env.ML_ACCESS_TOKEN);
  await sleep(DELAY_MS);
  const activePromo = promos.find(p => p.status === 'started' && p.price > 0) ?? null;
  if (activePromo) {
    item.original_price = activePromo.original_price ?? item.price;
    item.price = activePromo.price;
    console.log(`    [PROMO:${activePromo.type}] price=${item.price} original=${item.original_price}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `[sync-new-flow] Iniciando` +
    `${DRY_RUN ? ' (DRY RUN)' : ''}` +
    `${SKIP_CREATE ? ' [--skip-create]' : ''}` +
    `${SKIP_LINK ? ' [--skip-link]' : ''}` +
    `...`
  );
  const started = Date.now();

  await getDb();

  // Obtener token fresco y asignarlo a process.env para que ml-api lo use
  const token = await getValidToken();
  process.env.ML_ACCESS_TOKEN = token;

  // ── Phase A ─────────────────────────────────────────────────────────────
  if (!SKIP_CREATE) {
    console.log('\n── Phase A: Detectar nuevos items ML y crear en TN ──');
    const statsA = await phaseA_DetectAndCreate();
    console.log(
      `   Resultado: ${statsA.created} creados | ${statsA.skipped} saltados | ${statsA.errors} errores`
    );

    console.log('\n── Phase A2: Re-chequear items conocidos sin TN (ahora con ref:sync) ──');
    const statsA2 = await phaseA2_RecheckExisting();
    console.log(
      `   Resultado: ${statsA2.created} creados | ${statsA2.skipped} sin ref:sync | ${statsA2.fetched} fetcheados desde ML | ${statsA2.errors} errores`
    );
  }

  // ── Phase B ─────────────────────────────────────────────────────────────
  if (!SKIP_LINK) {
    console.log('\n── Phase B: Completar links pendientes en EcomExperts ──');
    const statsB = await phaseB_LinkPendingEcom();
    console.log(
      `   Resultado: ${statsB.linked} linkeados | ${statsB.waiting} esperando EcomExperts | ${statsB.errors} errores`
    );
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`\n[sync-new-flow] Listo en ${elapsed}s`);
}

// ---------------------------------------------------------------------------
// Phase A
// ---------------------------------------------------------------------------

async function phaseA_DetectAndCreate() {
  const stats = { created: 0, skipped: 0, errors: 0 };

  // 1. IDs actuales en ML (scroll completo)
  console.log('  Obteniendo IDs desde ML API...');
  const allMlIds = await getAllItemIds(process.env.ML_USER_ID);

  // 2. IDs ya guardados en DB
  const dbRows = rawQuery(`SELECT id FROM ml_items`);
  const dbIds  = new Set(dbRows.map(r => r.id));

  const newIds = allMlIds.filter(id => !dbIds.has(id));
  console.log(
    `  ${allMlIds.length} en ML | ${dbIds.size} en DB | ${newIds.length} nuevos` +
    (newIds.length > LIMIT ? ` (procesando primeros ${LIMIT})` : '')
  );

  if (newIds.length === 0) return stats;

  const toProcess = newIds.slice(0, LIMIT);

  for (const mlId of toProcess) {
    try {
      // Fetch completo del item
      const item = await getItemDetail(mlId);
      await sleep(DELAY_MS);
      item._description = await getItemDescription(mlId);
      item.description  = item._description ?? '';
      await sleep(DELAY_MS);

      // Siempre guardar en ml_items (para no volver a detectarlo como nuevo)
      upsertItem(item);

      if (item.status !== 'active') {
        console.log(`  [SKIP] ${mlId} status=${item.status} — guardado en DB, no se crea en TN`);
        stats.skipped++;
        continue;
      }

      if (!item.description?.includes('ref:sync')) {
        console.log(`  [SKIP] ${mlId} sin marker "ref:sync" — no se crea en TN`);
        stats.skipped++;
        continue;
      }

      const varCount = item.variations?.length ?? 0;
      console.log(`  [NUEVO] ${mlId} "${item.title.slice(0, 60)}" (${varCount} variaciones)`);

      await applyActivePromo(item);
      const tnPayload = mapMlItemToTn(item);

      if (!DRY_RUN) {
        const tnProduct = await tnApi.createProduct(tnPayload);
        await sleep(TN_DELAY_MS);
        saveTnProductPending(mlId, String(tnProduct.id));
        console.log(`    → TN:${tnProduct.id} creado (ecom_link_pending=1)`);
      } else {
        console.log(`    → [DRY-RUN] crearía en TN`);
      }

      stats.created++;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`  [ERROR] ${mlId}: ${detail.slice(0, 250)}`);
      stats.errors++;
    }

    await sleep(DELAY_MS);
  }

  if (!DRY_RUN && stats.created > 0) saveToFile();
  return stats;
}

// ---------------------------------------------------------------------------
// Phase A2
// ---------------------------------------------------------------------------

async function phaseA2_RecheckExisting() {
  const stats = { created: 0, skipped: 0, fetched: 0, errors: 0 };

  // Items activos que ya están en ml_items pero NO en tn_products
  const candidates = rawQuery(`
    SELECT i.id, i.title
    FROM   ml_items i
    WHERE  i.status = 'active'
      AND  i.id NOT IN (SELECT ml_item_id FROM tn_products)
  `);

  console.log(`  ${candidates.length} items activos en DB sin TN product`);
  if (candidates.length === 0) return stats;

  // Siempre fetchear descripción desde ML API (nunca usar cache) para detectar
  // cuando el cliente agrega "ref:sync" a una publi existente.
  // Se aplica LIMIT para no saturar la API en cada run.
  const toProcess = candidates.slice(0, LIMIT);
  if (candidates.length > LIMIT) {
    console.log(`  Chequeando primeros ${LIMIT} de ${candidates.length} (aumentar --limit para más)`);
  }

  for (const row of toProcess) {
    try {
      const desc = await getItemDescription(row.id);
      await sleep(DELAY_MS);
      stats.fetched++;

      // Actualizar cache en DB con el valor fresco
      rawQuery(
        `UPDATE ml_items SET description = ? WHERE id = ?`,
        [desc ?? '', row.id]
      );

      if (!desc?.includes('ref:sync')) {
        stats.skipped++;
        continue;
      }
      await createInTn(row.id, stats);
      await sleep(TN_DELAY_MS);
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      console.error(`  [ERROR A2] ${row.id}: ${detail.slice(0, 250)}`);
      stats.errors++;
    }
  }

  if (!DRY_RUN && stats.created > 0) saveToFile();
  return stats;
}

async function createInTn(mlId, stats) {
  try {
    // Necesitamos el item completo para el mapper
    const item = await getItemDetail(mlId);
    await sleep(DELAY_MS);

    const varCount = item.variations?.length ?? 0;
    console.log(`  [A2-NUEVO] ${mlId} "${item.title.slice(0, 60)}" (${varCount} variaciones)`);

    await applyActivePromo(item);
    const tnPayload = mapMlItemToTn(item);

    if (!DRY_RUN) {
      const tnProduct = await tnApi.createProduct(tnPayload);
      saveTnProductPending(mlId, String(tnProduct.id));
      console.log(`    → TN:${tnProduct.id} creado (ecom_link_pending=1)`);
    } else {
      console.log(`    → [DRY-RUN] crearía en TN`);
    }
    stats.created++;
  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`  [ERROR A2] ${mlId}: ${detail.slice(0, 250)}`);
    stats.errors++;
  }
}

// ---------------------------------------------------------------------------
// Phase B
// ---------------------------------------------------------------------------

async function phaseB_LinkPendingEcom() {
  const stats = { linked: 0, waiting: 0, errors: 0 };

  const pending = getPendingEcomLinks();
  console.log(`  ${pending.length} items con link pendiente`);
  if (pending.length === 0) return stats;

  for (const { ml_item_id, tn_product_id } of pending) {
    try {
      await sleep(DELAY_MS);

      // ¿EcomExperts ya descubrió este producto TN?
      const listing = await getListingByTnProduct(tn_product_id);

      if (!listing?.id) {
        console.log(
          `  [WAITING] ${ml_item_id} → TN:${tn_product_id} — EcomExperts aún no sincronizó`
        );
        stats.waiting++;
        continue;
      }

      await sleep(DELAY_MS);

      // Obtener ERP products/variants y nubeMlId desde mlListings
      const { nubeMlId, erpLinks } = await getMlListingProducts(ml_item_id);
      await sleep(DELAY_MS);

      if (erpLinks.length === 0) {
        console.warn(
          `  [WARN] ${ml_item_id}: mlListings sin productos ERP — no se puede linkear`
        );
        stats.errors++;
        continue;
      }

      const erpSummary = erpLinks
        .map(l => `prod:${l.productId}${l.variantId ? `/var:${l.variantId}` : ''}`)
        .join(', ');

      if (!DRY_RUN) {
        await linkListingToErp(listing.id, erpLinks);
        await sleep(DELAY_MS);

        if (nubeMlId) {
          await assignAndApplyStockRule(nubeMlId);
          await sleep(DELAY_MS);
          console.log(
            `  [LINKED] ${ml_item_id} → TN:${tn_product_id} | listing:${listing.id} | erp:[${erpSummary}] | stock rule asignada`
          );
        } else {
          console.log(
            `  [LINKED] ${ml_item_id} → TN:${tn_product_id} | listing:${listing.id} | erp:[${erpSummary}] | ⚠ sin nubeMlId para stock rule`
          );
        }

        markEcomLinked(ml_item_id);
      } else {
        console.log(
          `  [DRY-RUN] ${ml_item_id} → linkearía listing:${listing.id} con [${erpSummary}] + stock rule`
        );
      }

      stats.linked++;
    } catch (err) {
      console.error(`  [ERROR] ${ml_item_id}: ${err.message.slice(0, 250)}`);
      stats.errors++;
    }
  }

  if (!DRY_RUN && stats.linked > 0) saveToFile();
  return stats;
}

// ---------------------------------------------------------------------------

main().catch(err => {
  console.error('[sync-new-flow] Error fatal:', err.message);
  process.exit(1);
});
