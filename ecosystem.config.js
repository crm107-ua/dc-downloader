module.exports = {
  apps: [
    {
      name: 'dc-downloader',
      cwd: '/var/www/html/dc-downloader',
      script: 'src/index.js',
      interpreter: 'node',
      env: {
        PATH: '/home/carlos/.local/bin:/usr/local/bin:/usr/bin:/bin',
      },
    },
  ],
};
