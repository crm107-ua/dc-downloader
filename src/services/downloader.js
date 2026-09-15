const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getConfig } = require('../config');
const { resolveProviderByUrl } = require('../providers');
const { run, compressToLimit, probeDuration, normalizeQualityMode } = require('./compressor');
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

function providerExtraArgs(provider, options = {}) {
  if (!provider || typeof provider.extraArgs !== 'function') return [];
  const args = provider.extraArgs(options);
  return Array.isArray(args) ? args : [];
}

function providerFormatSelector(provider, durationSeconds = null) {
  // Always prefer a high-quality source; compressor handles size with 2-pass.
  // Only slightly cap very long clips so download itself does not take forever.
  const dur = Number(durationSeconds);
  if (Number.isFinite(dur) && dur > 480) {
    return [
      'bv*[height<=720][vcodec^=avc1]+ba[ext=m4a]/b[height<=720][ext=mp4]',
      'bv*[height<=720]+ba/b[height<=720]',
      'best[height<=720]/best',
    ].join('/');
  }
  if (provider && typeof provider.formatSelector === 'function') {
    return provider.formatSelector();
  }
  const { FAST_FORMAT } = require('../providers/formats');
  return FAST_FORMAT;
}

function normalizeUrl(url, provider) {
  if (provider && typeof provider.normalizeUrl === 'function') {
    return provider.normalizeUrl(url);
  }
  return url;
}

function parseYtDlpPercent(text) {
  const match = /\[download\]\s+(\d{1,3}(?:\.\d+)?)%/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? Math.min(100, value) : null;
}

function parseDumpJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('yt-dlp no devolvió metadatos.');

  // Prefer a full JSON object even if warnings polluted stdout
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to line-based parse
    }
  }

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{') && l.endsWith('}'));
  if (!lines.length) {
    throw new Error('No se pudo parsear metadatos de yt-dlp (JSON inválido).');
  }
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Ask the provider (if it supports it) whether this URL is a multi-item carousel.
 */
async function listMediaChoices(url) {
  const config = getConfig();
  const provider = resolveProviderByUrl(url);
  if (!provider || typeof provider.listMediaChoices !== 'function') {
    return null;
  }
  const resolvedUrl = normalizeUrl(url, provider);
  return provider.listMediaChoices(resolvedUrl, {
    run,
    cookiesArgs: cookiesArgs(config),
  });
}

async function fetchMetadata(url, config, provider, downloadOptions = {}) {
  // Light metadata first — avoids multi‑MB dump-json parse issues on YouTube
  const printArgs = [
    '--no-playlist',
    '--no-warnings',
    '--skip-download',
    '--print',
    '%(.{id,title,duration,webpage_url})j',
    ...providerExtraArgs(provider, downloadOptions),
    ...cookiesArgs(config),
    url,
  ];

  try {
    const { stdout } = await run('yt-dlp', printArgs, { timeoutMs: 90000 });
    const meta = parseDumpJson(stdout);
    if (meta && (meta.id || meta.title || meta.duration != null)) {
      return meta;
    }
  } catch {
    // Fallback below
  }

  const args = [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    ...providerExtraArgs(provider, downloadOptions),
    ...cookiesArgs(config),
    url,
  ];
  const { stdout } = await run('yt-dlp', args, { timeoutMs: 120000 });
  return parseDumpJson(stdout);
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

async function downloadRaw(url, provider, outTemplate, config, onDownloadPercent, durationSeconds = null, downloadOptions = {}) {
  const isPhoto = downloadOptions.mediaKind === 'photo';
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '--no-write-subs',
    '--no-write-auto-subs',
    ...providerExtraArgs(provider, downloadOptions),
  ];

  if (!isPhoto) {
    args.push(
      '-f',
      providerFormatSelector(provider, durationSeconds),
      '--merge-output-format',
      'mp4'
    );
  }

  args.push('-o', outTemplate, ...cookiesArgs(config), url);

  let buffer = '';
  await run('yt-dlp', args, {
    timeoutMs: 300000,
    rollingBuffer: true,
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
    throw new Error('yt-dlp no produjo un archivo descargable.');
  }
  return path.join(jobDir, match);
}

function isImagePath(filePath) {
  return /\.(jpe?g|png|webp|gif)$/i.test(filePath);
}

/**
 * @param {string} url
 * @param {{
 *   onProgress?: (percent: number, stage: string) => void | Promise<void>,
 *   qualityMode?: string,
 *   playlistItem?: number,
 *   mediaKind?: 'video'|'photo',
 * }} [options]
 */
async function downloadAndPrepare(url, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const config = getConfig();
  const provider = resolveProviderByUrl(url);
  if (!provider) {
    throw new Error('Plataforma no soportada.');
  }
  const platform = provider.id;
  // Default auto for every provider unless the user picks calidad
  const qualityMode = normalizeQualityMode(options.qualityMode || 'auto');
  const resolvedUrl = normalizeUrl(url, provider);
  const downloadOptions = {
    playlistItem: options.playlistItem,
    mediaKind: options.mediaKind === 'photo' ? 'photo' : 'video',
  };
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
    console.log(`[${platform}] url=${resolvedUrl}`);
    console.log(`[${platform}] qualityMode=${qualityMode}`);
    if (downloadOptions.playlistItem) {
      console.log(
        `[${platform}] carousel item=${downloadOptions.playlistItem} kind=${downloadOptions.mediaKind}`
      );
    }

    let meta = { title: 'media', id: jobId };
    let preDuration = null;

    if (downloadOptions.mediaKind !== 'photo') {
      meta = await fetchMetadata(resolvedUrl, config, provider, downloadOptions);
      preDuration = assertDuration(meta, config.maxDurationSeconds);
      if (preDuration != null) {
        console.log(`[${platform}] duration OK pre-download: ${preDuration}s`);
      } else {
        console.log(`[${platform}] duration missing in metadata; will verify after download`);
      }
    } else {
      console.log(`[${platform}] photo item — skipping video duration check`);
    }
    await onProgress(8, 'metadata');

    const outTemplate = path.join(jobDir, `${jobId}.%(ext)s`);
    console.log(`[${platform}] downloading...`);
    await onProgress(8, 'download');
    await downloadRaw(
      resolvedUrl,
      provider,
      outTemplate,
      config,
      (dlPct) => {
        onProgress(mapRange(dlPct, 8, 72), 'download');
      },
      preDuration,
      downloadOptions
    );
    await onProgress(72, 'download');

    const rawPath = findDownloadedFile(jobDir, jobId);

    // Photo / image path: no FFmpeg compress, just size-check and return
    if (downloadOptions.mediaKind === 'photo' || isImagePath(rawPath)) {
      const sizeBytes = fs.statSync(rawPath).size;
      if (sizeBytes > config.maxFileSizeBytes) {
        throw new Error(
          `La imagen pesa ${(sizeBytes / 1024 / 1024).toFixed(1)} MB y el máximo es ${config.maxFileSizeMb} MB.`
        );
      }
      await onProgress(95, 'compress');
      return {
        filePath: rawPath,
        title: meta.title || meta.id || 'foto',
        platform,
        providerLabel: provider.label,
        qualityMode,
        mediaType: 'image',
        sizeBytes,
        durationSeconds: 0,
        hadWatermarkOnly: false,
        cleanup,
      };
    }

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
      },
      { qualityMode }
    );
    await onProgress(95, 'compress');

    const analysis =
      typeof provider.analyzeMeta === 'function' ? provider.analyzeMeta(meta) || {} : {};

    return {
      filePath: compressed.outputPath,
      title: meta.title || meta.id || 'video',
      platform,
      providerLabel: provider.label,
      qualityMode,
      mediaType: 'video',
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
  listMediaChoices,
  providerFormatSelector,
  parseDumpJson,
  normalizeUrl,
};
