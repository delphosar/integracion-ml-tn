require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');
const storeId = process.env.TN_STORE_ID;
const token = process.env.TN_ACCESS_TOKEN;
const headers = { Authentication: 'bearer ' + token, 'User-Agent': process.env.TN_USER_AGENT };

async function run() {
  let page = 1;
  let conDesc = 0, sinDesc = 0;
  const sinDescIds = [];

  while (true) {
    const { data } = await axios.get(
      `https://api.tiendanube.com/v1/${storeId}/products?per_page=200&page=${page}`,
      { headers }
    );
    if (!data.length) break;
    for (const p of data) {
      const desc = p.description?.es;
      if (desc && desc.trim().length > 0) {
        conDesc++;
      } else {
        sinDesc++;
        sinDescIds.push(p.id);
      }
    }
    console.log(`Página ${page}: ${data.length} prods | acum: ${conDesc} con desc, ${sinDesc} sin desc`);
    if (data.length < 200) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n=== RESUMEN ===');
  console.log('Con descripción:', conDesc);
  console.log('Sin descripción:', sinDesc);
  if (sinDescIds.length <= 20) console.log('IDs sin descripción:', sinDescIds.join(', '));
}

run().catch(console.error);
