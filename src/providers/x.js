const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

function statusIdFromUrl(url) {
  try {
    const u = new URL(String(url || ''));
    const m = u.pathname.match(/\/status(?:es)?\/(\d+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Full tweet text with real newlines (yt-dlp flattens / truncates title with "...").
 */
async function resolveCaption(url) {
  const id = statusIdFromUrl(url);
  if (!id) return null;

  const endpoints = [
    `https://api.fxtwitter.com/status/${id}`,
    `https://api.vxtwitter.com/Twitter/status/${id}`,
  ];

  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        headers: { 'User-Agent': 'dc-downloader', Accept: 'application/json' },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text =
        data?.tweet?.text ||
        data?.text ||
        data?.tweet?.full_text ||
        data?.full_text ||
        null;
      if (text && String(text).trim()) return String(text);
    } catch {
      // try next
    }
  }
  return null;
}

const provider = {
  id: 'x',
  label: 'X / Twitter',
  hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
  formatSelector() {
    return FAST_FORMAT;
  },
  extraArgs() {
    return [];
  },
  resolveCaption,
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
module.exports.statusIdFromUrl = statusIdFromUrl;
module.exports.resolveCaption = resolveCaption;
