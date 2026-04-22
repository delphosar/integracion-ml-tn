const XLSX = require('xlsx');

const filePath = 'C:/Users/marci/OneDrive/Documentos/ROCK SOFTWARE/2026/INTEGRACION-ML-TN/desarrollo/Publicaciones_Mercado_Libre_01KNQA53MCDBNM7T9PEESV5QMM.xlsx';

const workbook = XLSX.readFile(filePath);
const sheet = workbook.Sheets[workbook.SheetNames[0]];

// Print raw cell addresses to understand structure
console.log('=== SHEET RANGE ===');
console.log(sheet['!ref']);

// Print first few rows raw
console.log('\n=== RAW CELLS A1..T5 ===');
const cols = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T'];
for (let row = 1; row <= 5; row++) {
  const rowData = cols.map(c => {
    const cell = sheet[c + row];
    return cell ? cell.v : null;
  });
  console.log('Row ' + row + ':', JSON.stringify(rowData));
}

// Now read using row 2 as header (skipRows=1 is not an option, use header offset)
// sheet_to_json with header:1 gives arrays; let's use the second array as headers
const allRows = XLSX.utils.sheet_to_json(sheet, { defval: null, header: 1 });
console.log('\n=== ARRAY ROW 0 ===', JSON.stringify(allRows[0]));
console.log('=== ARRAY ROW 1 ===', JSON.stringify(allRows[1]));
console.log('=== ARRAY ROW 2 ===', JSON.stringify(allRows[2]));
console.log('=== ARRAY ROW 3 ===', JSON.stringify(allRows[3]));

// The header row appears to be array index 1 (second row in sheet)
// But from first run we saw row 0 had 'Estado' and row 1 had the real headers
// Let's check: first run showed __EMPTY: 'Estado' in row 1 and __EMPTY: 'ml_item_id' in row 2
// So the real column headers are in the SECOND row of the sheet (index 1 in 0-based, row 2 in Excel)

// Let's use sheet_to_json with skipHeader approach:
// Read with row index 1 as headers
const headerRow = allRows[1]; // This should be ['ml_item_id', 'Titulo', ...]
console.log('\n=== USING allRows[1] as headers ===');
console.log(headerRow);

const dataRows = allRows.slice(2).map(row => {
  const obj = {};
  headerRow.forEach((h, i) => {
    obj[h !== null ? h : '__COL_' + i] = row[i] !== undefined ? row[i] : null;
  });
  return obj;
});

console.log('\n=== TOTAL DATA ROWS ===', dataRows.length);

console.log('\n=== HEADERS ===');
headerRow.forEach((h, i) => console.log(i + ': ' + h));

console.log('\n=== COLUMN COVERAGE ===');
headerRow.forEach((h) => {
  if (h === null || h === undefined) return;
  const nonNull = dataRows.filter(r => r[h] !== null && r[h] !== '' && r[h] !== undefined).length;
  console.log('  [' + h + ']: ' + nonNull + ' / ' + dataRows.length);
});

console.log('\n=== FIRST 5 DATA ROWS ===');
dataRows.slice(0, 5).forEach((row, i) => {
  console.log('--- Row ' + (i+1) + ' ---');
  Object.entries(row).forEach(([k, v]) => {
    if (v !== null) console.log('  ' + k + ': ' + v);
  });
});

// SKU MercadoLibre
const skuML = dataRows.filter(r => r['SKU MercadoLibre'] !== null && r['SKU MercadoLibre'] !== '' && r['SKU MercadoLibre'] !== undefined);
console.log('\n=== SKU MercadoLibre ===');
console.log('Non-null count:', skuML.length);
console.log('Sample:', skuML.slice(0, 10).map(r => ({mla: r['ml_item_id'], sku: r['SKU MercadoLibre']})));

// SKU asociado
const skuAsoc = dataRows.filter(r => r['SKU asociado'] !== null && r['SKU asociado'] !== '' && r['SKU asociado'] !== undefined);
console.log('\n=== SKU asociado ===');
console.log('Non-null count:', skuAsoc.length);
console.log('Sample:', skuAsoc.slice(0, 10).map(r => ({mla: r['ml_item_id'], sku: r['SKU asociado'], titulo: r['Título Artículo']})));

// Unique SKU values
console.log('\n=== UNIQUE SKU MercadoLibre values (first 30) ===');
const uML = [...new Set(skuML.map(r => String(r['SKU MercadoLibre'])))];
console.log('Total unique:', uML.length);
uML.slice(0, 30).forEach(v => console.log('  ' + v));

console.log('\n=== UNIQUE SKU asociado values (first 30) ===');
const uAsoc = [...new Set(skuAsoc.map(r => String(r['SKU asociado'])))];
console.log('Total unique:', uAsoc.length);
uAsoc.slice(0, 30).forEach(v => console.log('  ' + v));
