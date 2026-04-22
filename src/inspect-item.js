require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const BASE_URL = 'https://api.mercadolibre.com';
const token = process.env.ML_ACCESS_TOKEN;
const userId = process.env.ML_USER_ID;

async function main() {
  const targetId = process.argv[2]; // opcional: node inspect-item.js MLA123456

  let itemId = targetId;

  if (!itemId) {
    // Busca el primer item que tenga variaciones
    console.log('Buscando item con variaciones...');
    let scrollId = null;
    let found = false;

    const first = await axios.get(`${BASE_URL}/users/${userId}/items/search`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { search_type: 'scan' },
    });

    let ids = first.data.results ?? [];
    scrollId = first.data.scroll_id;

    while (!found) {
      // Busca en lote de 20
      const batch = ids.splice(0, 20);
      if (batch.length === 0) {
        if (!scrollId) break;
        const next = await axios.get(`${BASE_URL}/users/${userId}/items/search`, {
          headers: { Authorization: `Bearer ${token}` },
          params: { search_type: 'scan', scroll_id: scrollId },
        });
        ids = next.data.results ?? [];
        scrollId = next.data.scroll_id || null;
        continue;
      }

      const res = await axios.get(`${BASE_URL}/items`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { ids: batch.join(',') },
      });

      for (const r of res.data) {
        if (r.code === 200 && r.body.variations?.length > 0) {
          itemId = r.body.id;
          found = true;
          break;
        }
      }
    }

    if (!itemId) {
      console.log('No se encontró ningún item con variaciones.');
      return;
    }
  }

  console.log(`\nInspeccionando item: ${itemId}\n`);

  // Trae el detalle completo
  const { data: item } = await axios.get(`${BASE_URL}/items/${itemId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  // Muestra solo las variaciones (para no llenar la pantalla)
  if (process.argv.includes('--full')) {
    console.log('=== ITEM COMPLETO ===');
    console.log(JSON.stringify(item, null, 2));
  } else {
    console.log('=== ITEM (campos principales) ===');
    const { id, title, price, available_quantity, status, variations, attributes, pictures } = item;
    console.log(JSON.stringify({ id, title, price, available_quantity, status }, null, 2));

    console.log(`\n=== PICTURES (${pictures?.length ?? 0}) ===`);
    console.log(JSON.stringify(pictures?.slice(0, 2), null, 2));

    console.log(`\n=== ATTRIBUTES (${attributes?.length ?? 0}) ===`);
    console.log(JSON.stringify(attributes?.slice(0, 3), null, 2));

    console.log(`\n=== VARIATIONS (${variations?.length ?? 0}) ===`);
    console.log(JSON.stringify(variations, null, 2));
  }
}

main().catch(console.error);
