require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { graphql } = require('./ecom-api');

async function main() {
  const result = await graphql(`{
    __schema {
      types {
        name kind
        fields {
          name description
          args { name type { name kind ofType { name kind } } }
        }
      }
    }
  }`);
  const types = result.__schema.types;

  // ChannelSyncOptionMutation
  const cs = types.find(t => t.name === 'ChannelSyncOptionMutation');
  console.log('=== ChannelSyncOptionMutation ===');
  for (const f of cs?.fields ?? []) {
    const args = (f.args ?? []).map(a => `${a.name}:${a.type?.name ?? a.type?.ofType?.name ?? '?'}`).join(', ');
    console.log(`  .${f.name}(${args})`);
    if (f.description) console.log(`    "${f.description}"`);
  }

  // ChannelSyncOptionQuery
  const csq = types.find(t => t.name === 'ChannelSyncOptionQuery');
  console.log('\n=== ChannelSyncOptionQuery ===');
  for (const f of csq?.fields ?? []) {
    const args = (f.args ?? []).map(a => `${a.name}:${a.type?.name ?? a.type?.ofType?.name ?? '?'}`).join(', ');
    console.log(`  .${f.name}(${args})`);
    if (f.description) console.log(`    "${f.description}"`);
  }

  // Cualquier campo con sync/import/vincul/nube en descripción
  console.log('\n=== Campos con sync/import/vincul/nube en descripción ===');
  for (const t of types) {
    for (const f of t.fields ?? []) {
      const desc = (f.description ?? '').toLowerCase();
      if (desc.includes('sync') || desc.includes('import') || desc.includes('vincul') || desc.includes('nube')) {
        console.log(`  [${t.name}] .${f.name}: "${f.description}"`);
      }
    }
  }

  // NubeListingsMutation acciones masivas — qué acciones existen?
  console.log('\n=== Intentando listar acciones masivas disponibles ===');
  try {
    const r = await graphql(`{ nubeListings { findSettings { massiveActions { id label } } } }`);
    console.log(JSON.stringify(r?.nubeListings?.findSettings, null, 2));
  } catch(e) {
    console.log('findSettings error:', e.message.slice(0, 200));
  }
}
main().catch(e => console.error(e.message));
