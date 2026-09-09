const { matchesHost } = require('./contract');
const { FAST_FORMAT } = require('./formats');

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
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
