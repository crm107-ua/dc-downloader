require('dotenv').config();
const { downloadAndPrepare } = require('../src/services/downloader');
const { getConfig } = require('../src/config');

const url = process.argv[2] || 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

(async () => {
  const config = getConfig();
  console.log('r2Enabled', config.r2Enabled);
  console.log('url', url);
  const result = await downloadAndPrepare(url, {
    qualityMode: 'alta',
    onProgress: (p, s) => {
      if (p === 0 || p >= 99 || Math.round(p) % 20 === 0) console.log(`progress ${Math.round(p)}% ${s}`);
    },
  });
  console.log({
    delivery: result.delivery,
    publicUrl: result.publicUrl,
    sizeMB: (result.sizeBytes / 1024 / 1024).toFixed(2),
    duration: result.durationSeconds,
    title: result.title,
  });
  if (result.publicUrl) {
    const head = await fetch(result.publicUrl, { method: 'HEAD' });
    console.log('HEAD', head.status, head.headers.get('content-type'), head.headers.get('content-length'), head.headers.get('accept-ranges'));
  }
  result.cleanup();
})().catch((err) => {
  console.error('FAIL', err.message || err);
  process.exit(1);
});
