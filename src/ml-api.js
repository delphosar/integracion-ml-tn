const axios = require('axios');

const BASE_URL = 'https://api.mercadolibre.com';
const DELAY_MS = parseInt(process.env.ML_REQUEST_DELAY_MS ?? '300', 10);
const BATCH_SIZE = parseInt(process.env.ML_BATCH_SIZE ?? '20', 10);

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.ML_ACCESS_TOKEN}`,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Obtiene TODOS los IDs de items del seller usando search_type=scan + scroll_id
async function getAllItemIds(userId) {
  const ids = [];

  // Primera llamada — inicia el scroll
  const first = await axios.get(
    `${BASE_URL}/users/${userId}/items/search`,
    { headers: getHeaders(), params: { search_type: 'scan' } }
  );

  const firstResults = first.data.results ?? [];
  ids.push(...firstResults);
  const total = first.data.paging?.total ?? 0;
  let scrollId = first.data.scroll_id;

  process.stdout.write(`\r  IDs obtenidos: ${ids.length} / ${total}`);

  // Páginas siguientes usando scroll_id
  while (scrollId && ids.length < total) {
    await sleep(DELAY_MS);

    const { data } = await axios.get(
      `${BASE_URL}/users/${userId}/items/search`,
      { headers: getHeaders(), params: { search_type: 'scan', scroll_id: scrollId } }
    );

    const results = data.results ?? [];
    if (results.length === 0) break;

    ids.push(...results);
    scrollId = data.scroll_id || null;

    process.stdout.write(`\r  IDs obtenidos: ${ids.length} / ${total}`);
  }

  console.log();
  return ids;
}

// Obtiene el detalle de un item individual
async function getItemDetail(itemId) {
  const { data } = await axios.get(`${BASE_URL}/items/${itemId}`, {
    headers: getHeaders(),
  });
  return data;
}

// Obtiene la descripción de un item
async function getItemDescription(itemId) {
  try {
    const { data } = await axios.get(
      `${BASE_URL}/items/${itemId}/description`,
      { headers: getHeaders() }
    );
    return data.plain_text ?? data.text ?? null;
  } catch {
    return null;
  }
}

// Obtiene todos los items de a uno (igual que el plugin PHP)
async function fetchAllItems(userId, { onBatch, withDescriptions = false } = {}) {
  console.log('Obteniendo IDs de items...');
  const allIds = await getAllItemIds(userId);
  const total = allIds.length;
  console.log(`Total de items encontrados: ${total}`);

  let processed = 0;

  for (const itemId of allIds) {
    try {
      const item = await getItemDetail(itemId);

      if (withDescriptions) {
        item._description = await getItemDescription(item.id);
        await sleep(DELAY_MS);
      }

      processed++;
      process.stdout.write(`\r  Detalles obtenidos: ${processed} / ${total}`);

      if (onBatch) await onBatch([item]);

    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.message ?? err.message ?? String(err);
      console.error(`\n  Error en item ${itemId} (HTTP ${status ?? '?'}): ${msg} — se saltea`);
    }

    await sleep(DELAY_MS);
  }

  console.log();
}

// Obtiene precio, stock y variaciones de hasta 20 items en un solo request
// Retorna array de { code, body } (body es el item si code=200)
async function fetchItemsBatch(ids, token) {
  const headers = token
    ? { Authorization: `Bearer ${token}` }
    : getHeaders();
  const { data } = await axios.get(`${BASE_URL}/items`, {
    headers,
    params: {
      ids: ids.join(','),
      attributes: 'id,price,original_price,available_quantity,variations,status',
    },
  });
  return data; // [{ code: 200, body: {...} }, ...]
}

// Obtiene todas las promociones activas de un item desde /seller-promotions
async function getItemPromotions(itemId, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : getHeaders();
  try {
    const { data } = await axios.get(
      `${BASE_URL}/seller-promotions/items/${itemId}?app_version=v2`,
      { headers }
    );
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

module.exports = { getAllItemIds, getItemDetail, getItemDescription, fetchAllItems, fetchItemsBatch, getItemPromotions };
