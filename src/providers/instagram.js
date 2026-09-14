const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

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
   * Instagram sidecars (/p/ carousels) are playlists of mixed photo+video items.
   * --no-playlist is ignored by the extractor for those posts, so without filters
   * yt-dlp walks every slide and dies on "No video formats found" for photos.
   * Keep only video slides and stop after the first one.
   */
  extraArgs() {
    return [
      '--yes-playlist',
      '--match-filters',
      'vcodec!=none',
      '--max-downloads',
      '1',
      '--ignore-no-formats-error',
    ];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
