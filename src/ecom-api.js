require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { getValidCookie } = require('./ecom-auth');

const GRAPHQL_URL = 'https://api.ecomexperts.com/graphql';
const WAREHOUSE = 'Herrera';

async function graphql(query) {
  const cookie = await getValidCookie();
  const { data } = await axios.post(
    GRAPHQL_URL,
    { query },
    { headers: { 'Content-Type': 'application/json', Cookie: cookie } }
  );
  if (data.errors?.length) {
    throw new Error(`[ecom-api] GraphQL error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

// Busca un variant por SKU en EcomExperts.
// Retorna { productId, variantId, currentQty } o null si no se encuentra.
// Siempre hace consulta fresca para obtener qty actual.
async function findVariantBySku(sku) {
  const escapedSku = sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const result = await graphql(`{
    products {
      search(sku: "${escapedSku}") {
        data {
          id
          variants {
            id
            sku
            variantWarehouses {
              warehouse_title
              warehouse_qty
            }
          }
        }
      }
    }
  }`);

  const products = result?.products?.search?.data ?? [];
  for (const product of products) {
    for (const variant of product.variants ?? []) {
      if (variant.sku === sku) {
        const wh = (variant.variantWarehouses ?? []).find(w => w.warehouse_title === WAREHOUSE);
        return {
          productId: product.id,
          variantId: variant.id,
          currentQty: wh?.warehouse_qty ?? 0,
        };
      }
    }
  }
  return null;
}

// Actualiza el stock en warehouse "Herrera" para un variant.
async function updateStock(productId, variantId, newQty) {
  return graphql(`
    mutation {
      products {
        update(id: ${productId}, input: {
          variants: [{
            id: ${variantId},
            variantWarehouses: [{
              warehouse_title: "${WAREHOUSE}",
              warehouse_qty: ${newQty}
            }]
          }]
        }) {
          id
          variants {
            id
            variantWarehouses {
              warehouse_title
              warehouse_qty
            }
          }
        }
      }
    }
  `);
}

module.exports = { graphql, findVariantBySku, updateStock };
