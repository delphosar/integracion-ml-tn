const initSqlJs = require('sql.js');
const fs = require('fs');

const MLA_IDS = [
  // Sección A keepers + non-keepers relevantes
  'MLA1933989294','MLA1313761591',         // DC608-C
  'MLA1451106161','MLA1451169187',         // RT192/LNT
  'MLA1119804357','MLA1119830074',         // 21313
  'MLA905071655','MLA912114439','MLA640260557', // YC-14A
  'MLA817195562','MLA817195571','MLA817195056','MLA665554803', // PCC-0005
  'MLA689852902','MLA811973696',           // sombrilla STAMM
  'MLA782731135','MLA688001848',           // YC-10C
  // Sección B con modificaciones
  'MLA2024452076',  // CT1516
  'MLA1471245107',  // pve espejo Bayu
  'MLA1696205304',  // DA-00018 escritorio Creta
  'MLA1103123671',  // banco Indi UUID
  'MLA838525111',   // funda almohadon UUID
  'MLA820631710',   // PEJ-0010 jardin Meissa
];

initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('data/ml_products.db'));

  console.log('\n=== tn_products ===');
  const placeholders = MLA_IDS.map(() => '?').join(',');
  const tp = db.exec(`SELECT ml_item_id, tn_product_id FROM tn_products WHERE ml_item_id IN (${placeholders})`, MLA_IDS);
  if (tp[0]) for (const row of tp[0].values) console.log(`  ${row[0]} → TN ${row[1]}`);
  else console.log('  (ninguno)');

  console.log('\n=== ecom_ml_mapping ===');
  const em = db.exec(`SELECT ml_item_id, erp_sku, is_combo FROM ecom_ml_mapping WHERE ml_item_id IN (${placeholders})`, MLA_IDS);
  if (em[0]) for (const row of em[0].values) console.log(`  ${row[0]} | erp_sku: ${row[1]} | is_combo: ${row[2]}`);
  else console.log('  (ninguno)');
});
