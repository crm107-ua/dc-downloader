const { matchesHost } = require('./contract');

/**
 * Prefer progressive HD/SD (H.264) over DASH AV1 — Discord cannot play
 * stream-copied AV1/VP9 in many clients (frozen first frame + audio).
 */
const FACEBOOK_FORMAT = ['hd', 'sd', 'best[format_id!*=dash][vcodec!=none]', 'best'].join('/');

const provider = {
  id: 'facebook',
  label: 'Facebook',
  hosts: [
    'facebook.com',
    'www.facebook.com',
    'm.facebook.com',
    'fb.watch',
    'www.fb.watch',
    'web.facebook.com',
  ],
  matches(host) {
    return (
      host === 'fb.watch' ||
      host === 'www.fb.watch' ||
      host === 'facebook.com' ||
      host === 'm.facebook.com' ||
      host === 'web.facebook.com' ||
      host.endsWith('.facebook.com')
    );
  },
  /**
   * Keep /reel/ID, /watch/?v=, /videos/ID and fb.watch short links; drop tracking.
   */
  normalizeUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const host = u.hostname.toLowerCase();
    if (host === 'fb.watch' || host === 'www.fb.watch') {
      u.search = '';
      u.hash = '';
      u.hostname = 'fb.watch';
      return u.toString();
    }

    const parts = u.pathname.split('/').filter(Boolean);
    // /reel/ID or /reels/ID
    if (parts.length >= 2 && (parts[0] === 'reel' || parts[0] === 'reels')) {
      const id = parts[1].replace(/\D/g, '');
      if (id) return `https://www.facebook.com/reel/${id}`;
    }
    // /watch/?v=ID
    const watchId = u.searchParams.get('v');
    if (parts[0] === 'watch' && watchId) {
      return `https://www.facebook.com/watch/?v=${watchId.replace(/\D/g, '')}`;
    }
    // /{page}/videos/ID or /videos/ID
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === 'videos' && parts[i + 1]) {
        const id = parts[i + 1].replace(/\D/g, '');
        if (id) {
          const page = i > 0 ? parts[0] : null;
          if (page && page !== 'videos') {
            return `https://www.facebook.com/${page}/videos/${id}/`;
          }
          return `https://www.facebook.com/videos/${id}/`;
        }
      }
    }

    u.search = '';
    u.hash = '';
    u.hostname = 'www.facebook.com';
    return u.toString();
  },
  formatSelector() {
    return FACEBOOK_FORMAT;
  },
  extraArgs() {
    return [];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
