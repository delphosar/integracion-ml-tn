require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const axios = require('axios');
const { getDb, getTokens, saveTokens } = require('./db');

const TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
const SEVEN_DAYS_S = 7 * 24 * 60 * 60;

// Refresca el access_token usando el refresh_token almacenado en DB
async function refreshToken() {
  const stored = getTokens();
  const currentRefreshToken = stored?.refresh_token ?? process.env.ML_REFRESH_TOKEN;

  if (!currentRefreshToken) {
    throw new Error('No hay refresh_token disponible. Ejecutá: node src/ml-auth.js --init');
  }

  const { data } = await axios.post(TOKEN_URL, {
    grant_type: 'refresh_token',
    client_id: process.env.ML_CLIENT_ID,
    client_secret: process.env.ML_CLIENT_SECRET,
    refresh_token: currentRefreshToken,
  });

  const expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at,
  });

  console.log(`[ml-auth] Token refrescado. Expira: ${new Date(expires_at * 1000).toISOString()}`);
  return data.access_token;
}

// Retorna un access_token válido, refrescando automáticamente si expira en menos de 7 días
async function getValidToken() {
  await getDb();
  const stored = getTokens();

  if (!stored) {
    // Sin tokens en DB → usar ML_ACCESS_TOKEN del .env como fallback
    return process.env.ML_ACCESS_TOKEN;
  }

  const nowS = Math.floor(Date.now() / 1000);
  if (stored.expires_at - nowS < SEVEN_DAYS_S) {
    return refreshToken();
  }

  return stored.access_token;
}

module.exports = { getValidToken, refreshToken };

// Seed inicial: node src/ml-auth.js --init
if (require.main === module && process.argv.includes('--init')) {
  (async () => {
    await getDb();
    const accessToken = process.env.ML_ACCESS_TOKEN;
    const initialRefreshToken = process.env.ML_REFRESH_TOKEN;

    if (!initialRefreshToken) {
      console.error('Error: ML_REFRESH_TOKEN no está configurado en .env');
      process.exit(1);
    }

    // Asumimos 6 horas de vida para el access_token inicial (valor típico de ML)
    const expires_at = Math.floor(Date.now() / 1000) + (6 * 60 * 60);
    saveTokens({ access_token: accessToken, refresh_token: initialRefreshToken, expires_at });

    console.log('Tokens guardados en DB.');
    console.log(`  access_token: ${accessToken?.slice(0, 20)}...`);
    console.log(`  refresh_token: ${initialRefreshToken?.slice(0, 20)}...`);
    console.log(`  expires_at: ${new Date(expires_at * 1000).toISOString()}`);
    console.log('Próximo sync-delta refrescará automáticamente si es necesario.');
  })().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
