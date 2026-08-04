require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { getValidToken } = require('./ml-auth');
const axios = require('axios');

async function main() {
  const token = await getValidToken();
  const ITEM_ID = 'MLA3360178860'; // Silla Galileo Pro

  console.log(`=== Detalle completo ML: ${ITEM_ID} ===\n`);
  const { data: item } = await axios.get(`https://api.mercadolibre.com/items/${ITEM_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  const {
    id, title, price, original_price, base_price, currency_id,
    status, available_quantity, sale_terms, promotions,
    variations
  } = item;

  console.log({ id, title, price, original_price, base_price, currency_id, status, available_quantity });
  console.log('\nsale_terms:', JSON.stringify(sale_terms, null, 2));
  console.log('\npromotions:', JSON.stringify(promotions, null, 2));

  if (variations?.length) {
    console.log('\nVariaciones:');
    for (const v of variations) {
      console.log({ id: v.id, price: v.price, original_price: v.original_price, sale_terms: v.sale_terms });
    }
  }
}

main().catch(console.error);
