#!/usr/bin/env node
/**
 * Quick caption/descripcion path check (no full download).
 */
require('dotenv').config();
const { resolveProviderByUrl } = require('../src/providers');

async function main() {
  const cases = [
    {
      name: 'x',
      url: 'https://x.com/0xmovez/status/2114776375412363288',
    },
    {
      name: 'reddit',
      url: 'https://www.reddit.com/r/espanahabla/s/h1CEMLhbmU',
    },
  ];
  for (const c of cases) {
    const provider = resolveProviderByUrl(c.url);
    if (!provider) {
      console.log(`FAIL ${c.name}: no provider`);
      continue;
    }
    let caption = null;
    if (typeof provider.resolveCaption === 'function') {
      caption = await provider.resolveCaption(c.url);
    }
    const preview = caption
      ? String(caption).replace(/\n/g, '\\n').slice(0, 160)
      : '(empty)';
    console.log(`${caption ? 'OK' : 'WARN'} ${c.name}: ${preview}`);
  }

  // Slash option present in builder
  const video = require('../src/commands/video');
  const data = video.data.toJSON();
  const opts = (data.options || []).map((o) => o.name);
  console.log(opts.includes('descripcion') ? 'OK slash:descripcion' : 'FAIL slash:descripcion');
  console.log(opts.includes('calidad') ? 'OK slash:calidad' : 'FAIL slash:calidad');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
