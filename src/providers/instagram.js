const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

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
    const markers = new Set(['reel', 'reels', 'p', 'tv', 'share']);
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
    return FAST_FORMAT;
  },
  /**
   * @param {{ playlistItem?: number, mediaKind?: 'video'|'photo' }} [options]
   */
  extraArgs(options = {}) {
    const item = Number(options.playlistItem);
    if (!Number.isFinite(item) || item < 1) {
      return [];
    }
    const args = [
      '--yes-playlist',
      '--playlist-items',
      String(Math.floor(item)),
      '--ignore-no-formats-error',
    ];
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
      ...cookieArgs,
      url,
    ];

    const { stdout } = await run('yt-dlp', args, { timeoutMs: 120000 });
    const data = parseDumpJsonLoose(stdout);
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
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
