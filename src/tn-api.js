const axios = require('axios');

const BASE_URL = 'https://api.tiendanube.com/v1';

function getHeaders() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'User-Agent': process.env.TN_USER_AGENT ?? 'ML-TN-Sync (dev)',
    'Content-Type': 'application/json',
  };
}

const storeId = () => process.env.TN_STORE_ID;

async function createProduct(payload) {
  const { data } = await axios.post(
    `${BASE_URL}/${storeId()}/products`,
    payload,
    { headers: getHeaders() }
  );
  return data;
}

async function updateProduct(tnProductId, payload) {
  const { data } = await axios.put(
    `${BASE_URL}/${storeId()}/products/${tnProductId}`,
    payload,
    { headers: getHeaders() }
  );
  return data;
}

async function getProductBySku(sku) {
  const { data } = await axios.get(
    `${BASE_URL}/${storeId()}/products`,
    { headers: getHeaders(), params: { q: sku } }
  );
  // Busca match exacto de SKU en las variants
  for (const product of data) {
    for (const variant of product.variants ?? []) {
      if (variant.sku === sku) return product;
    }
  }
  return null;
}

async function getCategories() {
  const { data } = await axios.get(
    `${BASE_URL}/${storeId()}/categories`,
    { headers: getHeaders() }
  );
  return data;
}

async function createCategory(name) {
  const { data } = await axios.post(
    `${BASE_URL}/${storeId()}/categories`,
    { name: { es: name } },
    { headers: getHeaders() }
  );
  return data;
}

async function updateProductCategories(tnProductId, categoryIds) {
  const { data } = await axios.put(
    `${BASE_URL}/${storeId()}/products/${tnProductId}`,
    { categories: categoryIds.map((id) => parseInt(id, 10)) },
    { headers: getHeaders() }
  );
  return data;
}

async function updateVariant(tnProductId, variantId, payload) {
  const { data } = await axios.put(
    `${BASE_URL}/${storeId()}/products/${tnProductId}/variants/${variantId}`,
    payload,
    { headers: getHeaders() }
  );
  return data;
}

async function getProduct(tnProductId) {
  const { data } = await axios.get(
    `${BASE_URL}/${storeId()}/products/${tnProductId}`,
    { headers: getHeaders() }
  );
  return data;
}

async function getOrder(orderId) {
  const { data } = await axios.get(
    `${BASE_URL}/${storeId()}/orders/${orderId}`,
    { headers: getHeaders() }
  );
  return data;
}

async function createMetafield(productId, key, value) {
  const { data } = await axios.post(
    `${BASE_URL}/${storeId()}/products/${productId}/metafields`,
    { namespace: 'ml_sync', key, value, description: key },
    { headers: getHeaders() }
  );
  return data;
}

async function deleteProduct(tnProductId) {
  await axios.delete(
    `${BASE_URL}/${storeId()}/products/${tnProductId}`,
    { headers: getHeaders() }
  );
}

module.exports = { createProduct, updateProduct, getProduct, deleteProduct, getOrder, updateVariant, getProductBySku, createMetafield, getCategories, createCategory, updateProductCategories };
