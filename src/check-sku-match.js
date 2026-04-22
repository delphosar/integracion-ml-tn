require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const XLSX      = require('xlsx');
const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const EXCEL_PATH = path.join(__dirname, '..', '..', 'Articulos_Exportados_Ecom_Experts_1772558386.xlsx');
const DB_PATH    = path.join(__dirname, '..', 'data', 'ml_products.db');

async function main() {
  // --- Leer Excel ---
  const wb   = XLSX.readFile(EXCEL_PATH);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws);

  const skus         = [...new Set(rows.map(r => r.sku).filter(Boolean).map(String))];
  const skuVariantes = [...new Set(rows.map(r => r.sku_variante).filter(Boolean).map(String))];

  console.log(`Excel — SKUs únicos:          ${skus.length}`);
  console.log(`Excel — SKU variantes únicos: ${skuVariantes.length}`);

  // --- Leer DB ---
  const SQL = await initSqlJs();
  const db  = new SQL.Database(fs.readFileSync(DB_PATH));

  // Valores disponibles en la DB para comparar
  // seller_custom_field en items está en raw_json, lo extraemos con json_extract
  const itemScf = db.exec(`SELECT DISTINCT json_extract(raw_json, '$.seller_custom_field') as scf FROM ml_items WHERE scf IS NOT NULL`);
  const varScf  = db.exec(`SELECT DISTINCT seller_custom_field FROM ml_variations WHERE seller_custom_field IS NOT NULL`);
  const varUpid = db.exec(`SELECT DISTINCT user_product_id     FROM ml_variations WHERE user_product_id IS NOT NULL`);

  const dbItemScf = new Set((itemScf[0]?.values ?? []).map(v => String(v[0])));
  const dbVarScf  = new Set((varScf[0]?.values  ?? []).map(v => String(v[0])));
  const dbVarUpid = new Set((varUpid[0]?.values ?? []).map(v => String(v[0])));

  console.log(`\nDB — ml_items.seller_custom_field únicos:      ${dbItemScf.size}`);
  console.log(`DB — ml_variations.seller_custom_field únicos: ${dbVarScf.size}`);
  console.log(`DB — ml_variations.user_product_id únicos:     ${dbVarUpid.size}`);

  // --- Cruzar ---
  console.log('\n=== CRUCES sku del Excel ===');
  const matchSkuVsItemScf = skus.filter(s => dbItemScf.has(s));
  const matchSkuVsVarScf  = skus.filter(s => dbVarScf.has(s));
  console.log(`sku vs ml_items.seller_custom_field:      ${matchSkuVsItemScf.length} matches`);
  console.log(`sku vs ml_variations.seller_custom_field: ${matchSkuVsVarScf.length} matches`);

  console.log('\n=== CRUCES sku_variante del Excel ===');
  const matchVarVsItemScf = skuVariantes.filter(s => dbItemScf.has(s));
  const matchVarVsVarScf  = skuVariantes.filter(s => dbVarScf.has(s));
  const matchVarVsUpid    = skuVariantes.filter(s => dbVarUpid.has(s));
  console.log(`sku_variante vs ml_items.seller_custom_field:      ${matchVarVsItemScf.length} matches`);
  console.log(`sku_variante vs ml_variations.seller_custom_field: ${matchVarVsVarScf.length} matches`);
  console.log(`sku_variante vs ml_variations.user_product_id:     ${matchVarVsUpid.length} matches`);

  // Mostrar ejemplos de los matches que encuentre
  const allMatches = [
    { campo: 'sku vs items.seller_custom_field',      lista: matchSkuVsItemScf  },
    { campo: 'sku vs vars.seller_custom_field',       lista: matchSkuVsVarScf   },
    { campo: 'sku_variante vs items.seller_custom_field', lista: matchVarVsItemScf },
    { campo: 'sku_variante vs vars.seller_custom_field',  lista: matchVarVsVarScf  },
    { campo: 'sku_variante vs vars.user_product_id',      lista: matchVarVsUpid    },
  ];

  for (const { campo, lista } of allMatches) {
    if (lista.length > 0) {
      console.log(`\n→ Ejemplos de ${campo}:`);
      lista.slice(0, 5).forEach(s => console.log(`  "${s}"`));
    }
  }

  // Mostrar muestras de DB para inspección visual
  console.log('\n=== Muestra ml_items.seller_custom_field (primeros 10) ===');
  [...dbItemScf].slice(0, 10).forEach(v => console.log(' ', v));

  console.log('\n=== Muestra ml_variations.seller_custom_field (primeros 10) ===');
  if (dbVarScf.size > 0) [...dbVarScf].slice(0, 10).forEach(v => console.log(' ', v));
  else console.log('  (todos null)');
}

main().catch(console.error);
