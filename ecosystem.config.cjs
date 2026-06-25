module.exports = {
  apps: [
    {
      name: 'donut-headless-bots',
      script: 'src/index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '700M',
      restart_delay: 10000,
      out_file: './logs/pm2-out.log',
      error_file: './logs/pm2-error.log',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
