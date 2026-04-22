require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const XLSX = require('xlsx');
const { getDb, saveToFile } = require('./db');

const EXCEL_PATH = path.join(
  __dirname, '..', '..',
  'Publicaciones_Mercado_Libre_01KNQA53MCDBNM7T9PEESV5QMM.xlsx'
);

async function main() {
  console.log('Leyendo Excel:', EXCEL_PATH);
  const workbook = XLSX.readFile(EXCEL_PATH);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  // Los headers reales están en la fila 3 del Excel (índice 2)
  // Los datos arrancan desde la fila 4 (índice 3)
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const headers = rows[2];
  const dataRows = rows.slice(3);

  console.log('Columnas detectadas:', headers);
  console.log(`Total filas de datos: ${dataRows.length}`);

  // Encontrar índices de columnas por nombre
  const idxOf = (name) => headers.findIndex(h => h === name);
  const COL_MLA       = idxOf('ml_item_id');
  const COL_SKU_ASOC  = idxOf('SKU asociado');
  const COL_TITULO    = idxOf('Título Artículo');

  if (COL_MLA === -1 || COL_SKU_ASOC === -1) {
    console.error('ERROR: No se encontraron las columnas esperadas. Verificar el Excel.');
    process.exit(1);
  }

  console.log(`\nColumna ml_item_id: ${COL_MLA}`);
  console.log(`Columna SKU asociado: ${COL_SKU_ASOC}`);
  console.log(`Columna Título Artículo: ${COL_TITULO}`);

  const db = await getDb();

  let imported = 0;
  let skipped = 0;

  for (const row of dataRows) {
    const mlItemId = row[COL_MLA];

    // Solo procesar filas con un MLA válido
    if (!mlItemId || typeof mlItemId !== 'string' || !mlItemId.toString().startsWith('MLA')) {
      skipped++;
      continue;
    }

    const erpSkuRaw     = row[COL_SKU_ASOC] != null ? String(row[COL_SKU_ASOC]).trim() : null;
    const tituloArt     = COL_TITULO !== -1 && row[COL_TITULO] != null ? String(row[COL_TITULO]).trim() : null;
    // Es combo si tiene más de un SKU (separados por coma)
    const isCombo       = erpSkuRaw && erpSkuRaw.includes(',') ? 1 : 0;

    db.run(`
      INSERT INTO ecom_ml_mapping (ml_item_id, erp_sku, titulo_articulo, is_combo)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ml_item_id) DO UPDATE SET
        erp_sku         = excluded.erp_sku,
        titulo_articulo = excluded.titulo_articulo,
        is_combo        = excluded.is_combo
    `, [mlItemId.toString(), erpSkuRaw, tituloArt, isCombo]);

    imported++;
  }

  saveToFile();

  const combos = db.exec('SELECT COUNT(*) FROM ecom_ml_mapping WHERE is_combo = 1')[0]?.values[0][0] ?? 0;
  const sinSku  = db.exec('SELECT COUNT(*) FROM ecom_ml_mapping WHERE erp_sku IS NULL')[0]?.values[0][0] ?? 0;

  console.log(`\n✓ Importados: ${imported}`);
  console.log(`  Skipped (sin MLA): ${skipped}`);
  console.log(`  Combos (multi-SKU): ${combos}`);
  console.log(`  Sin SKU asociado: ${sinSku}`);
}

main().catch(console.error);
