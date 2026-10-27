const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFileSync } = require('child_process');
const { getConfig } = require('../config');
const { resolveProviderByUrl, resolveProviderById } = require('../providers');
const { run, compressToLimit, prepareForHostedDelivery, probeDuration, normalizeQualityMode } = require('./compressor');
const { scheduleTempCleanup } = require('./tempCleanup');
const {
  isR2Configured,
  uploadFile,
  buildObjectKey,
  enforceStorageBudget,
} = require('./r2Storage');
const { mapRange } = require('../utils/progress');

let aria2cAvailable = null;
function hasAria2c() {
  if (aria2cAvailable != null) return aria2cAvailable;
  try {
    execFileSync('aria2c', ['-v'], { stdio: 'ignore', windowsHide: true });
    aria2cAvailable = true;
  } catch {
    aria2cAvailable = false;
  }
  return aria2cAvailable;
}

/** DASH/HLS manifests are not media files; aria2c would save the playlist as the output. */
function isAdaptivePlaylistUrl(url) {
  return /\.(?:mpd|m3u8)(?:[?#]|$)/i.test(String(url || ''));
}

/** YouTube/googlevideo often returns HTTP 403 to aria2c multi-connection downloads. */
function canUseAria2cForUrl(url, providerId = '') {
  if (!hasAria2c()) return false;
  if (providerId === 'youtube') return false;
  const u = String(url || '').toLowerCase();
  if (
    u.includes('googlevideo.com') ||
    u.includes('youtube.com') ||
    u.includes('youtu.be') ||
    u.includes('youtube-nocookie.com')
  ) {
    return false;
  }
  return true;
}

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
  const providerId = provider && provider.id ? provider.id : '';
  // YouTube googlevideo often 403s with multi-connection / aria2c — keep serial
  // even when the logical provider is Spotify (MV resolved to a YouTube URL).
  const serialDownload =
    Boolean(downloadOptions.forceSerialDownload) ||
    providerId === 'youtube' ||
    isYoutubeUrl(url);
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--progress',
    '--no-write-subs',
    '--no-write-auto-subs',
    '-N',
    serialDownload
      ? '1'
      : hostedDelivery || (Number.isFinite(Number(durationSeconds)) && Number(durationSeconds) > 300)
        ? '16'
        : '8',
    ...providerExtraArgs(provider, downloadOptions),
  ];
  if (canUseAria2cForUrl(url, providerId)) {
    args.push('--downloader', 'aria2c', '--downloader-args', 'aria2c:-x16 -s16 -k1M');
  }
  if (downloadOptions.ytdlpExtractorArgs) {
    args.push('--extractor-args', String(downloadOptions.ytdlpExtractorArgs));
  }

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
    requestHeaders && typeof requestHeaders === 'object' ? { ...requestHeaders } : null;
  const playlist = isAdaptivePlaylistUrl(directUrl);
  const googleVideo = isYoutubeUrl(directUrl);

  // googlevideo: Node fetch often 403s; yt-dlp serial (-N 1) works when the URL is valid.
  if (!playlist && googleVideo) {
    const gvArgs = [
      '--no-warnings',
      '--newline',
      '--no-playlist',
      '--progress',
      '-N',
      '1',
      '-4',
      '-o',
      destPath,
      '--no-part',
    ];
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        if (key && value != null) gvArgs.push('--add-header', `${key}:${value}`);
      }
    }
    gvArgs.push(directUrl);
    try {
      const onChunk = (text) => {
        const pct = parseYtDlpPercent(text);
        if (pct != null && typeof onDownloadPercent === 'function') onDownloadPercent(pct);
      };
      await run('yt-dlp', gvArgs, {
        timeoutMs: 45 * 60 * 1000,
        onStdout: onChunk,
        onStderr: onChunk,
      });
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        if (typeof onDownloadPercent === 'function') onDownloadPercent(100);
        return;
      }
    } catch (gvErr) {
      console.warn(`[direct] googlevideo yt-dlp falló: ${gvErr.message || gvErr}`);
    }
    // Last resort: plain fetch
    const res = await fetch(directUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          headers?.['User-Agent'] ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Referer: headers?.Referer || 'https://www.youtube.com/',
        ...(headers || {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Descarga directa falló (HTTP ${res.status}).`);
    }
    if (!res.body) {
      throw new Error('La descarga directa no devolvió cuerpo.');
    }
    const { Readable } = require('stream');
    const { pipeline } = require('stream/promises');
    const total = Number(res.headers.get('content-length') || 0);
    let received = 0;
    let lastPct = -1;
    const nodeIn = Readable.fromWeb(res.body);
    nodeIn.on('data', (chunk) => {
      received += chunk.length;
      if (!total || typeof onDownloadPercent !== 'function') return;
      const pct = Math.min(99, Math.floor((received / total) * 100));
      if (pct !== lastPct) {
        lastPct = pct;
        onDownloadPercent(pct);
      }
    });
    await pipeline(nodeIn, fs.createWriteStream(destPath));
    if (!fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
      throw new Error('La descarga directa no devolvió datos.');
    }
    if (typeof onDownloadPercent === 'function') onDownloadPercent(100);
    return;
  }

  // 1) aria2c multi-connection — fast on publisher CDNs (not YouTube/googlevideo).
  if (!playlist && canUseAria2cForUrl(directUrl)) {
    try {
      const dir = path.dirname(destPath);
      const name = path.basename(destPath);
      const args = [
        '-x',
        '16',
        '-s',
        '16',
        '-k',
        '1M',
        '-j',
        '16',
        '--file-allocation=none',
        '--allow-overwrite=true',
        '--auto-file-renaming=false',
        '--console-log-level=warn',
        '--summary-interval=1',
        '-d',
        dir,
        '-o',
        name,
      ];
      if (headers) {
        for (const [key, value] of Object.entries(headers)) {
          if (key && value != null) args.push('--header', `${key}: ${value}`);
        }
      }
      args.push(directUrl);
      if (typeof onDownloadPercent === 'function') onDownloadPercent(5);
      await run('aria2c', args, { timeoutMs: 45 * 60 * 1000 });
      if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
        if (typeof onDownloadPercent === 'function') onDownloadPercent(100);
        return;
      }
    } catch (ariaErr) {
      console.warn(`[direct] aria2c falló: ${ariaErr.message || ariaErr}`);
    }
  }

  // 2) yt-dlp native (aria2c only for non-YouTube URLs; serial for googlevideo)
  const args = [
    '--no-warnings',
    '--newline',
    '--no-playlist',
    '--progress',
    '-N',
    googleVideo ? '1' : '16',
    '-o',
    destPath,
    '--no-part',
  ];
  if (playlist) {
    // Separate video/audio representations (v.redd.it DASH). Merge to one MP4.
    args.push('-f', 'bv*+ba/b', '--merge-output-format', 'mp4');
  } else if (canUseAria2cForUrl(directUrl)) {
    args.push('--downloader', 'aria2c', '--downloader-args', 'aria2c:-x16 -s16 -k1M');
  }
  if (headers) {
    for (const [key, value] of Object.entries(headers)) {
      if (key && value != null) args.push('--add-header', `${key}:${value}`);
    }
  }
  args.push(directUrl);

  try {
    const onChunk = (text) => {
      const pct = parseYtDlpPercent(text);
      if (pct != null && typeof onDownloadPercent === 'function') onDownloadPercent(pct);
    };
    await run('yt-dlp', args, {
      timeoutMs: 45 * 60 * 1000,
      onStdout: onChunk,
      onStderr: onChunk,
    });
    if (!fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
      throw new Error('yt-dlp no escribió el archivo directo.');
    }
    if (typeof onDownloadPercent === 'function') onDownloadPercent(100);
    return;
  } catch (ytErr) {
    if (playlist) throw ytErr;
    console.warn(`[direct] yt-dlp falló, usando fetch: ${ytErr.message || ytErr}`);
  }

  const res = await fetch(directUrl, {
    redirect: 'follow',
    headers: headers || undefined,
  });
  if (!res.ok) {
    throw new Error(`Descarga directa falló (HTTP ${res.status}).`);
  }
  if (!res.body) {
    throw new Error('La descarga directa no devolvió cuerpo.');
  }

  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  const total = Number(res.headers.get('content-length') || 0);
  let received = 0;
  let lastPct = -1;
  const nodeIn = Readable.fromWeb(res.body);
  nodeIn.on('data', (chunk) => {
    received += chunk.length;
    if (!total || typeof onDownloadPercent !== 'function') return;
    const pct = Math.min(99, Math.floor((received / total) * 100));
    if (pct !== lastPct) {
      lastPct = pct;
      onDownloadPercent(pct);
    }
  });
  await pipeline(nodeIn, fs.createWriteStream(destPath));
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size <= 0) {
    throw new Error('La descarga directa no devolvió datos.');
  }
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

function isYoutubeUrl(url) {
  const u = String(url || '').toLowerCase();
  return (
    u.includes('youtube.com') ||
    u.includes('youtu.be') ||
    u.includes('youtube-nocookie.com') ||
    u.includes('googlevideo.com')
  );
}

/** Age-gate, bot-check, login wall — all trigger cookieless fallback. */
function isYoutubeAuthWallError(err) {
  return /Sign in to confirm you.?re not a bot|Sign in to confirm your age|confirm you.?re not a bot|inappropriate for some users|age-restricted|LOGIN_REQUIRED|Use --cookies|bot check|not a bot\. This helps protect/i.test(
    String((err && err.message) || err || '')
  );
}

function isYoutubeStream403Error(err) {
  return /unable to download video data:\s*HTTP Error 403|HTTP Error 403:\s*Forbidden|Descarga directa falló \(HTTP 403\)/i.test(
    String((err && err.message) || err || '')
  );
}

async function resolveFallbackMedia(provider, resolvedUrl, extra = {}) {
  if (typeof provider.fetchFallbackMedia !== 'function') {
    throw new Error('Provider sin fallback.');
  }
  return provider.fetchFallbackMedia(resolvedUrl, { run, ...extra });
}

/**
 * Try several cookieless candidates until one downloads (datacenter IPs often 403 the first googlevideo URL).
 */
async function downloadViaFallbackCandidates({
  provider,
  resolvedUrl,
  jobDir,
  jobId,
  onProgress,
  durationCap,
  platform,
}) {
  const tried = new Set();
  let lastErr = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let fb;
    try {
      fb = await resolveFallbackMedia(provider, resolvedUrl, { skipUrls: tried });
    } catch (err) {
      lastErr = err;
      break;
    }
    if (!fb || !fb.directUrl) {
      lastErr = new Error('Fallback sin URL directa.');
      break;
    }
    if (tried.has(fb.directUrl)) {
      lastErr = new Error('Fallback repitió la misma URL.');
      break;
    }
    tried.add(fb.directUrl);
    if (fb.durationSeconds != null) {
      assertDuration({ duration: fb.durationSeconds }, durationCap);
    }
    const rawPath = fallbackDestPath(jobDir, jobId, fb);
    try {
      console.log(
        `[${platform}] fallback candidate ${attempt + 1}: ${String(fb.directUrl).slice(0, 64)}…`
      );
      await downloadDirectUrl(
        fb.directUrl,
        rawPath,
        (dlPct) => {
          onProgress(mapRange(dlPct, 8, 72), 'download');
        },
        fb.requestHeaders || null
      );
      return { fb, rawPath };
    } catch (err) {
      lastErr = err;
      console.warn(`[${platform}] fallback candidate failed: ${err.message || err}`);
      try {
        fs.rmSync(rawPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
  throw lastErr || new Error('No hay fuente alternativa pública para este vídeo.');
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
      // Defer actual download to the fallback candidate loop below (set a placeholder).
      usedFallback = { _pendingCandidates: true, title: 'media', id: jobId };
      meta = { title: 'media', id: jobId };
      fallbackAnalysis = {};
    }
  } else {
    console.log(`[${platform}] photo item — skipping video duration check`);
  }

  await onProgress(8, 'metadata');

  const outTemplate = path.join(jobDir, `${jobId}.%(ext)s`);
  let rawPath;

  console.log(`[${platform}] downloading...`);
  await onProgress(8, 'download');

  if (usedFallback && (usedFallback.directUrl || usedFallback._pendingCandidates)) {
    const got = await downloadViaFallbackCandidates({
      provider,
      resolvedUrl,
      jobDir,
      jobId,
      onProgress,
      durationCap,
      platform,
    });
    usedFallback = got.fb;
    rawPath = got.rawPath;
    meta = {
      title: got.fb.title || meta.title,
      id: got.fb.id || meta.id || jobId,
      duration: got.fb.durationSeconds,
    };
    preDuration = got.fb.durationSeconds;
    fallbackAnalysis = { hadWatermarkOnly: Boolean(got.fb.hadWatermarkOnly) };
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
      // YouTube stream 403: retry once (serial + alternate clients). Do NOT fall back to
      // Innertube googlevideo URLs — those also 403 and surface as "Descarga directa 403".
      const youtubeish = platform === 'youtube' || isYoutubeUrl(resolvedUrl);
      if (youtubeish && isYoutubeStream403Error(err)) {
        console.warn(`[${platform}] stream 403, retrying once (serial)...`);
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
            {
              ...downloadOptions,
              forceSerialDownload: true,
            }
          );
          rawPath = findDownloadedFile(jobDir, jobId);
        } catch (retryErr) {
          if (typeof provider.fetchFallbackMedia === 'function') {
            console.warn(`[${platform}] 403 retry failed, trying cookieless fallback...`);
            const got = await downloadViaFallbackCandidates({
              provider,
              resolvedUrl,
              jobDir,
              jobId,
              onProgress,
              durationCap,
              platform,
            });
            usedFallback = got.fb;
            rawPath = got.rawPath;
            meta = {
              title: got.fb.title || meta.title,
              id: got.fb.id || meta.id || jobId,
              duration: got.fb.durationSeconds,
            };
            fallbackAnalysis = { hadWatermarkOnly: Boolean(got.fb.hadWatermarkOnly) };
          } else {
            throw new Error(
              `YouTube bloqueó la descarga del stream (403). Prueba de nuevo en unos minutos.`
            );
          }
        }
      } else if (
        typeof provider.fetchFallbackMedia === 'function' &&
        (!youtubeish || isYoutubeAuthWallError(err) || isYoutubeStream403Error(err))
      ) {
        console.warn(`[${platform}] yt-dlp download failed, trying fallback: ${err.message || err}`);
        const got = await downloadViaFallbackCandidates({
          provider,
          resolvedUrl,
          jobDir,
          jobId,
          onProgress,
          durationCap,
          platform,
        });
        usedFallback = got.fb;
        rawPath = got.rawPath;
        meta = {
          title: got.fb.title || meta.title,
          id: got.fb.id || meta.id || jobId,
          duration: got.fb.durationSeconds,
        };
        fallbackAnalysis = { hadWatermarkOnly: Boolean(got.fb.hadWatermarkOnly) };
      } else {
        throw err;
      }
    }
  }

  await onProgress(72, 'download');

  return { meta, rawPath, fallbackAnalysis, qualityMode, usedFallback, preDuration };
}

/** Discord embed description hard limit — never invent "…" mid-caption. */
const DISCORD_EMBED_DESCRIPTION_MAX = 4096;

function cleanPostCaption(raw) {
  let text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!text) return '';
  // Drop media / tracking URLs that usually trail social captions.
  text = text.replace(/\s*https?:\/\/t\.co\/\S+/gi, '');
  text = text.replace(/\s*https?:\/\/(?:pic\.twitter\.com|x\.com|twitter\.com|instagram\.com|fb\.watch)\S*/gi, '');
  text = text.replace(/\s*https?:\/\/\S+/gi, '');
  // yt-dlp often flattens real newlines into 2+ spaces — restore paragraph breaks.
  if (!text.includes('\n') && /[^\S\n]{2,}/.test(text)) {
    text = text.replace(/[^\S\n]{2,}/g, '\n\n');
  } else {
    text = text.replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ');
  }
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  // Cap only at Discord's hard limit; do not append "..." / "…".
  if (text.length > DISCORD_EMBED_DESCRIPTION_MAX) {
    text = text.slice(0, DISCORD_EMBED_DESCRIPTION_MAX).trimEnd();
  }
  return text;
}

function looksTruncatedCaption(text) {
  const t = String(text || '').trim();
  return /\.\.\.$/.test(t) || /…$/.test(t);
}

function captionFromMeta(meta) {
  if (!meta || typeof meta !== 'object') return '';
  const fromDescription = cleanPostCaption(meta.description);
  if (fromDescription && !looksTruncatedCaption(fromDescription)) return fromDescription;

  // X/Twitter often exposes the tweet as "User - text" in title when description is URL-only.
  // Titles are frequently cut with "..."; skip those when we already have a better description.
  const titled = cleanPostCaption(meta.title || meta.fulltitle);
  if (!titled) return fromDescription;
  if (looksTruncatedCaption(titled) && fromDescription) return fromDescription;
  if (looksTruncatedCaption(titled)) return ''; // prefer provider.resolveCaption over truncated title
  const stripped = titled.replace(/^.{1,48}?\s+[—–-]\s+/, '').trim();
  if (stripped && stripped.length >= 2 && stripped !== titled) return stripped;
  return titled;
}

async function resolvePostCaption(provider, url, meta, includeDescription) {
  if (!includeDescription) return '';
  if (provider && provider.id === 'spotify') return '';

  if (provider && typeof provider.resolveCaption === 'function') {
    try {
      const fromProvider = await provider.resolveCaption(url, meta);
      const cleaned = cleanPostCaption(fromProvider);
      if (cleaned) return cleaned;
    } catch (err) {
      console.warn(`[${provider.id}] resolveCaption: ${err.message || err}`);
    }
  }
  return captionFromMeta(meta);
}

/**
 * @param {string} url
 * @param {{
 *   onProgress?: (percent: number, stage: string) => void | Promise<void>,
 *   qualityMode?: string,
 *   playlistItem?: number,
 *   mediaKind?: 'video'|'photo',
 *   includeDescription?: boolean,
 * }} [options]
 */
async function downloadAndPrepare(url, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : async () => {};
  const config = getConfig();
  let provider = resolveProviderByUrl(url);
  if (!provider) {
    throw new Error('Plataforma no soportada.');
  }
  const platform = provider.id;
  const includeDescription = Boolean(options.includeDescription);
  // Default auto for every provider unless the user picks calidad
  const qualityMode = normalizeQualityMode(options.qualityMode || 'auto');
  let resolvedUrl = normalizeUrl(url, provider);
  let forceAttachment = false;
  let titleOverride = null;
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

    // Optional rewrite (Spotify track → music video CDN / YouTube).
    if (typeof provider.resolveSource === 'function') {
      const source = await provider.resolveSource(resolvedUrl, { run });
      if (!source || !source.sourceUrl) {
        throw new Error('No se pudo resolver el media de origen.');
      }
      resolvedUrl = source.sourceUrl;
      titleOverride = source.title || null;
      forceAttachment = Boolean(source.forceAttachment);
      if (source.downloadMode === 'direct' && source.sourceUrl) {
        // Handled below via synthetic fallback-style download.
        downloadOptions._directSourceUrl = source.sourceUrl;
        downloadOptions._directSourceTitle = source.title || titleOverride;
      }
      if (source.formatProviderId) {
        const formatDonor = resolveProviderById(source.formatProviderId);
        if (formatDonor) {
          provider = {
            ...provider,
            formatSelector: formatDonor.formatSelector.bind(formatDonor),
            extraArgs:
              typeof formatDonor.extraArgs === 'function'
                ? formatDonor.extraArgs.bind(formatDonor)
                : provider.extraArgs,
            fetchFallbackMedia:
              typeof formatDonor.fetchFallbackMedia === 'function'
                ? formatDonor.fetchFallbackMedia.bind(formatDonor)
                : provider.fetchFallbackMedia,
          };
        }
      }
      console.log(`[${platform}] resolved source → ${resolvedUrl}`);
    }

    const r2Ready = isR2Configured(config) && !forceAttachment;
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
    if (r2Ready && downloadOptions.mediaKind !== 'photo' && !downloadOptions._directSourceUrl) {
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
        // Age-gate / login: pipeline fallback still probes duration after download for R2.
      }
    }

    let pipeline;
    if (downloadOptions._directSourceUrl) {
      // Spotify (or similar) already gave a direct CDN URL.
      const directUrl = downloadOptions._directSourceUrl;
      const rawPath = path.join(jobDir, `${jobId}.mp4`);
      console.log(`[${platform}] downloading direct source...`);
      await onProgress(8, 'download');
      await downloadDirectUrl(directUrl, rawPath, (dlPct) => {
        onProgress(mapRange(dlPct, 8, 72), 'download');
      });
      await onProgress(72, 'download');
      pipeline = {
        meta: {
          title: downloadOptions._directSourceTitle || titleOverride || 'video',
          id: jobId,
        },
        rawPath,
        fallbackAnalysis: {},
      };
    } else {
      pipeline = await runYtdlpVideoPipeline({
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
    }
    const { meta, rawPath, fallbackAnalysis } = pipeline;
    if (titleOverride) meta.title = titleOverride;

    // Spotify resolves to YouTube; don't paste the YT description as "post text".
    const caption = await resolvePostCaption(provider, url, meta, includeDescription);

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
        caption,
        cleanup,
      };
    }

    const probed = await probeDuration(rawPath);
    const needsR2 =
      !forceAttachment && Number.isFinite(probed) && probed > config.r2LongVideoSeconds;
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
      console.log(`[${platform}] preparing R2 delivery (${probed.toFixed(1)}s, max quality)...`);
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
        caption,
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
      caption,
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
