require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getValidToken } = require('./ml-auth');
const { getItemDetail } = require('./ml-api');

async function main() {
  const token = await getValidToken();
  process.env.ML_ACCESS_TOKEN = token;

  const item = await getItemDetail('MLA3164824934');

  console.log('tags:', JSON.stringify(item.tags));
  console.log('sale_terms:', JSON.stringify(item.sale_terms?.slice(0, 3)));
  console.log('subtitle:', item.subtitle);
}

main().catch(e => console.error(e.message));
