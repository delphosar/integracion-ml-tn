module.exports = {
  apps: [
    {
      name: 'ml-tn-sync-delta',
      script: 'src/sync-delta.js',
      args: '--prices-only',         // solo precios — stock lo maneja integración nativa EcomExperts
      cron_restart: '*/30 * * * *', // cada 30 minutos
      autorestart: false,            // es un script puntual, no un daemon
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'tn-webhook',
      script: 'src/tn-webhook.js',
      autorestart: true,             // proceso permanente — PM2 lo reinicia si cae
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
