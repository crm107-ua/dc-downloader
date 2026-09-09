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
  formatSelector() {
    // Prefer play_addr / direct streams; skip notes labeled watermarked
    return [
      'best[format_id^=play_addr]',
      'best[format_id*=play_addr]',
      'best[format_note!*=watermarked]',
      'best[format_note!*=watermark]',
      'best',
    ].join('/');
  },
  extraArgs() {
    return [];
  },
  analyzeMeta(meta) {
    const formats = Array.isArray(meta && meta.formats) ? meta.formats : [];
    const hadWatermarkOnly =
      formats.length > 0 &&
      formats.every(
        (f) =>
          typeof f.format_note === 'string' &&
          /watermark/i.test(f.format_note)
      );
    return { hadWatermarkOnly: Boolean(hadWatermarkOnly) };
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
