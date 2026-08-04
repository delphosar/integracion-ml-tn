require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const axios = require('axios');
const storeId = process.env.TN_STORE_ID;
const token = process.env.TN_ACCESS_TOKEN;

axios.get(`https://api.tiendanube.com/v1/${storeId}/products?per_page=5`, {
  headers: { Authentication: 'bearer ' + token, 'User-Agent': process.env.TN_USER_AGENT }
}).then(r => {
  for (const p of r.data) {
    const desc = p.description?.es ?? null;
    console.log(`ID: ${p.id} | desc: ${desc ? JSON.stringify(desc).substring(0, 100) : 'NULL/EMPTY'}`);
  }
}).catch(e => console.error(e.message));
