const { matchesHost } = require('./contract');
const x = require('./x');
const reddit = require('./reddit');
const youtube = require('./youtube');
const tiktok = require('./tiktok');
const instagram = require('./instagram');
const facebook = require('./facebook');
const spotify = require('./spotify');

/**
 * Ordered registry of video providers.
 * To add a new site: create src/providers/<id>.js and append it here.
 * No other pipeline files need platform-specific branches.
 */
const PROVIDERS = [x, reddit, youtube, tiktok, instagram, facebook, spotify];

function listProviders() {
  return [...PROVIDERS];
}

function allHosts() {
  const hosts = new Set();
  for (const provider of PROVIDERS) {
    for (const host of provider.hosts || []) {
      hosts.add(String(host).toLowerCase());
    }
  }
  return [...hosts];
}

function resolveProviderByHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return PROVIDERS.find((provider) => matchesHost(provider, host)) || null;
}

function resolveProviderByUrl(urlString) {
  let hostname;
  try {
    hostname = new URL(urlString).hostname;
  } catch {
    return null;
  }
  return resolveProviderByHost(hostname);
}

function resolveProviderById(id) {
  return PROVIDERS.find((provider) => provider.id === id) || null;
}

function supportedLabels() {
  return PROVIDERS.map((provider) => provider.label).join(' · ');
}

function supportedLabelsForError() {
  return PROVIDERS.map((provider) => provider.label).join(', ');
}

module.exports = {
  PROVIDERS,
  listProviders,
  allHosts,
  resolveProviderByHost,
  resolveProviderByUrl,
  resolveProviderById,
  supportedLabels,
  supportedLabelsForError,
};
