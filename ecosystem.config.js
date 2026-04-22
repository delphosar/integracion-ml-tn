module.exports = {
  apps: [
    {
      name: 'ml-tn-sync-delta',
      script: 'src/sync-delta.js',
      cron_restart: '*/30 * * * *', // cada 30 minutos
      autorestart: false,            // es un script puntual, no un daemon
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'ml-tn-sync-new-items',
      script: 'src/sync-new-items.js',
      cron_restart: '0 */2 * * *',  // cada 2 horas
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
