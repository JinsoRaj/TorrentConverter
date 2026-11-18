// pm2 process file:  pm2 start ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: 'torrentconverter',
      script: 'bot.js',
      cwd: __dirname,
      // Run this bot on a specific Node.js binary (e.g. one installed with nvm)
      // without changing the system Node used by other apps:
      //   NODE_BIN="$(nvm which 24)" pm2 start ecosystem.config.cjs
      interpreter: process.env.NODE_BIN || 'node',
      // Telegram allows only ONE polling instance per bot token: never use cluster mode.
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Back off when crashing in a loop (e.g. network down) instead of hammering Telegram.
      exp_backoff_restart_delay: 1000,
      // Keep the bot small on a shared 1 GB server: cap V8's heap, and let pm2
      // restart it gracefully if total memory ever passes 400 MB.
      node_args: ['--max-old-space-size=192'],
      max_memory_restart: '400M',
      // Time to finish/abort in-flight conversions and save DHT state on restart.
      kill_timeout: 10000,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
