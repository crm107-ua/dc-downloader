const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

const provider = {
  id: 'youtube',
  label: 'YouTube',
  hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
  formatSelector() {
    return FAST_FORMAT;
  },
  extraArgs() {
    return ['--extractor-args', 'youtube:player_client=android,ios,web'];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
