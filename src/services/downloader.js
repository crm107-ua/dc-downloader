const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { getConfig } = require('../config');
const { resolveProviderByUrl } = require('../providers');
const { run, compressToLimit, prepareForHostedDelivery, probeDuration, normalizeQualityMode } = require('./compressor');
const { scheduleTempCleanup } = require('./tempCleanup');
const {
  isR2Configured,
  uploadFile,
  buildObjectKey,
  enforceStorageBudget,
} = require('./r2Storage');
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

function providerFormatSelector(provider, durationSeconds = null, options = {}) {
  // Hosted/R2 path: keep full source quality (up to 1080p H.264).
  if (options.hostedDelivery) {
    if (provider && typeof provider.formatSelector === 'function') {
      return provider.formatSelector();
    }
    const { FAST_FORMAT } = require('../providers/formats');
    return FAST_FORMAT;
  }
  // Attachment path: slightly cap very long clips so download+compress stay practical.
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

async function downloadRaw(
  url,
  provider,
  outTemplate,
  config,
  onDownloadPercent,
  durationSeconds = null,
  downloadOptions = {}
) {
  const isPhoto = downloadOptions.mediaKind === 'photo';
  const hostedDelivery = Boolean(downloadOptions.hostedDelivery);
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
      providerFormatSelector(provider, durationSeconds, { hostedDelivery }),
      '--merge-output-format',
      'mp4'
    );
  }

  args.push('-o', outTemplate, ...cookiesArgs(config), url);

  const timeoutMs = hostedDelivery
    ? Math.min(60 * 60 * 1000, Math.max(15 * 60 * 1000, Math.ceil(Number(durationSeconds || 600) * 8000)))
    : 300000;

  let buffer = '';
  await run('yt-dlp', args, {
    timeoutMs,
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

async function downloadDirectUrl(directUrl, destPath, onDownloadPercent, requestHeaders = null) {
  const headers =
    requestHeaders && typeof requestHeaders === 'object' ? { ...requestHeaders } : undefined;
  const res = await fetch(directUrl, { redirect: 'follow', headers });
  if (!res.ok) {
    throw new Error(`Descarga directa falló (HTTP ${res.status}).`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) {
    throw new Error('La descarga directa no devolvió datos.');
  }
  fs.writeFileSync(destPath, buffer);
  if (typeof onDownloadPercent === 'function') onDownloadPercent(100);
}

function fallbackDestPath(jobDir, jobId, fb) {
  const kind = fb.mediaKind === 'image' || fb.mediaKind === 'photo' ? 'image' : 'video';
  let ext = typeof fb.fileExt === 'string' ? fb.fileExt : '';
  if (!ext) {
    const fromUrl = /\.([a-z0-9]+)(?:\?|$)/i.exec(fb.directUrl || '');
    ext = fromUrl ? `.${fromUrl[1].toLowerCase()}` : kind === 'image' ? '.jpg' : '.mp4';
  }
  if (!ext.startsWith('.')) ext = `.${ext}`;
  return path.join(jobDir, `${jobId}${ext}`);
}

async function resolveFallbackMedia(provider, resolvedUrl) {
  if (typeof provider.fetchFallbackMedia !== 'function') {
    throw new Error('Provider sin fallback.');
  }
  return provider.fetchFallbackMedia(resolvedUrl, { run });
}

async function runYtdlpVideoPipeline({
  resolvedUrl,
  provider,
  config,
  downloadOptions,
  qualityMode,
  platform,
  jobDir,
  jobId,
  onProgress,
  maxDurationSeconds,
}) {
  const durationCap =
    Number.isFinite(maxDurationSeconds) && maxDurationSeconds > 0
      ? maxDurationSeconds
      : config.maxDurationSeconds;
  let meta = { title: 'media', id: jobId };
  let preDuration = null;
  let usedFallback = false;
  let fallbackAnalysis = {};

  if (downloadOptions.mediaKind !== 'photo') {
    try {
      meta = await fetchMetadata(resolvedUrl, config, provider, downloadOptions);
      preDuration = assertDuration(meta, durationCap);
      if (preDuration != null) {
        console.log(`[${platform}] duration OK pre-download: ${preDuration}s`);
      } else {
        console.log(`[${platform}] duration missing in metadata; will verify after download`);
      }
    } catch (err) {
      if (typeof provider.fetchFallbackMedia !== 'function') throw err;
      console.warn(`[${platform}] yt-dlp metadata failed, trying fallback: ${err.message || err}`);
      const fb = await resolveFallbackMedia(provider, resolvedUrl);
      if (fb.durationSeconds != null) {
        assertDuration({ duration: fb.durationSeconds }, durationCap);
      }
      meta = { title: fb.title, id: fb.id || jobId, duration: fb.durationSeconds };
      preDuration = fb.durationSeconds;
      usedFallback = fb;
      fallbackAnalysis = { hadWatermarkOnly: Boolean(fb.hadWatermarkOnly) };
    }
  } else {
    console.log(`[${platform}] photo item — skipping video duration check`);
  }

  await onProgress(8, 'metadata');

  const outTemplate = path.join(jobDir, `${jobId}.%(ext)s`);
  let rawPath;

  console.log(`[${platform}] downloading...`);
  await onProgress(8, 'download');

  if (usedFallback && usedFallback.directUrl) {
    rawPath = fallbackDestPath(jobDir, jobId, usedFallback);
    await downloadDirectUrl(
      usedFallback.directUrl,
      rawPath,
      (dlPct) => {
        onProgress(mapRange(dlPct, 8, 72), 'download');
      },
      usedFallback.requestHeaders || null
    );
  } else {
    try {
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
      rawPath = findDownloadedFile(jobDir, jobId);
    } catch (err) {
      if (typeof provider.fetchFallbackMedia !== 'function') throw err;
      console.warn(`[${platform}] yt-dlp download failed, trying fallback: ${err.message || err}`);
      const fb = await resolveFallbackMedia(provider, resolvedUrl);
      if (fb.durationSeconds != null) {
        assertDuration({ duration: fb.durationSeconds }, durationCap);
      }
      meta = { title: fb.title, id: fb.id || meta.id || jobId, duration: fb.durationSeconds };
      fallbackAnalysis = { hadWatermarkOnly: Boolean(fb.hadWatermarkOnly) };
      rawPath = fallbackDestPath(jobDir, jobId, fb);
      await downloadDirectUrl(
        fb.directUrl,
        rawPath,
        (dlPct) => {
          onProgress(mapRange(dlPct, 8, 72), 'download');
        },
        fb.requestHeaders || null
      );
      usedFallback = fb;
    }
  }

  await onProgress(72, 'download');

  return { meta, rawPath, fallbackAnalysis, qualityMode, usedFallback, preDuration };
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
    const r2Ready = isR2Configured(config);
    const durationCap = config.maxDurationSeconds;
    console.log(
      `[${platform}] checking duration before download (max ${durationCap}s${r2Ready ? ', R2 long-video ready' : ''})...`
    );
    console.log(`[${platform}] url=${resolvedUrl}`);
    console.log(`[${platform}] qualityMode=${qualityMode}`);
    if (downloadOptions.playlistItem) {
      console.log(
        `[${platform}] carousel item=${downloadOptions.playlistItem} kind=${downloadOptions.mediaKind}`
      );
    }

    // Peek duration from metadata when possible so long clips download at full quality.
    let hostedDelivery = false;
    if (r2Ready && downloadOptions.mediaKind !== 'photo') {
      try {
        const earlyMeta = await fetchMetadata(resolvedUrl, config, provider, downloadOptions);
        const earlyDur = Number(earlyMeta && earlyMeta.duration);
        if (Number.isFinite(earlyDur) && earlyDur > config.r2LongVideoSeconds) {
          hostedDelivery = true;
          console.log(
            `[${platform}] duration ${Math.round(earlyDur)}s > ${config.r2LongVideoSeconds}s → R2 high-quality path`
          );
        }
      } catch {
        // Pipeline will fetch metadata again / fallback
      }
    }

    const pipeline = await runYtdlpVideoPipeline({
      resolvedUrl,
      provider,
      config,
      downloadOptions: { ...downloadOptions, hostedDelivery },
      qualityMode,
      platform,
      jobDir,
      jobId,
      onProgress,
      maxDurationSeconds: durationCap,
    });
    const { meta, rawPath, fallbackAnalysis } = pipeline;

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
    const needsR2 = Number.isFinite(probed) && probed > config.r2LongVideoSeconds;
    const useR2 = needsR2 && r2Ready;

    if (probed > config.maxDurationSeconds) {
      const mins = Math.floor(config.maxDurationSeconds / 60);
      throw new Error(
        `El video dura ${Math.round(probed)}s y el máximo permitido es ${config.maxDurationSeconds}s (~${mins} min).`
      );
    }
    if (needsR2 && !r2Ready) {
      throw new Error(
        `Este vídeo dura más de ${Math.floor(config.r2LongVideoSeconds / 60)} min y requiere Cloudflare R2 (R2_ENABLED) en el servidor.`
      );
    }

    const analysis =
      typeof provider.analyzeMeta === 'function' ? provider.analyzeMeta(meta) || {} : {};
    const hadWatermarkOnly = Boolean(
      fallbackAnalysis.hadWatermarkOnly || analysis.hadWatermarkOnly
    );

    // Long videos: skip size-compress; upload Discord-safe MP4 to R2 (FIFO ≤9 GB).
    if (useR2) {
      const hostedPath = path.join(jobDir, `${jobId}-hosted.mp4`);
      await onProgress(72, 'compress');
      console.log(`[${platform}] preparing R2 delivery (${probed.toFixed(1)}s, skip compress if H.264)...`);
      const prepared = await prepareForHostedDelivery(rawPath, hostedPath, (ratio) => {
        onProgress(mapRange(ratio, 72, 88), 'compress');
      });
      if (prepared.skipped) {
        console.log(`[${platform}] already Discord-safe — uploading without re-encode`);
      }
      await onProgress(88, 'upload');
      const key = buildObjectKey(jobId, '.mp4');
      console.log(
        `[${platform}] uploading to R2 key=${key} (${(prepared.sizeBytes / 1024 / 1024).toFixed(1)} MB)...`
      );
      const uploaded = await uploadFile(config, prepared.outputPath, key, {
        contentType: 'video/mp4',
        onProgress: (pct) => onProgress(mapRange(pct, 88, 97), 'upload'),
      });
      await onProgress(97, 'upload');
      if (uploaded.fifo && uploaded.fifo.removed > 0) {
        console.log(`[r2-fifo] evicted ${uploaded.fifo.removed} older object(s) after upload`);
      }

      return {
        filePath: null,
        publicUrl: uploaded.publicUrl,
        r2Key: uploaded.key,
        delivery: 'r2',
        title: meta.title || meta.id || 'video',
        platform,
        providerLabel: provider.label,
        qualityMode,
        mediaType: 'video',
        sizeBytes: uploaded.sizeBytes,
        durationSeconds: prepared.durationSeconds,
        hadWatermarkOnly,
        cleanup,
      };
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

    return {
      filePath: compressed.outputPath,
      publicUrl: null,
      delivery: 'attachment',
      title: meta.title || meta.id || 'video',
      platform,
      providerLabel: provider.label,
      qualityMode,
      mediaType: 'video',
      sizeBytes: compressed.sizeBytes,
      durationSeconds: compressed.durationSeconds,
      hadWatermarkOnly,
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
