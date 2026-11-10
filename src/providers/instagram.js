const { matchesHost } = require('./contract');

/**
 * Progressive formats 1/2/3 are H.264+AAC muxed MP4s.
 * DASH (dash-*) is often VP9 — Discord clients freeze on stream-copy of VP9 in MP4.
 */
const INSTAGRAM_FORMAT = ['3', '2', '1', 'best[format_id!^=dash][vcodec!=none]', 'best'].join('/');

function hasVideoFormats(entry) {
  const formats = Array.isArray(entry && entry.formats) ? entry.formats : [];
  return formats.some((f) => f && f.vcodec && f.vcodec !== 'none');
}

function hasPhotoFallback(entry) {
  return Array.isArray(entry && entry.thumbnails) && entry.thumbnails.length > 0;
}

function classifyEntry(entry) {
  if (!entry || !entry.id) return null;
  if (hasVideoFormats(entry)) return 'video';
  if (hasPhotoFallback(entry)) return 'photo';
  return null;
}

function parseDumpJsonLoose(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('yt-dlp no devolvió metadatos del carrusel.');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('No se pudo parsear el carrusel de Instagram.');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function unescapeJsString(s) {
  return String(s || '')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\\//g, '/')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"');
}

const MEDIA_PATH_MARKERS = new Set(['reel', 'reels', 'p', 'tv', 'share']);

/** True for /reel/, /p/, /tv/, /share/ (or /user/reel/ID) — not profile/home URLs. */
function isInstagramMediaPost(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  if (!parts.length) return false;
  if (MEDIA_PATH_MARKERS.has(parts[0].toLowerCase()) && parts[1]) return true;
  if (parts.length >= 3 && MEDIA_PATH_MARKERS.has(parts[1].toLowerCase()) && parts[2]) {
    return true;
  }
  return false;
}

function shortcodeFromUrl(urlString) {
  let u;
  try {
    u = new URL(urlString);
  } catch {
    return null;
  }
  const parts = u.pathname.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i += 1) {
    if (MEDIA_PATH_MARKERS.has(parts[i].toLowerCase()) && parts[i + 1]) {
      return parts[i + 1].replace(/[^A-Za-z0-9_-]/g, '') || null;
    }
  }
  return null;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Full reel/post caption (yt-dlp title is often just "Video by user").
 */
async function resolveCaption(pageUrl, meta) {
  const fromMeta = meta && (meta.description || meta.caption);
  if (fromMeta && String(fromMeta).trim().length > 8) {
    // Skip useless "Video by user" style when description is missing elsewhere.
    const t = String(fromMeta).trim();
    if (!/^Video by /i.test(t)) return t;
  }

  const shortcode = shortcodeFromUrl(pageUrl);
  if (!shortcode) return null;

  // 1) yt-dlp description (most reliable on the VPS).
  try {
    const { YT_DLP_BIN } = require('../utils/bins');
    const { spawnSync } = require('child_process');
    const r = spawnSync(
      YT_DLP_BIN,
      [
        '--skip-download',
        '--no-warnings',
        '--extractor-args',
        'instagram:include_dash=0',
        '--print',
        '%(description)s',
        pageUrl,
      ],
      { encoding: 'utf8', timeout: 90000 }
    );
    const desc = String(r.stdout || '').trim();
    if (r.status === 0 && desc && desc !== 'NA' && desc.length > 8 && !/^Video by /i.test(desc)) {
      return desc;
    }
  } catch {
    // fall through
  }

  // 2) Embed captioned page.
  const embedPaths = [
    `https://www.instagram.com/p/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/reel/${shortcode}/embed/captioned/`,
    `https://www.instagram.com/reels/${shortcode}/embed/captioned/`,
  ];

  for (const embedUrl of embedPaths) {
    try {
      const res = await fetch(embedUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      const captionBlock =
        /class="Caption"[^>]*>([\s\S]*?)<div class="CaptionComments"/i.exec(html) ||
        /class="Caption"[^>]*>([\s\S]*?)<\/div>/i.exec(html);
      if (captionBlock && captionBlock[1]) {
        let text = stripHtml(captionBlock[1]);
        text = text.replace(/^@?[A-Za-z0-9._]+\s+/u, '').trim();
        text = text.replace(/\s*View all \d+ comments.*$/i, '').trim();
        if (text.length > 8) return text;
      }
      const og =
        /property="og:description"\s+content="([^"]*)"/i.exec(html) ||
        /content="([^"]*)"\s+property="og:description"/i.exec(html);
      if (og && og[1]) {
        const decoded = stripHtml(og[1].replace(/&quot;/g, '"'));
        if (decoded.length > 8) return decoded;
      }
    } catch {
      // try next embed path
    }
  }
  return null;
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Parse downloadgram.org API HTML/JS blob into ranked CDN proxy URLs (mp4 first).
 */
function extractDownloadgramCandidates(raw) {
  const html = unescapeJsString(raw);
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map((m) => m[1]);
  const scored = [];
  for (const href of hrefs) {
    if (!/cdn\.downloadgram\.org\/\?token=/i.test(href)) continue;
    let force = false;
    let name = '';
    try {
      const token = new URL(href).searchParams.get('token');
      const payload = decodeJwtPayload(token);
      if (payload) {
        force = Boolean(payload.force);
        name = String(payload.filename || '');
      }
    } catch {
      // ignore bad tokens
    }
    scored.push({ url: href, force, name });
  }
  scored.sort(
    (a, b) =>
      Number(b.force) - Number(a.force) ||
      Number(/\.mp4$/i.test(b.name)) - Number(/\.mp4$/i.test(a.name))
  );
  return scored;
}

function pickProgressiveUrl(meta) {
  const formats = Array.isArray(meta && meta.formats) ? meta.formats : [];
  const preferred = ['3', '2', '1'];
  for (const id of preferred) {
    const hit = formats.find((f) => String(f.format_id) === id && f.url);
    if (hit) return hit.url;
  }
  const nonDash = formats.find(
    (f) =>
      f &&
      f.url &&
      f.vcodec &&
      f.vcodec !== 'none' &&
      !String(f.format_id || '').startsWith('dash')
  );
  return nonDash ? nonDash.url : null;
}

/** Rate-limit / login / restricted walls from yt-dlp or public resolvers. */
function isInstagramAccessWallError(err) {
  return /rate-?limit|login page|login_required|Restricted Video|isn't available to everyone|can't be seen by certain audiences|authentication is required|Log into an account|HTTP 429|resoluci[oó]n alternativa de Instagram fall[oó]/i.test(
    String((err && err.message) || err || '')
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Public downloadgram-compatible APIs (same HTML/JWT shape).
 * Multiple hosts so one 429 does not brick Instagram forever.
 */
const INSTAGRAM_RESOLVER_ENDPOINTS = [
  'https://api.downloadgram.org/media',
  'https://api.instasave.website/media',
];

async function resolveViaPublicApis(pageUrl) {
  let lastErr = null;
  for (let round = 0; round < 3; round += 1) {
    for (const endpoint of INSTAGRAM_RESOLVER_ENDPOINTS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: '*/*',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Origin: 'https://downloadgram.org',
            Referer: 'https://downloadgram.org/',
          },
          body: JSON.stringify({ url: pageUrl }),
          signal: AbortSignal.timeout(45000),
        });
        if (res.status === 429) {
          lastErr = new Error(`Resolución alternativa de Instagram falló (HTTP 429).`);
          continue;
        }
        if (!res.ok) {
          lastErr = new Error(`Resolución alternativa de Instagram falló (HTTP ${res.status}).`);
          continue;
        }
        const body = await res.text();
        const candidates = extractDownloadgramCandidates(body);
        const best =
          candidates.find((c) => c.force || /\.mp4$/i.test(c.name)) || candidates[0];
        if (!best || !best.url) {
          lastErr = new Error('No se pudo resolver el vídeo de Instagram sin sesión.');
          continue;
        }
        return {
          directUrl: best.url,
          title: 'instagram',
          durationSeconds: null,
          requestHeaders: {
            Referer: 'https://downloadgram.org/',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          },
        };
      } catch (err) {
        lastErr = err;
      }
    }
    await sleep(800 * (round + 1));
  }
  throw lastErr || new Error('No se pudo resolver el vídeo de Instagram sin sesión.');
}

const provider = {
  id: 'instagram',
  label: 'Instagram',
  hosts: [
    'instagram.com',
    'www.instagram.com',
    'm.instagram.com',
    'instagr.am',
    'www.instagr.am',
  ],
  matches(host) {
    return (
      host === 'instagr.am' ||
      host === 'www.instagr.am' ||
      host === 'instagram.com' ||
      host.endsWith('.instagram.com')
    );
  },
  /**
   * Keep /reel/, /p/, /tv/ (and share) paths; drop tracking query params (utm_*, stkn, …).
   */
  normalizeUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return `https://www.instagram.com${u.pathname}`;

    const kind = parts[0].toLowerCase();
    const markers = MEDIA_PATH_MARKERS;
    if (markers.has(kind) && parts[1]) {
      const id = parts[1].replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return rawUrl;
      const pathKind = kind === 'reels' ? 'reel' : kind;
      return `https://www.instagram.com/${pathKind}/${id}/`;
    }

    // Profile posts sometimes appear as /username/reel/ID or /username/p/ID
    if (parts.length >= 3 && markers.has(parts[1].toLowerCase())) {
      const pathKind = parts[1].toLowerCase() === 'reels' ? 'reel' : parts[1].toLowerCase();
      const id = parts[2].replace(/[^a-zA-Z0-9_-]/g, '');
      if (!id) return rawUrl;
      return `https://www.instagram.com/${pathKind}/${id}/`;
    }

    u.search = '';
    u.hash = '';
    u.hostname = 'www.instagram.com';
    return u.toString();
  },
  formatSelector() {
    return INSTAGRAM_FORMAT;
  },
  /**
   * @param {{ playlistItem?: number, mediaKind?: 'video'|'photo' }} [options]
   */
  extraArgs(options = {}) {
    const args = [
      '--extractor-args',
      'instagram:include_dash=0',
      // Softens anonymous rate-limits vs bare datacenter fingerprint.
      '--impersonate',
      'chrome',
    ];
    const item = Number(options.playlistItem);
    if (!Number.isFinite(item) || item < 1) {
      return args;
    }
    args.push(
      '--yes-playlist',
      '--playlist-items',
      String(Math.floor(item)),
      '--ignore-no-formats-error'
    );
    if (options.mediaKind === 'photo') {
      args.push(
        '--write-thumbnail',
        '--skip-download',
        '--convert-thumbnails',
        'jpg'
      );
    }
    return args;
  },
  /**
   * Detect Instagram sidecar carousels and list selectable slides (1-based).
   * Photos have no video formats; we still expose them via thumbnails.
   *
   * @param {string} url
   * @param {{ run: Function, cookiesArgs?: string[] }} ctx
   * @returns {Promise<null | { isCarousel: boolean, title?: string, items: Array<{ index: number, id: string, kind: 'video'|'photo', label: string }> }>}
   */
  async listMediaChoices(url, ctx) {
    // Profiles / explore URLs are not carousels — avoid yt-dlp instagram:user noise.
    if (!isInstagramMediaPost(url)) {
      return { isCarousel: false, title: null, items: [] };
    }
    const run = ctx && ctx.run;
    if (typeof run !== 'function') {
      throw new Error('listMediaChoices requiere ctx.run');
    }
    const cookieArgs = Array.isArray(ctx.cookiesArgs) ? ctx.cookiesArgs : [];
    const args = [
      '--dump-single-json',
      '--yes-playlist',
      '--ignore-no-formats-error',
      '--no-warnings',
      '--skip-download',
      '--extractor-args',
      'instagram:include_dash=0',
      '--impersonate',
      'chrome',
      ...cookieArgs,
      url,
    ];

    let data;
    try {
      const { stdout } = await run('yt-dlp', args, { timeoutMs: 120000 });
      data = parseDumpJsonLoose(stdout);
    } catch (err) {
      // Rate-limit / Restricted / login: do NOT block /video.
      // Treat as single media so downloadAndPrepare → fetchFallbackMedia can recover.
      console.warn(
        `[instagram] listMediaChoices soft-fail (continue as single): ${err && err.message ? err.message : err}`
      );
      return {
        isCarousel: false,
        title: shortcodeFromUrl(url) || null,
        items: [],
        accessWall: isInstagramAccessWallError(err),
      };
    }

    const entries = Array.isArray(data.entries) ? data.entries : null;

    // Single reel/post: not a carousel
    if (!entries || data._type !== 'playlist') {
      return { isCarousel: false, title: data.title || data.id, items: [] };
    }

    const items = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const kind = classifyEntry(entry);
      if (!kind) continue;
      const index = Number(entry.playlist_index) || i + 1;
      const kindLabel = kind === 'video' ? 'Vídeo' : 'Foto';
      items.push({
        index,
        id: String(entry.id),
        kind,
        label: `${index}. ${kindLabel}`,
      });
    }

    if (items.length <= 1) {
      return {
        isCarousel: false,
        title: data.title || data.id,
        items,
      };
    }

    return {
      isCarousel: true,
      title: data.title || data.playlist_title || data.id || 'Carrusel',
      items,
    };
  },
  resolveCaption,

  /**
   * When yt-dlp cannot access a post (Restricted Video / login wall / age gate / rate-limit),
   * resolve a progressive H.264 URL without server cookies.
   *
   * @param {string} pageUrl
   * @param {{ run?: Function }} [ctx]
   */
  async fetchFallbackMedia(pageUrl, ctx = {}) {
    const run = ctx.run;

    // 1) Prefer progressive CDN URL from yt-dlp metadata (no cookies).
    if (typeof run === 'function') {
      try {
        const { stdout } = await run(
          'yt-dlp',
          [
            '--dump-single-json',
            '--no-warnings',
            '--skip-download',
            '--extractor-args',
            'instagram:include_dash=0',
            '--impersonate',
            'chrome',
            pageUrl,
          ],
          { timeoutMs: 120000 }
        );
        const meta = parseDumpJsonLoose(stdout);
        const directUrl = pickProgressiveUrl(meta);
        if (directUrl) {
          const duration = Number(meta.duration);
          const description = String(meta.description || '').trim() || null;
          return {
            directUrl,
            title: meta.title || meta.id || 'instagram',
            id: meta.id ? String(meta.id) : undefined,
            durationSeconds: Number.isFinite(duration) ? duration : null,
            description,
            caption: description,
            requestHeaders: {
              Referer: 'https://www.instagram.com/',
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            },
          };
        }
      } catch {
        // fall through to public resolvers
      }
    }

    // 2) Public resolvers (Restricted / login_required / anonymous rate-limit).
    return resolveViaPublicApis(pageUrl);
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
module.exports.isInstagramMediaPost = isInstagramMediaPost;
module.exports.isInstagramAccessWallError = isInstagramAccessWallError;
module.exports.resolveCaption = resolveCaption;
module.exports._test = {
  extractDownloadgramCandidates,
  pickProgressiveUrl,
  unescapeJsString,
  isInstagramMediaPost,
  shortcodeFromUrl,
  isInstagramAccessWallError,
  resolveViaPublicApis,
};
