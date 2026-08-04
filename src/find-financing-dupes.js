/**
 * find-financing-dupes.js
 * Detecta pares de publicaciones TN duplicadas donde una es la versión
 * "contado" y la otra es "financiación" (título ML con sufijo " C" o similar).
 *
 * Uso: node src/find-financing-dupes.js [--dry-run]
 */

const { getDb, rawQuery, saveToFile } = require('./db');
const fs = require('fs');
const path = require('path');

async function main() {
  const dryRun = process.argv.includes('--dry-run') || !process.argv.includes('--delete');
  await getDb();

  // Traer todos los ml_items que tienen un tn_product asignado
  const items = rawQuery(`
    SELECT m.id AS ml_item_id, m.title, t.tn_product_id
    FROM ml_items m
    JOIN tn_products t ON t.ml_item_id = m.id
    ORDER BY m.title
  `);

  console.log(`Total items con TN: ${items.length}`);

  // Normalizar título: quitar el sufijo " C" al final (o " C " antes de otros términos)
  // Patrones observados: "Silla Modelo X C", "Mesa RT C", "RT192/LNT C"
  // Regla: si el título termina en " C" (con espacio antes, C sola al final), es la versión financiación
  const FINANCING_SUFFIX_RE = /\s+C\s*$/i;

  const byBase = {};

  for (const item of items) {
    const isFinancing = FINANCING_SUFFIX_RE.test(item.title);
    const baseTitle = isFinancing
      ? item.title.replace(FINANCING_SUFFIX_RE, '').trim()
      : item.title.trim();

    if (!byBase[baseTitle]) byBase[baseTitle] = { cash: [], financing: [] };

    if (isFinancing) {
      byBase[baseTitle].financing.push(item);
    } else {
      byBase[baseTitle].cash.push(item);
    }
  }

  // Encontrar pares donde existe AMBAS versiones en TN
  const pairs = [];
  for (const [base, group] of Object.entries(byBase)) {
    if (group.cash.length > 0 && group.financing.length > 0) {
      pairs.push({
        base_title: base,
        cash: group.cash,
        financing: group.financing,
      });
    }
  }

  console.log(`\nPares contado/financiación encontrados en TN: ${pairs.length}`);
  console.log('');

  if (pairs.length === 0) {
    console.log('No se encontraron pares. Puede que el patrón de sufijo difiera.');
    console.log('\nTítulos de muestra con "C" en el nombre:');
    const muestra = items.filter(i => / C/.test(i.title)).slice(0, 20);
    muestra.forEach(i => console.log(` - [${i.ml_item_id}] ${i.title}`));
    return;
  }

  // Mostrar resultados
  for (const p of pairs) {
    console.log(`📦 ${p.base_title}`);
    for (const c of p.cash) {
      console.log(`   💵 CONTADO   → ML: ${c.ml_item_id} | TN: ${c.tn_product_id} | "${c.title}"`);
    }
    for (const f of p.financing) {
      console.log(`   💳 FINANCIAC → ML: ${f.ml_item_id} | TN: ${f.tn_product_id} | "${f.title}"`);
    }
  }

  // Guardar reporte
  const reportPath = path.join(__dirname, '..', 'data', 'financing-dupes.json');
  fs.writeFileSync(reportPath, JSON.stringify(pairs, null, 2));
  console.log(`\nReporte guardado en data/financing-dupes.json`);

  const toDelete = pairs.flatMap(p => p.financing);
  console.log(`\nPublicaciones TN a eliminar (financiación): ${toDelete.length}`);
  toDelete.forEach(i => console.log(`  TN ${i.tn_product_id} → "${i.title}"`));

  if (dryRun) {
    console.log('\n[DRY RUN] Para eliminar, ejecutar: node src/find-financing-dupes.js --delete');
  }
}

main().catch(console.error);
