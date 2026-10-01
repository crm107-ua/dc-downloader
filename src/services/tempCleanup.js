const fs = require('fs');
const path = require('path');
const { getConfig } = require('../config');
const { isR2Configured, sweepExpiredObjects } = require('./r2Storage');

/** @type {Promise<void> | null} */
let inFlight = null;
let lastRunAt = 0;

// Avoid hammering disk when many users download at once
const MIN_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Opportunistic cleanup of TEMP_DIR (+ R2 objects) older than TEMP_MAX_AGE_HOURS.
 * Safe with concurrent downloads: only deletes aged paths; active job folders are new.
 * Throttled + single-flight so parallel /video calls share one sweep.
 */
function scheduleTempCleanup() {
  const now = Date.now();
  if (inFlight) return inFlight;
  if (now - lastRunAt < MIN_INTERVAL_MS) return Promise.resolve();

  inFlight = (async () => {
    lastRunAt = Date.now();
    try {
      await sweepExpiredTemp();
      const config = getConfig();
      if (isR2Configured(config)) {
        const r2 = await sweepExpiredObjects(config);
        if (r2.removed > 0) {
          console.log(`[r2-cleanup] removed ${r2.removed} expired object(s)`);
        }
      }
    } catch (err) {
      console.warn('[temp-cleanup] sweep failed:', err.message || err);
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

async function sweepExpiredTemp() {
  const config = getConfig();
  const tempRoot = path.resolve(config.tempDir);
  const maxAgeMs = config.tempMaxAgeHours * 60 * 60 * 1000;
  const cutoff = Date.now() - maxAgeMs;

  let entries;
  try {
    entries = await fs.promises.readdir(tempRoot, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }

  let removed = 0;
  await Promise.all(
    entries.map(async (entry) => {
      const fullPath = path.join(tempRoot, entry.name);
      try {
        const stat = await fs.promises.stat(fullPath);
        if (stat.mtimeMs > cutoff) return;

        await fs.promises.rm(fullPath, { recursive: true, force: true });
        removed += 1;
      } catch (err) {
        // Busy/locked/already gone — ignore (common on Windows with concurrent IO)
        if (err && (err.code === 'ENOENT' || err.code === 'EBUSY' || err.code === 'EPERM')) {
          return;
        }
        console.warn(`[temp-cleanup] skip ${entry.name}:`, err.message || err);
      }
    })
  );

  if (removed > 0) {
    console.log(
      `[temp-cleanup] removed ${removed} entr${removed === 1 ? 'y' : 'ies'} older than ${config.tempMaxAgeHours}h from ${tempRoot}`
    );
  }
}

module.exports = {
  scheduleTempCleanup,
  sweepExpiredTemp,
};
