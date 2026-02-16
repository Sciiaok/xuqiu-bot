/**
 * PM2 Ecosystem Configuration
 *
 * Start all services:
 *   pm2 start ecosystem.config.cjs
 *
 * Start only cron:
 *   pm2 start ecosystem.config.cjs --only lead-sync-cron
 */

module.exports = {
  apps: [
    {
      name: 'lead-engine-next',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
    },
    {
      name: 'lead-sync-cron',
      script: 'scripts/cron-sync-leads.js',
      cwd: __dirname,
      node_args: '--experimental-modules',
      env: {
        NODE_ENV: 'production',
        API_BASE_URL: 'http://localhost:3002',
      },
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '256M',
    },
  ],
};
