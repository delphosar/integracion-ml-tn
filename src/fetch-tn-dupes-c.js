/**
 * fetch-tn-dupes-c.js
 *
 * Descarga TODOS los productos activos de TiendaNube y detecta grupos
 * donde existe una versión "contado" y una versión "financiación" (título + " C").
 *
 * Guarda el reporte en data/tn-dupes-c.json para revisión manual.
 *
 * Uso: node src/fetch-tn-dupes-c.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const BASE_URL = 'https://api.tiendanube.com/v1';
const STORE_ID = process.env.TN_STORE_ID;
const DELAY_MS = 600;

const OUT_ALL   = path.join(__dirname, '..', 'data', 'tn-all-products.json');
const OUT_DUPES = path.join(__dirname, '..', 'data', 'tn-dupes-c.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function headers() {
  return {
    Authentication: `bearer ${process.env.TN_ACCESS_TOKEN}`,
    'User-Agent': process.env.TN_USER_AGENT ?? 'ML-TN-Sync (dev)',
  };
}

// Extrae nombre en español de la estructura { es: "...", pt: "...", en: "..." }
function getName(nameObj) {
  if (!nameObj) return '';
  if (typeof nameObj === 'string') return nameObj;
  return nameObj.es ?? nameObj.pt ?? nameObj.en ?? Object.values(nameObj)[0] ?? '';
}

// Patrón: título termina en " C" (una sola letra C al final, precedida de espacio)
const FINANCING_RE = /\s+C\s*$/;

function normalize(title) {
  return title.trim().replace(/\s+/g, ' ');
}

async function fetchAllProducts() {
  // Si ya tenemos el cache local, usarlo
  if (fs.existsSync(OUT_ALL)) {
    const cached = JSON.parse(fs.readFileSync(OUT_ALL, 'utf8'));
    console.log(`Cache encontrado: ${cached.length} productos (data/tn-all-products.json)`);
    return cached;
  }

  const all = [];
  let page = 1;
  const perPage = 200;

  console.log('Descargando todos los productos de TiendaNube...');

  while (true) {
    let resp;
    try {
      resp = await axios.get(`${BASE_URL}/${STORE_ID}/products`, {
        headers: headers(),
        params: { page, per_page: perPage, fields: 'id,name,variants' },
      });
    } catch (err) {
      console.error(`Error en página ${page}:`, err.response?.data ?? err.message);
      break;
    }

    const batch = resp.data;
    if (!batch || batch.length === 0) break;

    all.push(...batch);
    process.stdout.write(`  Página ${page}: ${batch.length} productos (total: ${all.length})\r`);

    if (batch.length < perPage) break;
    page++;
    await sleep(DELAY_MS);
  }

  console.log(`\nTotal descargado: ${all.length} productos`);
  fs.writeFileSync(OUT_ALL, JSON.stringify(all, null, 2));
  console.log(`Guardado en data/tn-all-products.json`);
  return all;
}

function buildGroups(products) {
  const byBase = {};

  for (const p of products) {
    const rawName = getName(p.name);
    const norm    = normalize(rawName);
    const isFinancing = FINANCING_RE.test(norm);
    const baseTitle   = isFinancing ? norm.replace(FINANCING_RE, '').trim() : norm;

    if (!byBase[baseTitle]) {
      byBase[baseTitle] = { cash: [], financing: [] };
    }

    const entry = {
      tn_product_id: String(p.id),
      title: norm,
      // SKU de la primera variante (si existe)
      sku: p.variants?.[0]?.sku ?? null,
      variant_count: p.variants?.length ?? 0,
    };

    if (isFinancing) {
      byBase[baseTitle].financing.push(entry);
    } else {
      byBase[baseTitle].cash.push(entry);
    }
  }

  // Solo grupos con AMBAS versiones
  const groups = [];
  for (const [base, g] of Object.entries(byBase)) {
    if (g.cash.length > 0 && g.financing.length > 0) {
      groups.push({
        base_title: base,
        cash: g.cash,
        financing: g.financing,
      });
    }
  }

  // Ordenar alfabéticamente
  groups.sort((a, b) => a.base_title.localeCompare(b.base_title, 'es'));
  return groups;
}

(async () => {
  console.log('\n=== fetch-tn-dupes-c ===\n');

  const products = await fetchAllProducts();
  const groups   = buildGroups(products);

  console.log(`\nGrupos con par contado/financiación: ${groups.length}`);

  fs.writeFileSync(OUT_DUPES, JSON.stringify(groups, null, 2));
  console.log(`Reporte guardado en data/tn-dupes-c.json`);

  // Resumen por consola
  console.log('\n--- Resumen ---');
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    console.log(`\n[${i + 1}/${groups.length}] ${g.base_title}`);
    for (const c of g.cash) {
      console.log(`  💵 CONTADO    TN:${c.tn_product_id}  SKU:${c.sku ?? '(sin sku)'}  "${c.title}"`);
    }
    for (const f of g.financing) {
      console.log(`  💳 FINANCIAC  TN:${f.tn_product_id}  SKU:${f.sku ?? '(sin sku)'}  "${f.title}"`);
    }
  }

  const totalFinancing = groups.reduce((s, g) => s + g.financing.length, 0);
  console.log(`\nTotal publicaciones a eliminar (financiación): ${totalFinancing}`);
  console.log('Revisá data/tn-dupes-c.json y ejecutá delete-financing-dupes.js para eliminarlas.');
})();
