const { matchesHost } = require('./contract');

const provider = {
  id: 'reddit',
  label: 'Reddit',
  hosts: ['reddit.com', 'www.reddit.com', 'old.reddit.com'],
  formatSelector() {
    return 'bv*+ba/b';
  },
  extraArgs() {
    return [];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
