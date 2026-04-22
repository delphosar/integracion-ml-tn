require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { fetchAllItems } = require('./ml-api');
const { getDb, upsertItem, saveToFile, startSyncLog, finishSyncLog, getStats } = require('./db');

const userId = process.env.ML_USER_ID;
const accessToken = process.env.ML_ACCESS_TOKEN;

// Guarda en disco cada SAVE_EVERY items para no perder progreso
const SAVE_EVERY = 50;

async function main() {
  if (!userId || !accessToken) {
    console.error('ERROR: Faltan credenciales. Copiá .env.example a .env y completá ML_ACCESS_TOKEN y ML_USER_ID.');
    process.exit(1);
  }

  const withDescriptions = !process.argv.includes('--no-descriptions');
  console.log(`\n=== Sync ML Products ===`);
  console.log(`Usuario: ${userId}`);
  console.log(`Con descripciones: ${withDescriptions}`);
  console.log('');

  // Inicializar DB (async porque carga el WASM de sql.js)
  await getDb();

  const logId = startSyncLog();
  let totalSaved = 0;
  let totalFetched = 0;
  let sinceLastSave = 0;

  try {
    await fetchAllItems(userId, {
      withDescriptions,
      onBatch: async (batchItems) => {
        for (const item of batchItems) {
          upsertItem(item);
          totalSaved++;
          sinceLastSave++;
        }
        totalFetched += batchItems.length;

        // Guardar en disco cada SAVE_EVERY items
        if (sinceLastSave >= SAVE_EVERY) {
          saveToFile();
          sinceLastSave = 0;
        }
      },
    });

    finishSyncLog(logId, { total_fetched: totalFetched, total_saved: totalSaved, status: 'ok' });

    // Guardado final
    saveToFile();

    const stats = getStats();
    console.log('\n=== Resultado ===');
    console.log(`Items guardados: ${totalSaved}`);
    console.log(`Total en DB:       ${stats.total}`);
    console.log(`  Activos:         ${stats.active}`);
    console.log(`  Pausados:        ${stats.paused}`);
    console.log(`  Con variaciones: ${stats.withVariations}`);
    console.log(`Última sync:     ${stats.lastSync}`);
    console.log('');
    console.log('Base de datos:   data/ml_products.db');
    console.log('Listo!');

  } catch (err) {
    finishSyncLog(logId, {
      total_fetched: totalFetched,
      total_saved: totalSaved,
      status: 'error',
      error: err.message,
    });

    // Guardar lo que hayamos obtenido hasta ahora
    if (totalSaved > 0) {
      saveToFile();
      console.log(`\n(Se guardaron ${totalSaved} items antes del error)`);
    }

    if (err.response) {
      const { status, data } = err.response;
      console.error(`\nError HTTP ${status}:`, JSON.stringify(data, null, 2));
      if (status === 401) {
        console.error('\nEl access_token es inválido o expiró. Renovalo en ML Developers.');
      }
    } else {
      console.error('\nError:', err.message ?? String(err));
      if (err.stack) console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
