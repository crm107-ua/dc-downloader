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
    name: 'reddit-gif-short',
    url: 'https://www.reddit.com/r/projectzomboid/s/B9NLvBniBk',
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
    name: 'tiktok-restricted',
    url: 'https://vm.tiktok.com/ZGdQfwNaq/',
  },
  {
    name: 'instagram',
    url: 'https://www.instagram.com/reel/DdRMf9oI-gg/?stkn=czE3cjY2azJyNjBr',
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
    name: 'instagram-carousel-video',
    url: 'https://www.instagram.com/p/DdRqAiEjMeb/?utm_source=ig_web_copy_link&stkn=NTc4MTIwNjQ2YQ',
    playlistItem: 1,
    mediaKind: 'video',
  },
  {
    name: 'instagram-carousel-photo',
    url: 'https://www.instagram.com/p/DdRqAiEjMeb/?utm_source=ig_web_copy_link&stkn=NTc4MTIwNjQ2YQ',
    playlistItem: 2,
    mediaKind: 'photo',
  },
  {
    name: 'instagram-carousel-select',
    url: 'https://www.instagram.com/p/DdRqAiEjMeb/?utm_source=ig_web_copy_link&stkn=NTc4MTIwNjQ2YQ',
    /** Only exercises listMediaChoices (Discord Select Menu), no download. */
    listChoicesOnly: true,
  },
  {
    name: 'facebook-reel',
    url: 'https://www.facebook.com/reel/1376505661262497',
  },
  {
    name: 'facebook-watch',
    url: 'https://fb.watch/v/3m6DCkaa-/',
  },
];

function mb(bytes) {
  return (bytes / 1024 / 1024).toFixed(2);
}

async function testCarouselSelect(fixture) {
  const { listMediaChoices } = require('../src/services/downloader');
  console.log(`\n=== ${fixture.name.toUpperCase()} ===`);
  console.log(fixture.url);
  const choices = await listMediaChoices(fixture.url);
  if (!choices || !choices.isCarousel) {
    throw new Error('Se esperaba un carrusel de Instagram (isCarousel=true)');
  }
  if (!Array.isArray(choices.items) || choices.items.length < 2) {
    throw new Error(`Carrusel con pocos ítems: ${choices.items && choices.items.length}`);
  }
  const kinds = new Set(choices.items.map((i) => i.kind));
  console.log(`title: ${choices.title}`);
  console.log(`items: ${choices.items.length} (${[...kinds].join(', ')})`);
  for (const item of choices.items) {
    console.log(`  - ${item.label} [index=${item.index} kind=${item.kind}]`);
  }
  return {
    name: fixture.name,
    sizeBytes: 0,
    durationSeconds: 0,
    mediaType: 'carousel-select',
    dest: '(listMediaChoices only)',
  };
}

async function testOne(fixture) {
  if (fixture.listChoicesOnly) {
    return testCarouselSelect(fixture);
  }

  const config = getConfig();
  console.log(`\n=== ${fixture.name.toUpperCase()} ===`);
  console.log(fixture.url);

  const result = await downloadAndPrepare(fixture.url, {
    playlistItem: fixture.playlistItem,
    mediaKind: fixture.mediaKind,
  });
  const okSize = result.sizeBytes <= config.maxFileSizeBytes;
  const okDuration =
    result.mediaType === 'image' || result.durationSeconds <= config.maxDurationSeconds;

  console.log(`title: ${result.title}`);
  console.log(`platform: ${result.platform}`);
  console.log(`mediaType: ${result.mediaType || 'video'}`);
  if (result.mediaType === 'image') {
    console.log(`size: ${mb(result.sizeBytes)} MB (limit ${config.maxFileSizeMb} MB) ${okSize ? 'OK' : 'FAIL'}`);
  } else {
    console.log(`duration: ${result.durationSeconds.toFixed(1)}s (limit ${config.maxDurationSeconds}s) ${okDuration ? 'OK' : 'FAIL'}`);
    console.log(`size: ${mb(result.sizeBytes)} MB (limit ${config.maxFileSizeMb} MB) ${okSize ? 'OK' : 'FAIL'}`);
  }
  if (fixture.name === 'tiktok') {
    console.log(
      `watermark: ${result.hadWatermarkOnly ? 'ONLY watermarked formats available' : 'preferred non-watermark stream'}`
    );
  }

  // Keep a copy for manual inspection
  const outDir = path.resolve('temp', 'test-out');
  fs.mkdirSync(outDir, { recursive: true });
  const ext = result.mediaType === 'image' ? path.extname(result.filePath) || '.jpg' : '.mp4';
  const dest = path.join(outDir, `${fixture.name}${ext}`);
  fs.copyFileSync(result.filePath, dest);
  console.log(`saved: ${dest}`);

  // Discord-safe: Instagram/Facebook outputs must be H.264 (not VP9/AV1 stream-copy).
  if (result.mediaType !== 'image' && /\.(mp4|m4v|mov)$/i.test(dest)) {
    const { spawnSync } = require('child_process');
    const probe = spawnSync(
      'ffprobe',
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', dest],
      { encoding: 'utf8', windowsHide: true }
    );
    const codec = String(probe.stdout || '').trim().toLowerCase();
    console.log(`vcodec: ${codec || '(none)'}`);
    if (codec && !(codec === 'h264' || codec === 'avc1' || codec.startsWith('avc'))) {
      throw new Error(`${fixture.name}: codec ${codec} no es H.264 (Discord congelaría el vídeo)`);
    }
  }

  result.cleanup();

  if (!okSize || !okDuration) {
    throw new Error(`${fixture.name} failed size/duration checks`);
  }

  return {
    name: fixture.name,
    sizeBytes: result.sizeBytes,
    durationSeconds: result.durationSeconds,
    mediaType: result.mediaType || 'video',
    dest,
  };
}

async function main() {
  const only = process.argv[2];
  const list = only
    ? FIXTURES.filter((f) => f.name === only || f.name.startsWith(`${only}-`))
    : FIXTURES;
  if (!list.length) {
    console.error(
      `Unknown fixture "${only}". Use: x | reddit | youtube | tiktok | instagram | facebook`
    );
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
    const dur =
      r.mediaType === 'image'
        ? 'image'
        : r.mediaType === 'carousel-select'
          ? 'selector'
          : `${Number(r.durationSeconds || 0).toFixed(1)}s`;
    console.log(`OK  ${r.name}: ${mb(r.sizeBytes)} MB, ${dur} -> ${r.dest}`);
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
