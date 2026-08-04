require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { graphql } = require('./ecom-api');

async function main() {
  // Verificar estado actual del nubeMlListing para MLA3164824934
  console.log('=== Estado actual del nubeMlListing ===');
  try {
    const r = await graphql(`{
      nubeMlListings {
        find(searchTerm: { value: "MLA3164824934" }) {
          data {
            id ownerId linked
            listingRule { id title syncStock }
          }
        }
      }
    }`);
    console.log(JSON.stringify(r?.nubeMlListings?.find?.data, null, 2));
  } catch(e) { console.log('ERROR (puede no tener listingRule):', e.message.slice(0, 300)); }

  // También probar con el listings id (93318017) en vez del nubeMlListings id
  console.log('\n=== Intentar asignar con listings id (93318017) ===');
  try {
    const r = await graphql(`
      mutation {
        mtListings {
          asignateListingRule(input: { mtListingId: "93318017", mtListingRuleId: "4129" }) { id }
        }
      }
    `);
    console.log('asignateListingRule con 93318017:', JSON.stringify(r, null, 2));
  } catch(e) { console.log('ERROR:', e.message.slice(0, 300)); }
}

main().catch(e => console.error(e.message));
