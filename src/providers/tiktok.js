const { matchesHost } = require('./contract');

const provider = {
  id: 'tiktok',
  label: 'TikTok',
  hosts: [
    'tiktok.com',
    'www.tiktok.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'm.tiktok.com',
  ],
  matches(host) {
    return (
      host === 'tiktok.com' ||
      host === 'vm.tiktok.com' ||
      host === 'vt.tiktok.com' ||
      host === 'm.tiktok.com' ||
      host.endsWith('.tiktok.com')
    );
  },
  /**
   * Keep /@user/video/ID (and short links resolved by yt-dlp); drop tracking query params.
   */
  normalizeUrl(rawUrl) {
    let u;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }

    const host = u.hostname.toLowerCase();
    // Short links: leave path, strip junk query — yt-dlp follows the redirect
    if (host === 'vm.tiktok.com' || host === 'vt.tiktok.com') {
      u.search = '';
      u.hash = '';
      return u.toString();
    }

    const parts = u.pathname.split('/').filter(Boolean);
    // /@user/video/ID or /video/ID
    let id = null;
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === 'video' && parts[i + 1]) {
        id = parts[i + 1].replace(/\D/g, '');
        break;
      }
    }
    if (!id) {
      u.search = '';
      u.hash = '';
      return u.toString();
    }

    const user = parts[0] && parts[0].startsWith('@') ? parts[0] : null;
    if (user) {
      return `https://www.tiktok.com/${user}/video/${id}`;
    }
    return `https://www.tiktok.com/video/${id}`;
  },
  formatSelector() {
    // Prefer non-watermarked streams (play_addr legacy + current bytevc1/h264 ids).
    // Explicitly avoid the "download" watermarked fallback TikTok still exposes.
    return [
      'best[format_id^=play_addr][height<=1080]',
      'best[format_id*=play_addr][height<=1080]',
      'best[format_id^=play_addr]',
      'best[format_id*=play_addr]',
      'best[format_id^=h264_][height<=1080]',
      'best[format_id^=bytevc1_][height<=1080]',
      'best[format_note!*=watermarked][height<=1080]',
      'best[format_note!*=watermark][height<=1080]',
      'best[format_id!^=download][height<=1080]',
      'best[format_note!*=watermarked]',
      'best[format_note!*=watermark]',
      'best[format_id!^=download]',
      'best',
    ].join('/');
  },
  extraArgs() {
    // TikTok often needs browser TLS impersonation (curl_cffi on the host).
    return ['--impersonate', 'chrome'];
  },
  analyzeMeta(meta) {
    const formats = Array.isArray(meta && meta.formats) ? meta.formats : [];
    const hadWatermarkOnly =
      formats.length > 0 &&
      formats.every((f) => {
        const note = typeof f.format_note === 'string' ? f.format_note : '';
        const id = typeof f.format_id === 'string' ? f.format_id : '';
        return /watermark/i.test(note) || id === 'download';
      });
    return { hadWatermarkOnly: Boolean(hadWatermarkOnly) };
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
