const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

const provider = {
  id: 'reddit',
  label: 'Reddit',
  hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
  formatSelector() {
    return FAST_FORMAT;
  },
  extraArgs() {
    return [];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
