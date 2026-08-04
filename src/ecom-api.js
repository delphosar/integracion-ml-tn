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

// Busca el listing de EcomExperts para un producto TiendaNube.
// Retorna { id } o null si EcomExperts todavía no lo descubrió.
async function getListingByTnProduct(tnProductId) {
  try {
    const result = await graphql(`{
      listings {
        readByChannel(owner: tiendanube, productId: "${tnProductId}") {
          id
        }
      }
    }`);
    const arr = result?.listings?.readByChannel;
    return arr?.[0] ?? null;
  } catch {
    // EcomExperts puede lanzar error si el listing no existe aún
    return null;
  }
}

// Regla de sincronización de stock Tienda Nube (id fijo para esta cuenta)
const TN_STOCK_RULE_ID = '4129';

// Obtiene los productos ERP vinculados a un item ML en EcomExperts.
// Retorna { nubeMlId, erpLinks: [{ productId, qty, variantId? }] }
async function getMlListingProducts(mlItemId) {
  const result = await graphql(`{
    mlListings {
      read(id: "${mlItemId}") {
        id
        productListings {
          product { id }
          productVariantListings {
            ownerId
            variant { id }
          }
        }
      }
    }
  }`);

  const nubeMlId  = result?.mlListings?.read?.id ?? null;
  const prodListings = result?.mlListings?.read?.productListings ?? [];
  const erpLinks = [];

  for (const pl of prodListings) {
    const productId = pl.product?.id;
    if (!productId) continue;
    const variantListings = pl.productVariantListings ?? [];
    if (variantListings.length === 0) {
      erpLinks.push({ productId, qty: 1 });
    } else {
      for (const vl of variantListings) {
        if (vl.variant?.id) {
          erpLinks.push({ productId, qty: 1, variantId: vl.variant.id });
        }
      }
    }
  }

  return { nubeMlId, erpLinks };
}

// Asigna la regla de sincronización de stock TN y la aplica al listing.
async function assignAndApplyStockRule(nubeMlId) {
  await graphql(`
    mutation {
      mtListings {
        asignateListingRule(input: { mtListingId: "${nubeMlId}", mtListingRuleId: "${TN_STOCK_RULE_ID}" }) { id }
      }
    }
  `);
  await graphql(`
    mutation {
      mtListings {
        applyStockRuleToListing(id: "${nubeMlId}") { id }
      }
    }
  `);
}

// Vincula un listing de EcomExperts (TN) a productos ERP.
// productLinks: [{ productId, qty, variantId? }]
async function linkListingToErp(listingId, productLinks) {
  const innerItems = productLinks
    .map(p =>
      p.variantId
        ? `{ productId: ${p.productId}, qty: ${p.qty}, variantId: ${p.variantId} }`
        : `{ productId: ${p.productId}, qty: ${p.qty} }`
    )
    .join(', ');

  return graphql(`
    mutation {
      listings {
        link(id: ${listingId}, input: [{ productListing: [${innerItems}] }])
      }
    }
  `);
}

module.exports = { graphql, findVariantBySku, updateStock, getListingByTnProduct, getMlListingProducts, linkListingToErp, assignAndApplyStockRule };
