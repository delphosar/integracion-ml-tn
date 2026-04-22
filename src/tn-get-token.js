require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const fs    = require('fs');
const path  = require('path');

const CLIENT_ID     = process.env.TN_CLIENT_ID;
const CLIENT_SECRET = process.env.TN_CLIENT_SECRET;
const code          = process.argv[2];

if (!code) {
  console.error('Uso: node src/tn-get-token.js CODIGO_AQUI');
  process.exit(1);
}

async function main() {
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
  console.log(`\nTN_ACCESS_TOKEN=${access_token}`);
  console.log(`TN_STORE_ID=${user_id}`);

  // Guarda en .env
  const envPath = path.join(__dirname, '..', '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  envContent = envContent.replace(/^TN_ACCESS_TOKEN=.*$/m, `TN_ACCESS_TOKEN=${access_token}`);
  envContent = envContent.replace(/^TN_STORE_ID=.*$/m,     `TN_STORE_ID=${user_id}`);
  fs.writeFileSync(envPath, envContent);

  console.log('\n.env actualizado. Ya podés correr: node src/test-upload-tn.js');
}

main().catch((err) => console.error('Error:', err.response?.data ?? err.message));
