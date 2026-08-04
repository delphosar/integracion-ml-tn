require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { graphql } = require('./ecom-api');

async function main() {
  // sendTiendaNube en un nubeMlListing con linked=false (no tiene TN todavía)
  // id=93116129 = MLA1880562877
  const testId = '93116129';
  const testOwner = 'MLA1880562877';

  console.log(`Probando sendTiendaNube en nubeMlListing id=${testId} (${testOwner})...`);

  const r = await graphql(`
    mutation {
      nubeMlListings {
        runMassiveActionForIDs(action: "sendTiendaNube", ids: ["${testId}"])
      }
    }
  `);
  console.log('Resultado:', JSON.stringify(r));

  // Esperar 5 segundos y luego verificar si se creó algo en TN
  console.log('\nEsperando 5 segundos...');
  await new Promise(res => setTimeout(res, 5000));

  // Verificar si ahora el nubeMlListing tiene linked=true o tiene una nubeListing
  const r2 = await graphql(`{
    nubeMlListings {
      find(filters: [{filter: "linked", values: ["false"]}], searchTerm: {value: "${testOwner}"}) {
        data { id ownerId linked }
        pageInfo { count }
      }
    }
  }`);
  console.log('\nVerificación post-sendTiendaNube:');
  console.log(JSON.stringify(r2?.nubeMlListings?.find?.data, null, 2));

  // También buscar si aparece en nubeListings (TN-created)
  try {
    const r3 = await graphql(`{
      nubeListings(channel: tiendanube) {
        find(searchTerm: {value: "${testOwner}"}) {
          data { id ownerId linked }
          pageInfo { count }
        }
      }
    }`);
    console.log('\nnubeListings post-sendTiendaNube:');
    console.log(JSON.stringify(r3, null, 2));
  } catch(e) {
    console.log('nubeListings error:', e.message.slice(0, 300));
  }
}

main().catch(e => console.error(e.message));
