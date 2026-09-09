const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getConfig } = require('../config');
const { resolveProviderByUrl } = require('../providers');
const { run, compressToLimit, probeDuration } = require('./compressor');
const { scheduleTempCleanup } = require('./tempCleanup');
const { mapRange } = require('../utils/progress');

function ensureTempDir(tempDir) {
  const absolute = path.resolve(tempDir);
  fs.mkdirSync(absolute, { recursive: true });
  return absolute;
}

function cookiesArgs(config) {
  const args = [];
  if (config.cookiesFile) {
    const resolved = path.resolve(config.cookiesFile);
    if (!fs.existsSync(resolved)) {
      throw new Error(`COOKIES_FILE no existe: ${resolved}`);
    }
    args.push('--cookies', resolved);
  }
  if (config.cookiesFromBrowser) {
    args.push('--cookies-from-browser', config.cookiesFromBrowser);
  }
  return args;
}

function providerExtraArgs(provider) {
  if (!provider || typeof provider.extraArgs !== 'function') return [];
  const args = provider.extraArgs();
  return Array.isArray(args) ? args : [];
}

function providerFormatSelector(provider) {
  if (provider && typeof provider.formatSelector === 'function') {
    return provider.formatSelector();
  }
  const { FAST_FORMAT } = require('../providers/formats');
  return FAST_FORMAT;
}

function parseYtDlpPercent(text) {
  // [download]  45.2% of ...  OR  [download] 100% of ...
  const match = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, value) : null;
}

async function fetchMetadata(url, config, provider) {
  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    ...providerExtraArgs(provider),
    ...cookiesArgs(config),
    url,
  ];
  const { stdout } = await run('yt-dlp', args);
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const jsonLine = lines[lines.length - 1];
  return JSON.parse(jsonLine);
}

function assertDuration(meta, maxDurationSeconds) {
  const duration = Number(meta.duration);
  if (!Number.isFinite(duration)) {
    return null;
  }
  if (duration > maxDurationSeconds) {
    const mins = Math.floor(maxDurationSeconds / 60);
    throw new Error(
      `El video dura ${Math.round(duration)}s y el máximo permitido es ${maxDurationSeconds}s (~${mins} min).`
    );
  }
  return duration;
}

async function downloadRaw(url, provider, outTemplate, config, onDownloadPercent) {
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    ...providerExtraArgs(provider),
    '-f',
    providerFormatSelector(provider),
    '-o',
    outTemplate,
    '--merge-output-format',
    'mp4',
    ...cookiesArgs(config),
    url,
  ];

  let buffer = '';
  await run('yt-dlp', args, {
    onStderr: (text) => {
      buffer += text;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const line of parts) {
        const pct = parseYtDlpPercent(line);
        if (pct != null && typeof onDownloadPercent === 'function') {
          onDownloadPercent(pct);
        }
      }
    },
  });

  if (typeof onDownloadPercent === 'function') onDownloadPercent(100);
}

function findDownloadedFile(jobDir, jobId) {
  const entries = fs.readdirSync(jobDir);
  const match = entries.find((name) => name.startsWith(jobId) && !name.endsWith('.json'));
  if (!match) {
    throw new Error('yt-dlp no produjo un archivo de video.');
  }
  return path.join(jobDir, match);
}

/**
 * @param {string} url
 * @param {{ onProgress?: (percent: number, stage: string) => void | Promise<void> }} [options]
 */
async function downloadAndPrepare(url, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const config = getConfig();
  const provider = resolveProviderByUrl(url);
  if (!provider) {
    throw new Error('Plataforma no soportada.');
  }
  const platform = provider.id;
  const tempRoot = ensureTempDir(config.tempDir);

  scheduleTempCleanup();

  const jobId = randomUUID();
  const jobDir = path.join(tempRoot, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const cleanup = () => {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  try {
    await onProgress(2, 'metadata');
    console.log(`[${platform}] checking duration before download (max ${config.maxDurationSeconds}s)...`);
    const meta = await fetchMetadata(url, config, provider);
    const preDuration = assertDuration(meta, config.maxDurationSeconds);
    if (preDuration != null) {
      console.log(`[${platform}] duration OK pre-download: ${preDuration}s`);
    } else {
      console.log(`[${platform}] duration missing in metadata; will verify after download`);
    }
    await onProgress(8, 'metadata');

    const outTemplate = path.join(jobDir, `${jobId}.%(ext)s`);
    console.log(`[${platform}] downloading...`);
    await onProgress(8, 'download');
    await downloadRaw(url, provider, outTemplate, config, (dlPct) => {
      onProgress(mapRange(dlPct, 8, 72), 'download');
    });
    await onProgress(72, 'download');

    const rawPath = findDownloadedFile(jobDir, jobId);
    const probed = await probeDuration(rawPath);
    if (probed > config.maxDurationSeconds) {
      const mins = Math.floor(config.maxDurationSeconds / 60);
      throw new Error(
        `El video dura ${Math.round(probed)}s y el máximo permitido es ${config.maxDurationSeconds}s (~${mins} min).`
      );
    }

    const compressedPath = path.join(jobDir, `${jobId}-out.mp4`);
    await onProgress(72, 'compress');
    const compressed = await compressToLimit(
      rawPath,
      compressedPath,
      config.maxFileSizeBytes,
      (ratio) => {
        onProgress(mapRange(ratio, 72, 95), 'compress');
      }
    );
    await onProgress(95, 'compress');

    const analysis =
      typeof provider.analyzeMeta === 'function' ? provider.analyzeMeta(meta) || {} : {};

    return {
      filePath: compressed.outputPath,
      title: meta.title || meta.id || 'video',
      platform,
      providerLabel: provider.label,
      sizeBytes: compressed.sizeBytes,
      durationSeconds: compressed.durationSeconds,
      hadWatermarkOnly: Boolean(analysis.hadWatermarkOnly),
      cleanup,
    };
  } catch (err) {
    cleanup();
    throw err;
  }
}

module.exports = {
  downloadAndPrepare,
  fetchMetadata,
  providerFormatSelector,
};
