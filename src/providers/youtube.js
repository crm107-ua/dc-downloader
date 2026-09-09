const { matchesHost } = require('./contract');

const provider = {
  id: 'youtube',
  label: 'YouTube',
  hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  formatSelector() {
    return 'bv*+ba/b';
  },
  extraArgs() {
    // Avoid HTTP 403 from web client on some regions/versions
    return ['--extractor-args', 'youtube:player_client=android,ios,web'];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
