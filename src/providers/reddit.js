const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

const MEDIA_URL_RE =
  /https:\/\/(?:i|v|preview)\.redd\.it\/[A-Za-z0-9._~%-]+\.(?:gif|jpe?g|png|webp|mp4|gifv)/gi;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const REDDIT_HEADERS = {
  Referer: 'https://www.reddit.com/',
  'User-Agent': BROWSER_UA,
};

/** Public post index. Reddit's own /.json currently returns an anti-bot HTML page. */
const PUBLIC_POST_API = 'https://arctic-shift.photon-reddit.com/api/posts/ids?ids=';

function guessMediaKind(directUrl) {
  if (/\.(gif|jpe?g|png|webp)$/i.test(directUrl)) return 'image';
  return 'video';
}

function pickExt(directUrl, mediaKind) {
  const match = /\.([a-z0-9]+)(?:\?|$)/i.exec(directUrl);
  if (match) return `.${match[1].toLowerCase()}`;
  return mediaKind === 'image' ? '.jpg' : '.mp4';
}

/**
 * yt-dlp can still resolve Reddit posts (incl. /s/ shortlinks) and logs the CDN
 * media URL before failing on i.redd.it 403. Pull that URL from its output.
 */
function extractMediaFromYtDlpOutput(text) {
  const blob = String(text || '');
  const matches = blob.match(MEDIA_URL_RE) || [];
  // Prefer the last i.redd.it / v.redd.it hit (actual media), ignore duplicates
  const unique = [...new Set(matches.map((u) => u.replace(/[),.;]+$/, '')))];
  if (!unique.length) return null;
  // Prefer video CDN when both appear; otherwise last image
  const video = unique.find((u) => /v\.redd\.it|\.mp4(?:\?|$)/i.test(u));
  return video || unique[unique.length - 1];
}

function htmlDecodeUrl(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function postIdFromUrl(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split('/').filter(Boolean);
  const commentsAt = parts.indexOf('comments');
  if (commentsAt >= 0 && /^[a-z0-9]+$/i.test(parts[commentsAt + 1] || '')) {
    return parts[commentsAt + 1];
  }
  if ((host === 'redd.it' || host === 'www.redd.it') && /^[a-z0-9]+$/i.test(parts[0] || '')) {
    return parts[0];
  }
  return null;
}

function vredditIdFromUrls(urls) {
  for (const raw of urls) {
    const match = /https?:\/\/v\.redd\.it\/([A-Za-z0-9]+)/i.exec(htmlDecodeUrl(raw));
    if (match) return match[1];
  }
  return null;
}

function parsePtDuration(mpd) {
  const match = /mediaPresentationDuration="PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?"/i.exec(
    String(mpd || '')
  );
  if (!match) return null;
  const total = Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
  return Number.isFinite(total) && total > 0 ? total : null;
}

function isRedditPageUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it' || host === 'www.redd.it';
  } catch {
    return false;
  }
}

function directHostedFile(rawUrl) {
  const url = htmlDecodeUrl(rawUrl);
  if (!/^https:\/\/(?:i|preview)\.redd\.it\/.+\.(?:gif|jpe?g|png|webp|mp4)(?:\?|$)/i.test(url)) {
    return null;
  }
  return url;
}

function redditVideoOf(post) {
  const sources = [post];
  if (Array.isArray(post && post.crosspost_parent_list)) {
    sources.push(...post.crosspost_parent_list);
  }
  for (const src of sources) {
    const video =
      (src && src.secure_media && src.secure_media.reddit_video) ||
      (src && src.media && src.media.reddit_video) ||
      (src && src.preview && src.preview.reddit_video_preview) ||
      null;
    if (video && (video.dash_url || video.fallback_url || video.hls_url)) return video;
  }
  return null;
}

function galleryAsset(post) {
  const meta = post && post.media_metadata;
  if (!meta || typeof meta !== 'object') return null;
  const ordered = Array.isArray(post.gallery_data && post.gallery_data.items)
    ? post.gallery_data.items.map((item) => item && item.media_id).filter(Boolean)
    : Object.keys(meta);
  for (const id of ordered) {
    const source = meta[id] && meta[id].s;
    if (!source) continue;
    if (source.mp4) return { directUrl: htmlDecodeUrl(source.mp4), mediaKind: 'video' };
    if (source.gif) return { directUrl: htmlDecodeUrl(source.gif), mediaKind: 'image' };
    if (source.u) {
      const directUrl = htmlDecodeUrl(source.u);
      return { directUrl, mediaKind: guessMediaKind(directUrl) };
    }
  }
  return null;
}

async function resolvePostId(pageUrl) {
  const immediate = postIdFromUrl(pageUrl);
  if (immediate) return immediate;

  // Some datacenter IPs get HTTP 403 from Reddit with a normal browser UA
  // on /s/ share links, but Discordbot still receives the 301 → /comments/<id>/.
  const userAgents = [
    'Discordbot/2.0',
    'facebookexternalhit/1.1',
    BROWSER_UA,
  ];

  for (const ua of userAgents) {
    let current = pageUrl;
    for (let hop = 0; hop < 6; hop += 1) {
      let res;
      try {
        res = await fetch(current, {
          redirect: 'manual',
          headers: { 'User-Agent': ua, Accept: 'text/html' },
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        break;
      }
      const location = res.headers.get('location');
      if (location && res.status >= 300 && res.status < 400) {
        current = new URL(location, current).toString();
        const id = postIdFromUrl(current);
        if (id) return id;
        continue;
      }
      const id = postIdFromUrl(res.url || current);
      if (id) return id;
      break;
    }
  }
  return null;
}

async function fetchPublicSubmission(postId) {
  const res = await fetch(`${PUBLIC_POST_API}${encodeURIComponent(postId)}`, {
    headers: { 'User-Agent': 'dc-downloader', Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`índice público de Reddit HTTP ${res.status}`);
  }
  const payload = await res.json();
  const post = payload && Array.isArray(payload.data) ? payload.data[0] : null;
  if (!post || !post.id) return null;
  return post;
}

async function readDashDuration(dashUrl) {
  try {
    const res = await fetch(dashUrl, {
      headers: { ...REDDIT_HEADERS, Accept: '*/*' },
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    return parsePtDuration(await res.text());
  } catch {
    return null;
  }
}

async function describePublicPost(post) {
  const title = (post && post.title) || 'reddit';
  const pageUrls = [post && post.url_overridden_by_dest, post && post.url].filter(Boolean);
  const video = redditVideoOf(post);
  const videoId = vredditIdFromUrls([
    video && video.fallback_url,
    video && video.dash_url,
    video && video.hls_url,
    ...pageUrls,
  ]);

  if (videoId) {
    const directUrl = `https://v.redd.it/${videoId}/DASHPlaylist.mpd`;
    const listed = Number(video && video.duration);
    const durationSeconds =
      Number.isFinite(listed) && listed > 0 ? listed : await readDashDuration(directUrl);
    return {
      directUrl,
      title,
      id: post.id,
      durationSeconds,
      mediaKind: 'video',
      fileExt: '.mp4',
      requestHeaders: { ...REDDIT_HEADERS },
    };
  }

  const hosted = pageUrls.map(directHostedFile).find(Boolean);
  if (hosted) {
    return {
      directUrl: hosted,
      title,
      id: post.id,
      durationSeconds: null,
      mediaKind: guessMediaKind(hosted),
      fileExt: pickExt(hosted, guessMediaKind(hosted)),
      requestHeaders: { ...REDDIT_HEADERS },
    };
  }

  const gallery = galleryAsset(post);
  if (gallery && gallery.directUrl) {
    return {
      directUrl: gallery.directUrl,
      title,
      id: post.id,
      durationSeconds: null,
      mediaKind: gallery.mediaKind,
      fileExt: pickExt(gallery.directUrl, gallery.mediaKind),
      requestHeaders: { ...REDDIT_HEADERS },
    };
  }

  const primary = htmlDecodeUrl(pageUrls[0] || '');
  if (!primary || isRedditPageUrl(primary)) {
    throw new Error('Este post de Reddit no tiene vídeo ni imagen descargable.');
  }
  throw new Error('Este post de Reddit solo enlaza a otra web. Pega el enlace del vídeo.');
}

function extractTitleFromYtDlpOutput(text) {
  const m =
    /\[info\]\s+[^\n]*?:\s+Downloading\s+1\s+format/i.exec(text) ||
    /\[download\]\s+Destination:\s+(.+)/i.exec(text);
  // Reddit JSON title rarely appears in stderr; keep a soft fallback
  const titleMatch = /"title"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(text);
  if (titleMatch) {
    try {
      return JSON.parse(`"${titleMatch[1]}"`);
    } catch {
      return titleMatch[1];
    }
  }
  return null;
}

const provider = {
  id: 'reddit',
  label: 'Reddit',
  hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com', 'redd.it', 'www.redd.it'],
  matches(host) {
    const h = String(host || '').toLowerCase();
    return (
      h === 'reddit.com' ||
      h === 'www.reddit.com' ||
      h === 'old.reddit.com' ||
      h === 'redd.it' ||
      h === 'www.redd.it' ||
      h.endsWith('.reddit.com')
    );
  },
  /**
   * Keep /r/.../comments/... and share shortlinks /r/.../s/...; drop tracking query.
   */
  normalizeUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const host = u.hostname.toLowerCase();
    if (host === 'redd.it' || host === 'www.redd.it') {
      // https://redd.it/abc123 → comments short form yt-dlp understands
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id) return `https://www.reddit.com/comments/${id}/`;
    }

    u.hash = '';
    // Keep path; strip share/utm junk that sometimes confuses extractors
    u.search = '';
    if (host === 'old.reddit.com') {
      u.hostname = 'www.reddit.com';
    } else {
      u.hostname = 'www.reddit.com';
    }
    return u.toString();
  },
  formatSelector() {
    return FAST_FORMAT;
  },
  extraArgs() {
    return [];
  },
  /**
   * Reddit's JSON API currently returns an anti-bot page, so yt-dlp reports
   * "Account authentication is required" and never prints a CDN URL.
   * Resolve /s/ shortlinks to the post id, read the public post index, and
   * point at the v.redd.it DASH playlist (video + audio) or the hosted image.
   * The yt-dlp scrape stays as a backup for i.redd.it 403s when the API still
   * logs the file URL.
   *
   * @param {string} pageUrl
   * @param {{ run?: Function }} [ctx]
   */
  async fetchFallbackMedia(pageUrl, ctx = {}) {
    try {
      const postId = await resolvePostId(pageUrl);
      if (postId) {
        const post = await fetchPublicSubmission(postId);
        if (post) return await describePublicPost(post);
      }
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      if (
        /no tiene vídeo ni imagen|solo enlaza a otra web/i.test(message)
      ) {
        throw err;
      }
      console.warn(`[reddit] índice público no disponible: ${message}`);
    }

    const run = ctx.run;
    if (typeof run !== 'function') {
      throw new Error(
        'Reddit bloqueó la API del post y no se pudo recuperar el media.'
      );
    }

    let combined = '';
    try {
      const { stdout, stderr } = await run(
        'yt-dlp',
        ['--skip-download', '--no-playlist', pageUrl],
        { timeoutMs: 90000 }
      );
      combined = `${stdout}\n${stderr}`;
    } catch (err) {
      combined = [
        err && err.message ? err.message : err,
        err && err.stdout,
        err && err.stderr,
      ]
        .filter(Boolean)
        .join('\n');
    }

    const directUrl = extractMediaFromYtDlpOutput(combined);
    if (!directUrl) {
      throw new Error(
        'Reddit bloqueó la descarga del media (403). No se pudo recuperar la URL directa.'
      );
    }

    const mediaKind = guessMediaKind(directUrl);
    const title = extractTitleFromYtDlpOutput(combined) || 'reddit';
    return {
      directUrl,
      title,
      durationSeconds: null,
      mediaKind,
      fileExt: pickExt(directUrl, mediaKind),
      requestHeaders: { ...REDDIT_HEADERS },
    };
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
