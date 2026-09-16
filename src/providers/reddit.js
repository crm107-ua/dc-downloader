const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

const MEDIA_URL_RE =
  /https:\/\/(?:i|v|preview)\.redd\.it\/[A-Za-z0-9._~%-]+\.(?:gif|jpe?g|png|webp|mp4|gifv)/gi;

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
   * When yt-dlp resolves a Reddit post but CDN blocks the media (common for
   * i.redd.it GIFs/images → HTTP 403), recover the CDN URL and download it
   * directly with a normal browser Referer (no account cookies).
   *
   * @param {string} pageUrl
   * @param {{ run?: Function }} [ctx]
   */
  async fetchFallbackMedia(pageUrl, ctx = {}) {
    const run = ctx.run;
    if (typeof run !== 'function') {
      throw new Error('Reddit fallback requiere ctx.run');
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
      requestHeaders: {
        Referer: 'https://www.reddit.com/',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    };
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
