const fs   = require('fs');
const path = require('path');

const groups = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'tn-similar-groups.json'), 'utf8'));

const cats = { exact_title: [], c_suffix: [], other: [] };

for (const g of groups) {
  const titles = g.members.map(m => m.title.trim().toLowerCase().replace(/\s+/g, ' '));
  const allSameTitle = (new Set(titles)).size === 1;
  const hasC    = g.members.some(m => /\s+c\s*$/.test(m.title));
  const hasNonC = g.members.some(m => !/\s+c\s*$/.test(m.title));
  const isCFinancing = hasC && hasNonC;

  if (allSameTitle) {
    cats.exact_title.push(g);
  } else if (isCFinancing) {
    cats.c_suffix.push(g);
  } else {
    cats.other.push(g);
  }
}

console.log('=== Clasificación de los 167 grupos ===\n');

console.log('A) Título IDÉNTICO (posibles duplicados exactos):', cats.exact_title.length, 'grupos');
cats.exact_title.forEach((g, i) => {
  console.log(`\n  [A${i+1}] "${g.members[0].title}"`);
  g.members.forEach(m => {
    console.log(`        TN:${m.tn_product_id}  SKU:${m.sku ?? '(sin sku)'}  vars:${m.variant_count}`);
  });
});

console.log('\n\nB) Financiación - sufijo " C" (ya tratados):', cats.c_suffix.length, 'grupos');
cats.c_suffix.forEach(g => {
  g.members.forEach(m => console.log(`  TN:${m.tn_product_id}  "${m.title}"`));
});

console.log('\n\nD) Nombres similares pero distintos (variantes de color/tamaño/modelo):', cats.other.length, 'grupos');
console.log('   (Son productos legítimamente distintos cargados como publicaciones separadas)');
console.log('   Primeros 10 ejemplos:');
cats.other.slice(0, 10).forEach((g, i) => {
  console.log(`\n  [D${i+1}] (${g.count} productos)`);
  g.members.forEach(m => console.log(`        TN:${m.tn_product_id}  SKU:${m.sku ?? '(sin sku)'}  "${m.title}"`));
});
