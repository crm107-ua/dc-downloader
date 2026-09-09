const { matchesHost } = require('./contract');
const { YOUTUBE_FORMAT } = require('./formats');

const provider = {
  id: 'youtube',
  label: 'YouTube',
  hosts: [
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
    'youtube-nocookie.com',
    'www.youtube-nocookie.com',
  ],
  matches(host) {
    return (
      host === 'youtu.be' ||
      host === 'www.youtu.be' ||
      host.endsWith('youtube.com') ||
      host.endsWith('youtube-nocookie.com')
    );
  },
  formatSelector() {
    return YOUTUBE_FORMAT;
  },
  /**
   * Normalize watch / shorts / youtu.be / share URLs to a clean watch URL.
   */
  normalizeUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const host = u.hostname.toLowerCase();
    let id = null;

    if (host === 'youtu.be' || host === 'www.youtu.be') {
      id = u.pathname.split('/').filter(Boolean)[0] || null;
    } else {
      id = u.searchParams.get('v');
      if (!id) {
        const parts = u.pathname.split('/').filter(Boolean);
        // /shorts/ID, /embed/ID, /live/ID, /v/ID
        const markers = new Set(['shorts', 'embed', 'live', 'v', 'watch']);
        for (let i = 0; i < parts.length; i += 1) {
          if (markers.has(parts[i]) && parts[i + 1] && parts[i] !== 'watch') {
            id = parts[i + 1];
            break;
          }
        }
      }
    }

    if (!id) return rawUrl;
    id = id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20);
    if (!id) return rawUrl;
    return `https://www.youtube.com/watch?v=${id}`;
  },
  extraArgs() {
    return [
      '--extractor-args',
      'youtube:player_client=android,ios,web',
      '--no-write-subs',
      '--no-write-auto-subs',
    ];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
