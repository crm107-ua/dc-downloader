#!/usr/bin/env node
/**
 * E2E smoke for Spotify→YouTube + Reddit without Discord.
 * Usage: node scripts/e2e-smoke.js [spotify|reddit|all]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { downloadAndPrepare } = require('../src/services/downloader');

const CASES = {
  spotify_goth: {
    url: 'https://open.spotify.com/intl-es/track/0uMZbmAAgOhdMrv25iPEH6?si=6cb6b9d778794f10',
  },
  spotify_amor: {
    url: 'https://open.spotify.com/intl-es/track/6PSFclnJArpyAdCKczoK07?si=1c4da79f81bb4954',
  },
  reddit: {
    url: 'https://www.reddit.com/r/espanahabla/s/h1CEMLhbmU',
  },
};

async function runOne(name, spec) {
  const t0 = Date.now();
  console.log(`\n=== ${name} ===\n${spec.url}`);
  try {
    const result = await downloadAndPrepare(spec.url, {
      qualityMode: 'auto',
      onProgress: () => {},
    });
    const size = result.sizeBytes || (result.filePath && fs.statSync(result.filePath).size) || 0;
    console.log(
      `OK ${name}: ${(size / 1024 / 1024).toFixed(2)} MB, ${result.durationSeconds || 0}s, delivery=${result.delivery || 'file'}, platform=${result.platform}`
    );
    if (typeof result.cleanup === 'function') result.cleanup();
    return { name, ok: true, ms: Date.now() - t0, size };
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message || err}`);
    return { name, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
  }
}

async function main() {
  const arg = String(process.argv[2] || 'all').toLowerCase();
  const keys =
    arg === 'all'
      ? Object.keys(CASES)
      : arg === 'spotify'
        ? ['spotify_goth', 'spotify_amor']
        : Object.keys(CASES).filter((k) => k.startsWith(arg));
  if (!keys.length) {
    console.error('Usage: node scripts/e2e-smoke.js [all|spotify|reddit|spotify_goth|spotify_amor]');
    process.exit(2);
  }
  const results = [];
  for (const k of keys) {
    results.push(await runOne(k, CASES[k]));
  }
  console.log('\n=== SUMMARY ===');
  for (const r of results) {
    console.log(r.ok ? `OK  ${r.name} (${r.ms}ms)` : `ERR ${r.name}: ${r.error}`);
  }
  const failed = results.filter((r) => !r.ok);
  process.exit(failed.length ? 1 : 0);
}

main();
