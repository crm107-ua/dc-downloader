const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Prefer system binaries (PATH / env); optional npm static packages as fallback.
 * Optional npm static packages are NOT required.
 */

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function resolveFfmpegBin() {
  if (process.env.FFMPEG_BIN) return process.env.FFMPEG_BIN;
  const system = firstExisting([
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
  ]);
  if (system) return system;
  try {
    const fromNpm = require('ffmpeg-static');
    if (fromNpm && fs.existsSync(fromNpm)) return fromNpm;
  } catch {
    // optional
  }
  return 'ffmpeg';
}

function resolveFfprobeBin() {
  if (process.env.FFPROBE_BIN) return process.env.FFPROBE_BIN;
  const system = firstExisting([
    '/usr/bin/ffprobe',
    '/usr/local/bin/ffprobe',
    'C:\\ffmpeg\\bin\\ffprobe.exe',
  ]);
  if (system) return system;
  const local = firstExisting([
    path.join(__dirname, '..', '..', 'bin', process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'),
  ]);
  if (local) return local;
  try {
    const mod = require('ffprobe-static');
    const fromNpm = mod && (mod.path || mod);
    if (typeof fromNpm === 'string' && fs.existsSync(fromNpm)) return fromNpm;
  } catch {
    // optional
  }
  return 'ffprobe';
}

function resolveYtDlpBin() {
  if (process.env.YT_DLP_BIN) return process.env.YT_DLP_BIN;

  const localBin = firstExisting([
    path.join(__dirname, '..', '..', 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp'),
  ]);
  if (localBin) return localBin;

  try {
    const constants = require('youtube-dl-exec/src/constants');
    if (constants && constants.YOUTUBE_DL_PATH && fs.existsSync(constants.YOUTUBE_DL_PATH)) {
      return constants.YOUTUBE_DL_PATH;
    }
  } catch {
    // optional
  }

  return (
    firstExisting([
      path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
      '/usr/local/bin/yt-dlp',
      '/usr/bin/yt-dlp',
    ]) || 'yt-dlp'
  );
}

const FFMPEG_BIN = resolveFfmpegBin();
const FFPROBE_BIN = resolveFfprobeBin();
const YT_DLP_BIN = resolveYtDlpBin();

function resolveBin(command) {
  const name = String(command || '');
  if (name === 'ffmpeg' || /(^|[\\/])ffmpeg(\.exe)?$/i.test(name)) return FFMPEG_BIN;
  if (name === 'ffprobe' || /(^|[\\/])ffprobe(\.exe)?$/i.test(name)) return FFPROBE_BIN;
  if (name === 'yt-dlp' || /(^|[\\/])yt-dlp(\.exe)?$/i.test(name)) return YT_DLP_BIN;
  return command;
}

module.exports = {
  FFMPEG_BIN,
  FFPROBE_BIN,
  YT_DLP_BIN,
  resolveBin,
  resolveFfmpegBin,
  resolveFfprobeBin,
  resolveYtDlpBin,
};
