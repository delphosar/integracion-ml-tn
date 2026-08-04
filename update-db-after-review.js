/**
 * Actualiza la DB SQLite luego de la revisión manual del needs-review-report.txt
 *
 * Cambios:
 * 1. Elimina de tn_products los 10 no-keepers que fueron borrados de TN por resolve-no-keeper-groups.js
 * 2. Elimina los mismos de ecom_ml_mapping
 *
 * NO modifica:
 * - Los keepers (ya tienen erp_sku correcto)
 * - Los combos de Sección B (is_combo ya está correcto)
 * - Productos sin mapeo ERP (MLA1131697066, MLA1133267178)
 */

const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data/ml_products.db');

// 10 no-keepers eliminados de TN por resolve-no-keeper-groups.js
const NON_KEEPERS = [
  { mlaId: 'MLA1313761591', tnId: '337701717', note: 'DC608-C — Pack 4 (no-keeper)' },
  { mlaId: 'MLA1451169187', tnId: '337707922', note: 'RT192/LNT — 6 Sillas Becca (no-keeper)' },
  { mlaId: 'MLA1119830074', tnId: '337698442', note: '21313 — Beetle Pack 4 C (no-keeper)' },
  { mlaId: 'MLA912114439',  tnId: '337762900', note: 'YC-14A — Mesa Nuuk C (no-keeper)' },
  { mlaId: 'MLA640260557',  tnId: '337750004', note: 'YC-14A — Mesa Arrime Nuuk (no-keeper)' },
  { mlaId: 'MLA665554803',  tnId: '337751207', note: 'PCC-0005 — Amanda Pack 4 Nordica (no-keeper)' },
  { mlaId: 'MLA817195056',  tnId: '337756382', note: 'PCC-0005 — Amanda Pack 2 Nordicas (no-keeper)' },
  { mlaId: 'MLA817195571',  tnId: '337756650', note: 'PCC-0005 — Amanda Pack 4 Unid (no-keeper)' },
  { mlaId: 'MLA811973696',  tnId: '337756128', note: 'sombrilla STAMM — Exterior C (no-keeper)' },
  { mlaId: 'MLA688001848',  tnId: '337751845', note: 'YC-10C — Mecedora Lino C (no-keeper)' },
];

const DRY_RUN = process.argv.includes('--dry-run');

initSqlJs().then(SQL => {
  const db = new SQL.Database(fs.readFileSync(DB_PATH));

  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== ACTUALIZANDO DB ===');
  console.log(`\nEliminando ${NON_KEEPERS.length} no-keepers de tn_products y ecom_ml_mapping...\n`);

  let deletedTn = 0, deletedEcom = 0;

  for (const { mlaId, tnId, note } of NON_KEEPERS) {
    // Verificar que existen antes de borrar
    const tnExists = db.exec(`SELECT COUNT(*) FROM tn_products WHERE ml_item_id = ?`, [mlaId])[0]?.values[0][0] ?? 0;
    const ecomExists = db.exec(`SELECT COUNT(*) FROM ecom_ml_mapping WHERE ml_item_id = ?`, [mlaId])[0]?.values[0][0] ?? 0;

    console.log(`${note}`);
    console.log(`  MLA: ${mlaId} | TN: ${tnId}`);
    console.log(`  tn_products: ${tnExists ? 'EXISTE → borrar' : 'ya no existe'}`);
    console.log(`  ecom_ml_mapping: ${ecomExists ? 'EXISTE → borrar' : 'ya no existe'}`);

    if (!DRY_RUN) {
      if (tnExists) { db.run(`DELETE FROM tn_products WHERE ml_item_id = ?`, [mlaId]); deletedTn++; }
      if (ecomExists) { db.run(`DELETE FROM ecom_ml_mapping WHERE ml_item_id = ?`, [mlaId]); deletedEcom++; }
    } else {
      if (tnExists) deletedTn++;
      if (ecomExists) deletedEcom++;
    }
    console.log();
  }

  console.log(`\n=== RESUMEN ===`);
  console.log(`tn_products eliminados: ${deletedTn}`);
  console.log(`ecom_ml_mapping eliminados: ${deletedEcom}`);

  if (!DRY_RUN) {
    fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
    console.log(`\nDB guardada en ${DB_PATH}`);
  } else {
    console.log('\n(DRY RUN — no se guardó nada)');
  }
});
