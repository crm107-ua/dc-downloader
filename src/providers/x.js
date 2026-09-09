const { matchesHost } = require('./contract');

/** @type {import('./contract')} */
const provider = {
  id: 'x',
  label: 'X / Twitter',
  hosts: ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'],
  formatSelector() {
    return 'bv*+ba/b';
  },
  extraArgs() {
    return [];
  },
};

module.exports = provider;
module.exports.matchesHost = (host) => matchesHost(provider, host);
