/**
 * Script de autenticación TiendaNube (OAuth2)
 *
 * Uso:
 *   node src/tn-auth.js
 *
 * Necesitás tener en el .env:
 *   TN_CLIENT_ID=xxxxxx
 *   TN_CLIENT_SECRET=xxxxxx
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http  = require('http');
const axios = require('axios');
const open  = require('open');
const fs    = require('fs');
const path  = require('path');

const CLIENT_ID     = process.env.TN_CLIENT_ID;
const CLIENT_SECRET = process.env.TN_CLIENT_SECRET;
const REDIRECT_URI  = 'http://localhost:3000/callback';
const SCOPES        = 'write_products read_products';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('ERROR: Agregá TN_CLIENT_ID y TN_CLIENT_SECRET al .env');
  process.exit(1);
}

const authUrl = `https://www.tiendanube.com/apps/${CLIENT_ID}/authorize?response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPES)}`;

console.log('\n=== TiendaNube OAuth ===');
console.log('Abriendo el browser para autorizar...\n');

// Servidor temporal en localhost:3000 para capturar el callback
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');

  if (url.pathname !== '/callback') {
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.end('<h2>Error: no se recibió el code. Cerrá esta ventana.</h2>');
    server.close();
    return;
  }

  res.end('<h2>¡Autorizado! Podés cerrar esta ventana y volver a la terminal.</h2>');

  console.log(`Code recibido. Obteniendo access token...`);

  try {
    const { data } = await axios.post(
      'https://www.tiendanube.com/apps/authorize/token',
      new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token, user_id } = data;

    console.log('\n=== Token obtenido ===');
    console.log(`TN_ACCESS_TOKEN=${access_token}`);
    console.log(`TN_STORE_ID=${user_id}`);

    // Actualiza el .env automáticamente
    const envPath = path.join(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    envContent = updateEnvVar(envContent, 'TN_ACCESS_TOKEN', access_token);
    envContent = updateEnvVar(envContent, 'TN_STORE_ID',     String(user_id));

    fs.writeFileSync(envPath, envContent);
    console.log('\n.env actualizado con TN_ACCESS_TOKEN y TN_STORE_ID');
    console.log('Ya podés correr: node src/test-upload-tn.js');

  } catch (err) {
    console.error('Error al obtener el token:', err.response?.data ?? err.message);
  }

  server.close();
});

server.listen(3000, () => {
  open(authUrl).catch(() => {
    // Si no puede abrir el browser, muestra el URL
    console.log('No se pudo abrir el browser automáticamente.');
    console.log('Abrí este URL manualmente:\n');
    console.log(authUrl);
  });
});

// Reemplaza o agrega una variable en el contenido del .env
function updateEnvVar(content, key, value) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  const line  = `${key}=${value}`;
  return regex.test(content)
    ? content.replace(regex, line)
    : content + `\n${line}`;
}
