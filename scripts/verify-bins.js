#!/usr/bin/env node
/**
 * Smoke-check that ffmpeg / ffprobe / yt-dlp resolve (npm static or system).
 */
const { spawnSync } = require('child_process');
const { FFMPEG_BIN, FFPROBE_BIN, YT_DLP_BIN } = require('../src/utils/bins');

function check(label, bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  const ok = r.error == null && (r.status === 0 || r.status === null);
  const version = String(r.stdout || r.stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)[0];
  if (!ok && r.error) {
    console.error(`FAIL ${label}: ${r.error.message}`);
    console.error(`  path: ${bin}`);
    return false;
  }
  console.log(`OK  ${label}: ${bin}`);
  if (version) console.log(`    ${version.slice(0, 120)}`);
  return true;
}

let allOk = true;
allOk = check('ffmpeg', FFMPEG_BIN, ['-version']) && allOk;
allOk = check('ffprobe', FFPROBE_BIN, ['-version']) && allOk;
allOk = check('yt-dlp', YT_DLP_BIN, ['--version']) && allOk;

if (!allOk) {
  console.error('\nFaltan binarios. Instala ffmpeg/ffprobe en el sistema o define FFMPEG_BIN / FFPROBE_BIN / YT_DLP_BIN.');
  process.exit(1);
}
console.log('\nBinarios listos.');
