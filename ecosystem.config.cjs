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
      script: 'node_modules/.bin/next',  // ← 直接调用 next
      args: 'start',
      cwd: __dirname,
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      out_file: 'logs/app-out.log',
      error_file: 'logs/app-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
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
      out_file: 'logs/lead-sync-out.log',
      error_file: 'logs/lead-sync-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'queue-cron',
      script: 'scripts/cron-process-queue.js',
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
      out_file: 'logs/queue-cron-out.log',
      error_file: 'logs/queue-cron-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
    {
      name: 'report-cron',
      script: 'scripts/cron-generate-reports.js',
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
      out_file: 'logs/report-cron-out.log',
      error_file: 'logs/report-cron-error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
    },
  ],
};
