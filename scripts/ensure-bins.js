#!/usr/bin/env node
/**
 * Ensure yt-dlp (+ ffprobe if missing) when npm binary packages are not installed.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const binDir = path.join(root, 'bin');

function ok(bin, args) {
  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return !r.error && (r.status === 0 || r.status === null);
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const go = (u, redirects = 0) => {
      https
        .get(u, { headers: { 'User-Agent': 'dc-downloader' } }, (res) => {
          if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            if (redirects > 8) {
              reject(new Error('Too many redirects'));
              return;
            }
            res.resume();
            go(res.headers.location, redirects + 1);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} downloading ${u}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        })
        .on('error', reject);
    };
    go(url);
  });
}

async function ensureExecutable(url, dest, { force = false } = {}) {
  fs.mkdirSync(binDir, { recursive: true });
  if (force || !fs.existsSync(dest) || !ok(dest, ['--version'])) {
    console.log(`[ensure-bins] downloading → ${dest}`);
    await download(url, dest);
    try {
      fs.chmodSync(dest, 0o755);
    } catch {
      // windows
    }
  }
  if (!ok(dest, ['--version'])) {
    throw new Error(`No se pudo preparar ${path.basename(dest)}`);
  }
  return dest;
}

async function ensureYtDlp() {
  if (process.env.YT_DLP_BIN && fs.existsSync(process.env.YT_DLP_BIN) && ok(process.env.YT_DLP_BIN, ['--version'])) {
    return process.env.YT_DLP_BIN;
  }
  if (ok('yt-dlp', ['--version'])) return 'yt-dlp';
  if (ok('/usr/bin/yt-dlp', ['--version'])) return '/usr/bin/yt-dlp';

  const target =
    process.platform === 'win32' ? path.join(binDir, 'yt-dlp.exe') : path.join(binDir, 'yt-dlp');

  const url =
    process.platform === 'win32'
      ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
      : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

  // Refresh at most once per day so yt-dlp stays current against YouTube changes.
  let stale = true;
  try {
    if (fs.existsSync(target)) {
      const ageMs = Date.now() - fs.statSync(target).mtimeMs;
      stale = ageMs > 24 * 60 * 60 * 1000;
    }
  } catch {
    stale = true;
  }
  if (!fs.existsSync(target) || !ok(target, ['--version']) || stale) {
    return ensureExecutable(url, target, { force: true });
  }
  return target;
}

async function ensureFfprobe() {
  if (process.env.FFPROBE_BIN && fs.existsSync(process.env.FFPROBE_BIN) && ok(process.env.FFPROBE_BIN, ['-version'])) {
    return process.env.FFPROBE_BIN;
  }
  if (ok('ffprobe', ['-version'])) return 'ffprobe';
  if (ok('/usr/bin/ffprobe', ['-version'])) return '/usr/bin/ffprobe';

  // Last resort: do not download multi-arch static packs (hundreds of MB).
  // Hosts without ffprobe should install the system package (or set FFPROBE_BIN).
  console.warn('[ensure-bins] ffprobe no encontrado en PATH; se usará "ffprobe" por defecto');
  return 'ffprobe';
}

async function main() {
  const ytdlp = await ensureYtDlp();
  const ffprobe = await ensureFfprobe();
  if (ytdlp && ytdlp !== 'yt-dlp') process.env.YT_DLP_BIN = ytdlp;
  if (ffprobe && ffprobe !== 'ffprobe') process.env.FFPROBE_BIN = ffprobe;
  console.log(`[ensure-bins] yt-dlp OK: ${ytdlp}`);
  console.log(`[ensure-bins] ffprobe OK: ${ffprobe}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[ensure-bins]', err.message || err);
    process.exit(1);
  });
}

module.exports = { ensureYtDlp, ensureFfprobe, main };
