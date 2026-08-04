const initSqlJs = require('sql.js');
const fs = require('fs');

// Sección B — combos y modificados
const MLA_IDS = [
  'MLA2008132872', // combo: C602-1/v + PSO-0011
  'MLA1473393487', // combo: C602-1-B + PCC-0002
  'MLA1463782767', // combo: PSV-0010
  'MLA1455466885', // combo: PME-0012 + PSO-0013
  'MLA1455449973', // combo: PME-0013 + PSO-0013
  'MLA1455128697', // combo: PME-0012 + PSO-0014
  'MLA1934397718', // combo: PME-0013 + PSO-0014
  'MLA1455115093', // combo: PSO-0014
  'MLA1929741546', // combo: PME-0015 + PSO-0014
  'MLA1916135238', // combo: RT192/LNT + PCC-0001
  'MLA1911215244', // combo: dt-2216-1 + PSO-0011
  'MLA1898205722', // combo: PSO-0011
  'MLA1882840946', // combo: PME-0012 + rt131
  'MLA1442867691', // combo: PME-0013 + RT780
  'MLA1416859881', // combo: PSV-0023
  'MLA694426562',  // combo: YC-04F + YC-10C
  'MLA1263256648', // combo: 681a53cf
  'MLA1133267178', // NO EXISTE EN ECOM
  'MLA1131697066', // NO EXISTE EN ECOM
];

initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync('data/ml_products.db'));
  const ph = MLA_IDS.map(() => '?').join(',');

  console.log('\n=== tn_products ===');
  const tp = db.exec(`SELECT ml_item_id, tn_product_id FROM tn_products WHERE ml_item_id IN (${ph})`, MLA_IDS);
  if (tp[0]) for (const r of tp[0].values) console.log(`  ${r[0]} → TN ${r[1]}`);
  else console.log('  (ninguno)');

  console.log('\n=== ecom_ml_mapping ===');
  const em = db.exec(`SELECT ml_item_id, erp_sku, is_combo FROM ecom_ml_mapping WHERE ml_item_id IN (${ph})`, MLA_IDS);
  if (em[0]) for (const r of em[0].values) console.log(`  ${r[0]} | erp_sku: ${r[1]} | is_combo: ${r[2]}`);
  else console.log('  (ninguno)');
});
