/**
 * ecom-explore.js — Explora el schema GraphQL de EcomExperts.
 *
 * Modos de uso:
 *   node src/ecom-explore.js --schema              → introspección de tipos
 *   node src/ecom-explore.js --products            → primera página de productos ERP
 *   node src/ecom-explore.js --products --all      → todos los productos paginado
 *   node src/ecom-explore.js --ml-listings         → mlListings con paginación (todos)
 *   node src/ecom-explore.js --nube-listings       → nubeListings/nubeMlListings con variantLinks
 *   node src/ecom-explore.js --channels            → explora canales/integraciones
 *   node src/ecom-explore.js --sample <id>         → detalle de un producto por ID
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const { graphql } = require('./ecom-api');
const { getDb } = require('./db');

const OUT_DIR = path.join(__dirname, '..', 'data');

function save(filename, data) {
  const file = path.join(OUT_DIR, filename);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  console.log(`[saved] ${file}`);
}

// pageInfo fields correctos (de schema)
const PAGE_INFO = `pageInfo { page pageCount nextPage count limit }`;

// ─────────────────────────────────────────────
// 1. INTROSPECCIÓN — tipos del schema
// ─────────────────────────────────────────────
async function exploreSchema() {
  console.log('\n=== Introspección del schema ===');
  const result = await graphql(`{
    __schema {
      types {
        name
        kind
        fields {
          name
          type { name kind ofType { name kind } }
        }
      }
    }
  }`);

  const types = (result.__schema.types ?? [])
    .filter(t => !t.name.startsWith('__'))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(`\nTipos encontrados (${types.length}):`);
  for (const t of types) {
    const fields = (t.fields ?? []).map(f => f.name).join(', ');
    console.log(`  [${t.kind}] ${t.name}${fields ? ': ' + fields : ''}`);
  }

  save('ecom-schema.json', types);
}

// ─────────────────────────────────────────────
// 2. VARIANTES ERP — todas las páginas (variants.find)
// ─────────────────────────────────────────────
async function fetchProducts(all = false) {
  console.log(`\n=== Variantes ERP (${all ? 'todas paginado' : 'primera página'}) ===`);

  let page = 1;
  const allVariants = [];

  do {
    const pageArg = `(page: ${page})`;
    const result = await graphql(`{
      variants {
        find${pageArg} {
          ${PAGE_INFO}
          data {
            id
            sku
            variantAttributes { name options }
            product { id title sku }
          }
        }
      }
    }`);

    const find = result?.variants?.find;
    if (!find?.data?.length) { console.log('Sin datos'); break; }

    const pi = find.pageInfo ?? {};
    console.log(`  Página ${pi.page}/${pi.pageCount} — ${find.data.length} variantes (total: ${pi.count})`);
    allVariants.push(...find.data);

    if (!all || !pi.nextPage) break;
    page++;
  } while (true);

  console.log(`\nTotal obtenidos: ${allVariants.length}`);
  allVariants.slice(0, 3).forEach(v => {
    const attrs = (v.variantAttributes ?? []).map(a => `${a.name}:${a.options}`).join(', ');
    console.log(`  variant ${v.id} | SKU: ${v.sku} | product ${v.product?.id} | attrs: ${attrs}`);
  });

  if (all) save('ecom-variants.json', allVariants);
}

// ─────────────────────────────────────────────
// 3. DETALLE de un producto por ID
// ─────────────────────────────────────────────
async function fetchProductDetail(id) {
  console.log(`\n=== Detalle del producto ID ${id} ===`);
  const result = await graphql(`{
    products {
      find(id: ${id}) {
        id name sku
        variants {
          id sku
          variantAttributes { attribute_title attribute_value }
          variantWarehouses { warehouse_title warehouse_qty }
        }
      }
    }
  }`);

  const product = result?.products?.find;
  if (!product) { console.log('Producto no encontrado'); return; }
  console.log(JSON.stringify(product, null, 2));
  save(`ecom-product-${id}.json`, product);
}

// ─────────────────────────────────────────────
// 4. ML LISTINGS — todas las páginas
// ─────────────────────────────────────────────
async function fetchMlListings() {
  console.log('\n=== ML Listings (todas las páginas) ===');

  // Primero prueba si find acepta arg page
  let usesPageArg = false;
  try {
    const test = await graphql(`{ mlListings { find(page: 1) { ${PAGE_INFO} } } }`);
    usesPageArg = true;
    console.log('  find acepta arg page ✓');
    const pi = test?.mlListings?.find?.pageInfo;
    if (pi) console.log(`  pageInfo: page=${pi.page} pageCount=${pi.pageCount} count=${pi.count} limit=${pi.limit}`);
  } catch (e) {
    console.log(`  find NO acepta arg page: ${e.message.slice(0, 100)}`);
  }

  const allListings = [];
  let page = 1;

  do {
    const pageArg = usesPageArg ? `(page: ${page})` : '';
    const result = await graphql(`{ mlListings { find${pageArg} {
      ${PAGE_INFO}
      data {
        id
        ownerId
        linked
        type
        productListings {
          productId
          productVariantId
          productVariantListings {
            productVariantId
            owner
            ownerId
          }
        }
      }
    } } }`);

    const find = result?.mlListings?.find;
    if (!find?.data?.length) { console.log('Sin datos'); break; }

    const pi = find.pageInfo ?? {};
    console.log(`  Página ${pi.page ?? page}/${pi.pageCount ?? '?'} — ${find.data.length} listings (total: ${pi.count ?? '?'})`);
    allListings.push(...find.data);

    if (!usesPageArg || !pi.nextPage) break;
    page++;
  } while (true);

  console.log(`\nTotal ML listings: ${allListings.length}`);
  const linked = allListings.filter(l => (l.productListings ?? []).length > 0);
  console.log(`Con productListings: ${linked.length}`);
  console.log(`\nEjemplos con productListings:`);
  linked.slice(0, 3).forEach(l => console.log(JSON.stringify(l, null, 2)));

  save('ecom-ml-listings-all.json', allListings);
}

// ─────────────────────────────────────────────
// 5. NUBE LISTINGS — TN ↔ ML con variantLinks.sku
// ─────────────────────────────────────────────
async function fetchNubeListings() {
  console.log('\n=== Nube Listings (nubeListings + nubeMlListings) ===');

  const queries = [
    {
      name: 'nubeListings.find (pageInfo)',
      query: `{ nubeListings { find { ${PAGE_INFO} } } }`,
    },
    {
      name: 'nubeListings.find (owner + listingLinks + variantLinks.sku)',
      query: `{ nubeListings { find {
        ${PAGE_INFO}
        data {
          id
          owner
          ownerId
          listingLinks {
            id
            listingIdSource
            listingIdTarget
            listingTarget { id owner ownerId }
            variantLinks {
              id
              ownerSource
              ownerSourceId
              ownerTarget
              ownerTargetId
              sku
            }
          }
        }
      } } }`,
    },
    {
      name: 'nubeMlListings.find (pageInfo)',
      query: `{ nubeMlListings { find { ${PAGE_INFO} } } }`,
    },
    {
      name: 'nubeMlListings.find (owner + listingLinks + variantLinks.sku)',
      query: `{ nubeMlListings { find {
        ${PAGE_INFO}
        data {
          id
          owner
          ownerId
          listingLinks {
            id
            listingIdSource
            listingIdTarget
            listingTarget { id owner ownerId }
            variantLinks {
              id
              ownerSource
              ownerSourceId
              ownerTarget
              ownerTargetId
              sku
            }
          }
        }
      } } }`,
    },
  ];

  const results = {};
  for (const { name, query } of queries) {
    try {
      const r = await graphql(query);
      const key = Object.keys(r)[0];
      const find = r?.[key]?.find;
      const pi = find?.pageInfo;
      console.log(`\n  ✓ ${name}`);
      if (pi) console.log(`    total: ${pi.count}, páginas: ${pi.pageCount}, limit: ${pi.limit}`);
      if (find?.data?.length) {
        console.log(JSON.stringify(find.data.slice(0, 2), null, 2));
      } else {
        console.log(JSON.stringify(r, null, 2).slice(0, 300));
      }
      results[name] = r;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message.slice(0, 200)}`);
    }
  }

  save('ecom-nube-listings.json', results);
}

// ─────────────────────────────────────────────
// 6. CANALES / INTEGRACIONES
// ─────────────────────────────────────────────
async function exploreChannels() {
  console.log('\n=== Explorando canales / integraciones ===');
  const queries = [
    { name: 'channels.list', query: `{ channels { list { data { id name } } } }` },
    { name: 'marketplaces.list', query: `{ marketplaces { list { data { id name } } } }` },
    { name: 'listings.find (pageInfo)', query: `{ listings { find { ${PAGE_INFO} } } }` },
  ];
  const results = {};
  for (const { name, query } of queries) {
    try {
      const r = await graphql(query);
      console.log(`  ✓ ${name}:`, JSON.stringify(r).slice(0, 200));
      results[name] = r;
    } catch (e) {
      console.log(`  ✗ ${name}: ${e.message.slice(0, 100)}`);
    }
  }
  save('ecom-channels.json', results);
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
(async () => {
  await getDb();
  const args = process.argv.slice(2);

  if (args.includes('--schema')) {
    await exploreSchema();
  } else if (args.includes('--products')) {
    await fetchProducts(args.includes('--all'));
  } else if (args.includes('--ml-listings')) {
    await fetchMlListings();
  } else if (args.includes('--nube-listings')) {
    await fetchNubeListings();
  } else if (args.includes('--channels')) {
    await exploreChannels();
  } else if (args.includes('--sample')) {
    const id = args[args.indexOf('--sample') + 1];
    if (!id) { console.error('Falta el ID. Usar: --sample <id>'); process.exit(1); }
    await fetchProductDetail(id);
  } else {
    console.log(`Uso:
  node src/ecom-explore.js --schema              → tipos del schema GraphQL
  node src/ecom-explore.js --products            → primera página de productos ERP
  node src/ecom-explore.js --products --all      → todos los productos paginado
  node src/ecom-explore.js --ml-listings         → todos los ML listings con paginación
  node src/ecom-explore.js --nube-listings       → nubeListings/nubeMlListings con variantLinks
  node src/ecom-explore.js --channels            → explora canales/integraciones
  node src/ecom-explore.js --sample <id>         → detalle de un producto
`);
  }
})().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
