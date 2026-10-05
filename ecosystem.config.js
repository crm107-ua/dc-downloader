module.exports = {
  apps: [
    {
      name: 'dc-downloader',
      cwd: '/var/www/html/dc-downloader',
      script: 'src/index.js',
      interpreter: 'node',
      env: {
        PATH: '/home/carlos/.local/bin:/usr/local/bin:/usr/bin:/bin',
        // Prefer modern yt-dlp (avoids googlevideo 403 from old /usr/local/bin).
        YT_DLP_BIN: '/home/carlos/.local/bin/yt-dlp',
        // BOT_OFFLINE: '1', // uncomment → "Servidor apagado, prueba más tarde."
      },
    },
  ],
};
