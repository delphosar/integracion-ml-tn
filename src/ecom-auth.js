require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');
const { getDb, saveEcomSession, getEcomSession } = require('./db');

const LOGIN_URL = 'https://api.ecomexperts.com/users/users/doLogin.json';

// La cookie expira todos los días a las 00:06 UTC.
// Calcula el timestamp (ms) del próximo vencimiento.
function getNextExpiry() {
  const now = new Date();
  const expiry = new Date();
  expiry.setUTCHours(0, 6, 0, 0);
  if (expiry <= now) expiry.setUTCDate(expiry.getUTCDate() + 1);
  return expiry.getTime();
}

async function login() {
  if (!process.env.ECOM_EMAIL || !process.env.ECOM_PASSWORD) {
    throw new Error('[ecom-auth] ECOM_EMAIL y ECOM_PASSWORD deben estar en .env');
  }

  const { headers } = await axios.post(LOGIN_URL, {
    User: {
      email_address: process.env.ECOM_EMAIL,
      password: process.env.ECOM_PASSWORD,
    },
  }, { headers: { 'Content-Type': 'application/json' } });

  const setCookies = headers['set-cookie'] ?? [];
  const cakeCookies = setCookies
    .map(c => c.split(';')[0].trim())
    .filter(c => c.startsWith('CAKEPHP='));

  if (!cakeCookies.length) {
    throw new Error('[ecom-auth] No se encontró cookie CAKEPHP en la respuesta de login');
  }

  // Si hay múltiples cookies CAKEPHP, usar la última
  const cookie = cakeCookies[cakeCookies.length - 1];
  const expires_at = getNextExpiry();
  saveEcomSession(cookie, expires_at);

  console.log(`[ecom-auth] Login exitoso. Cookie válida hasta ${new Date(expires_at).toISOString()}`);
  return cookie;
}

// Retorna una cookie válida, haciendo login automático si expiró o falta.
async function getValidCookie() {
  await getDb();
  const session = getEcomSession();
  const now = Date.now();

  // Margen de 2 min antes del vencimiento para re-loguear proactivamente
  if (session && session.expires_at > now + 120_000) {
    return session.cookie;
  }

  return login();
}

module.exports = { getValidCookie, login };

// Test de conexión: node src/ecom-auth.js --test
if (require.main === module && process.argv.includes('--test')) {
  (async () => {
    await getDb();
    console.log('[ecom-auth] Intentando login...');
    const cookie = await login();
    console.log(`[ecom-auth] Cookie obtenida: ${cookie.slice(0, 30)}...`);
  })().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
