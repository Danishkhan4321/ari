module.exports = {
  apps: [
    {
      name: 'ari-backend',
      script: 'src/index.js',
      instances: process.env.PM2_INSTANCES || 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: process.env.PM2_MAX_MEMORY || '512M',
      env: {
        NODE_ENV: 'production'
      },
      kill_timeout: 10000,
      listen_timeout: 8000,
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000,
      exp_backoff_restart_delay: 100
    },
    {
      // Web dashboard — served by Next.js on port 3001 (Nginx in front does
      // TLS only when explicitly configured). Reads/writes the same Postgres as the
      // bot. See dashboard/README.md.
      name: 'ari-dashboard',
      cwd: './dashboard',
      script: 'node_modules/next/dist/bin/next',
      args: 'start -p 3001',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        PORT: 3001
      },
      kill_timeout: 10000,
      listen_timeout: 15000,
      error_file: './logs/dashboard-error.log',
      out_file: './logs/dashboard-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 4000
    }
  ]
};
