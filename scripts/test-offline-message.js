/**
 * Smoke-test bot availability helpers (no Discord connection).
 * Usage: node scripts/test-offline-message.js
 */
const assert = require('assert');

process.env.BOT_OFFLINE = '';
process.env.MAINTENANCE_MODE = '';

const {
  OFFLINE_MSG,
  isBotUnavailable,
  getOfflineMessage,
  markShuttingDown,
} = require('../src/utils/botAvailability');

assert.strictEqual(getOfflineMessage(), 'Servidor apagado, prueba más tarde.');
assert.strictEqual(OFFLINE_MSG, getOfflineMessage());
assert.strictEqual(isBotUnavailable(), false);

process.env.BOT_OFFLINE = '1';
assert.strictEqual(isBotUnavailable(), true);

process.env.BOT_OFFLINE = '';
assert.strictEqual(isBotUnavailable(), false);

assert.strictEqual(markShuttingDown('test'), true);
assert.strictEqual(isBotUnavailable(), true);
assert.strictEqual(markShuttingDown('test-again'), false);

console.log('OK: offline message + flags behave as expected');
console.log(`message="${getOfflineMessage()}"`);
