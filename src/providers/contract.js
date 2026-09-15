/**
 * Provider contract (open architecture)
 *
 * Each provider module exports an object with:
 *   id             string   unique key (used in logs and filenames)
 *   label          string   human-readable name
 *   hosts          string[] exact hostnames accepted (lowercase)
 *   matches(host)  optional (host) => boolean — if omitted, hosts.includes is used
 *   formatSelector()  string for yt-dlp -f
 *   extraArgs(opts)   string[] extra yt-dlp CLI args; opts may include playlistItem/mediaKind
 *   analyzeMeta(meta) optional — returns { hadWatermarkOnly?: boolean, ... }
 *   normalizeUrl(url) optional — clean tracking params / canonicalize path
 *   listMediaChoices(url, ctx) optional async — detect carousels / multi-item posts
 *                     returns { isCarousel, title?, items: [{ index, id, kind, label }] }
 *
 * Register new providers in ./index.js only. Do not hardcode platforms in the pipeline.
 */

function matchesHost(provider, hostname) {
  const host = String(hostname || '').toLowerCase();
  if (typeof provider.matches === 'function') {
    return provider.matches(host);
  }
  return (provider.hosts || []).includes(host);
}

module.exports = {
  matchesHost,
};
