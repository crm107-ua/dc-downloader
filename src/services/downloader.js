const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getConfig } = require('../config');
const { resolveProviderByUrl } = require('../providers');
const { run, compressToLimit, probeDuration } = require('./compressor');
const { scheduleTempCleanup } = require('./tempCleanup');

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
  return 'bv*+ba/b';
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

async function downloadRaw(url, provider, outTemplate, config) {
  const args = [
    '--no-playlist',
    '--no-warnings',
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

  await run('yt-dlp', args);
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
 * Download, validate duration, compress under size limit.
 * Provider-specific behavior comes only from src/providers/*.
 */
async function downloadAndPrepare(url) {
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
    console.log(`[${platform}] checking duration before download (max ${config.maxDurationSeconds}s)...`);
    const meta = await fetchMetadata(url, config, provider);
    const preDuration = assertDuration(meta, config.maxDurationSeconds);
    if (preDuration != null) {
      console.log(`[${platform}] duration OK pre-download: ${preDuration}s`);
    } else {
      console.log(`[${platform}] duration missing in metadata; will verify after download`);
    }

    const outTemplate = path.join(jobDir, `${jobId}.%(ext)s`);
    console.log(`[${platform}] downloading...`);
    await downloadRaw(url, provider, outTemplate, config);

    const rawPath = findDownloadedFile(jobDir, jobId);
    const probed = await probeDuration(rawPath);
    if (probed > config.maxDurationSeconds) {
      const mins = Math.floor(config.maxDurationSeconds / 60);
      throw new Error(
        `El video dura ${Math.round(probed)}s y el máximo permitido es ${config.maxDurationSeconds}s (~${mins} min).`
      );
    }

    const compressedPath = path.join(jobDir, `${jobId}-out.mp4`);
    const compressed = await compressToLimit(
      rawPath,
      compressedPath,
      config.maxFileSizeBytes
    );

    const analysis =
      typeof provider.analyzeMeta === 'function' ? provider.analyzeMeta(meta) || {} : {};

    return {
      filePath: compressed.outputPath,
      title: meta.title || meta.id || 'video',
      platform,
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
