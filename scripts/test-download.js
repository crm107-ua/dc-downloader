require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { downloadAndPrepare } = require('../src/services/downloader');
const { getConfig } = require('../src/config');

const FIXTURES = [
  {
    name: 'x',
    url: 'https://x.com/DaniXGameR__/status/2097294889646014570?s=20',
  },
  {
    name: 'reddit',
    url: 'https://www.reddit.com/user/-ActiveMatter-/comments/1w5hm4k/armas_reales_f%C3%ADsica_imposible_un_shooter_de/',
  },
  {
    name: 'youtube',
    url: 'https://www.youtube.com/watch?v=AjSKT5ovuIs',
  },
  {
    name: 'youtube-shortlink',
    url: 'https://youtu.be/AjSKT5ovuIs?is=Hk7moJ7RK_9P2P7l',
  },
  {
    name: 'tiktok',
    url: 'https://www.tiktok.com/@closepop/video/7653496247508028694',
  },
  {
    name: 'tiktok-query',
    url: 'https://www.tiktok.com/@closepop/video/7653496247508028694?is_from_webapp=1&sender_device=pc',
  },
  {
    name: 'instagram',
    url: 'https://www.instagram.com/reel/DdIKGyXyo6z/?stkn=MTU3ZXJwM2licnZuag==',
  },
  {
    name: 'instagram-2',
    url: 'https://www.instagram.com/reel/Dc4C0DNQ679/?stkn=NmFjajEydGd3cmts',
  },
  {
    name: 'instagram-3',
    url: 'https://www.instagram.com/reel/DZ8A-ziuOqA/?utm_source=ig_web_copy_link&stkn=NTc4MTIwNjQ2YQ==',
  },
  {
    name: 'instagram-carousel',
    url: 'https://www.instagram.com/p/DdRqAiEjMeb/?utm_source=ig_web_copy_link&stkn=NTc4MTIwNjQ2YQ',
  },
];

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

async function testOne(fixture) {
  const config = getConfig();
  console.log(`\n=== ${fixture.name.toUpperCase()} ===`);
  console.log(fixture.url);

  const result = await downloadAndPrepare(fixture.url);
  const okSize = result.sizeBytes <= config.maxFileSizeBytes;
  const okDuration = result.durationSeconds <= config.maxDurationSeconds;

  console.log(`title: ${result.title}`);
  console.log(`platform: ${result.platform}`);
  console.log(`duration: ${result.durationSeconds.toFixed(1)}s (limit ${config.maxDurationSeconds}s) ${okDuration ? 'OK' : 'FAIL'}`);
  console.log(`size: ${mb(result.sizeBytes)} MB (limit ${config.maxFileSizeMb} MB) ${okSize ? 'OK' : 'FAIL'}`);
  if (fixture.name === 'tiktok') {
    console.log(
      `watermark: ${result.hadWatermarkOnly ? 'ONLY watermarked formats available' : 'preferred non-watermark stream'}`
    );
  }

  // Keep a copy for manual inspection
  const outDir = path.resolve('temp', 'test-out');
  fs.mkdirSync(outDir, { recursive: true });
  const dest = path.join(outDir, `${fixture.name}.mp4`);
  fs.copyFileSync(result.filePath, dest);
  console.log(`saved: ${dest}`);

  result.cleanup();

  if (!okSize || !okDuration) {
    throw new Error(`${fixture.name} failed size/duration checks`);
  }

  return { name: fixture.name, sizeBytes: result.sizeBytes, durationSeconds: result.durationSeconds, dest };
}

async function main() {
  const only = process.argv[2];
  const list = only
    ? FIXTURES.filter((f) => f.name === only || f.name.startsWith(`${only}-`))
    : FIXTURES;
  if (!list.length) {
    console.error(`Unknown fixture "${only}". Use: x | reddit | youtube | tiktok | instagram`);
    process.exit(1);
  }

  const results = [];
  const failures = [];

  for (const fixture of list) {
    try {
      results.push(await testOne(fixture));
    } catch (err) {
      console.error(`FAIL ${fixture.name}:`, err.message || err);
      failures.push({ name: fixture.name, error: String(err.message || err) });
    }
  }

  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(`OK  ${r.name}: ${mb(r.sizeBytes)} MB, ${r.durationSeconds.toFixed(1)}s -> ${r.dest}`);
  }
  for (const f of failures) {
    console.log(`ERR ${f.name}: ${f.error}`);
  }

  if (failures.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
