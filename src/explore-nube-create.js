require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { graphql } = require('./ecom-api');

async function deepInspectInput(typeName, visited = new Set(), depth = 0) {
  if (visited.has(typeName) || depth > 3) return null;
  visited.add(typeName);
  const pad = '  '.repeat(depth);

  const r = await graphql(`{
    __type(name: "${typeName}") {
      kind
      inputFields {
        name
        type { name kind ofType { name kind ofType { name kind } } }
      }
    }
  }`);
  const t = r.__type;
  if (!t || t.kind !== 'INPUT_OBJECT') return null;

  const lines = [];
  for (const f of t.inputFields ?? []) {
    const tn = f.type?.name ?? f.type?.ofType?.name ?? f.type?.ofType?.ofType?.name ?? '?';
    const k = f.type?.kind ?? f.type?.ofType?.kind ?? '?';
    lines.push(`${pad}  ${f.name}: ${tn} (${k})`);
  }
  return lines;
}

async function main() {
  // 1. ProductCreateInput — ¿tiene campos de canales/nube?
  const r1 = await graphql(`{
    __type(name: "ProductCreateInput") {
      inputFields {
        name
        type { name kind ofType { name kind ofType { name kind } } }
      }
    }
  }`);
  console.log('=== ProductCreateInput fields ===');
  for (const f of r1.__type?.inputFields ?? []) {
    const tn = f.type?.name ?? f.type?.ofType?.name ?? f.type?.ofType?.ofType?.name ?? '?';
    console.log(`  ${f.name}: ${tn}`);
  }

  // 2. VariantsMutation.create — args
  const r2 = await graphql(`{
    __type(name: "VariantsMutation") {
      fields {
        name description
        args { name type { name kind ofType { name kind } } }
        type { name kind ofType { name kind } }
      }
    }
  }`);
  console.log('\n=== VariantsMutation fields ===');
  for (const f of r2.__type?.fields ?? []) {
    const args = (f.args ?? []).map(a => `${a.name}:${a.type?.name ?? a.type?.ofType?.name ?? '?'}`).join(', ');
    const ret = f.type?.name ?? f.type?.ofType?.name ?? f.type?.kind;
    console.log(`  .${f.name}(${args}) → ${ret}`);
    if (f.description) console.log(`    "${f.description}"`);
  }

  // 3. ProductUpdateInput — ¿tiene channels/nube?
  const r3 = await graphql(`{
    __type(name: "ProductUpdateInput") {
      inputFields {
        name
        type { name kind ofType { name kind ofType { name kind } } }
      }
    }
  }`);
  console.log('\n=== ProductUpdateInput fields ===');
  for (const f of r3.__type?.inputFields ?? []) {
    const tn = f.type?.name ?? f.type?.ofType?.name ?? f.type?.ofType?.ofType?.name ?? '?';
    console.log(`  ${f.name}: ${tn}`);
  }

  // 4. Acciones masivas de products
  try {
    const r4 = await graphql(`{ products { findSettings { massiveActions { action name } } } }`);
    console.log('\n=== products massive actions ===');
    console.log(JSON.stringify(r4?.products?.findSettings?.massiveActions, null, 2));
  } catch(e) {
    console.log('products massiveActions error:', e.message.slice(0, 300));
  }

  // 5. Campos del tipo Product que incluyan nube/canal
  const r5 = await graphql(`{
    __type(name: "Product") {
      fields {
        name description
        type { name kind ofType { name kind } }
      }
    }
  }`);
  console.log('\n=== Product fields relacionados con canales/nube ===');
  for (const f of r5.__type?.fields ?? []) {
    const n = f.name.toLowerCase();
    const d = (f.description ?? '').toLowerCase();
    if (n.includes('nube') || n.includes('channel') || n.includes('listing') || n.includes('publi') ||
        d.includes('nube') || d.includes('channel') || d.includes('tienda')) {
      const tn = f.type?.name ?? f.type?.ofType?.name ?? '?';
      console.log(`  .${f.name}: ${tn}${f.description ? ` — "${f.description}"` : ''}`);
    }
  }
}

main().catch(e => console.error(e.message));
