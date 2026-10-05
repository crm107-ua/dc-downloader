/**
 * When the host is shutting down (SIGTERM/SIGINT) or BOT_OFFLINE=1,
 * slash commands get a clear Spanish reply instead of hanging / crashing.
 */

const OFFLINE_MSG = 'Servidor apagado, prueba más tarde.';

let shuttingDown = false;

function envOfflineFlag() {
  const raw = String(process.env.BOT_OFFLINE || process.env.MAINTENANCE_MODE || '')
    .trim()
    .toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function isBotUnavailable() {
  return shuttingDown || envOfflineFlag();
}

function getOfflineMessage() {
  return OFFLINE_MSG;
}

function markShuttingDown(reason = 'shutdown') {
  if (shuttingDown) return false;
  shuttingDown = true;
  console.warn(`[availability] ${reason}: new commands → "${OFFLINE_MSG}"`);
  return true;
}

function isShuttingDown() {
  return shuttingDown;
}

module.exports = {
  OFFLINE_MSG,
  isBotUnavailable,
  getOfflineMessage,
  markShuttingDown,
  isShuttingDown,
};
