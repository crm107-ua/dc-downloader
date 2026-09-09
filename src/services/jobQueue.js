/**
 * Global FIFO job queue: only one download/compress job runs at a time.
 * Other /video invocations wait and get live position updates.
 */

const waiters = [];
let active = null;
let bumping = false;

function snapshot() {
  return {
    active: Boolean(active),
    waiting: waiters.length,
  };
}

function notifyWaiters() {
  waiters.forEach((entry, index) => {
    if (typeof entry.onQueued !== 'function') return;
    // If nothing is running yet, index 0 starts immediately — position 0 = no queue UI
    const position = active ? index + 1 : index;
    try {
      entry.onQueued({
        position,
        waiting: waiters.length,
        active: Boolean(active),
      });
    } catch {
      // ignore UI errors
    }
  });
}

async function pump() {
  if (bumping) return;
  bumping = true;
  try {
    while (!active && waiters.length > 0) {
      const next = waiters.shift();
      active = next;
      notifyWaiters();
      if (typeof next.onStart === 'function') {
        try {
          next.onStart();
        } catch {
          // ignore
        }
      }
      try {
        const result = await next.task();
        next.resolve(result);
      } catch (err) {
        next.reject(err);
      } finally {
        active = null;
        notifyWaiters();
      }
    }
  } finally {
    bumping = false;
    if (!active && waiters.length > 0) {
      // Another enqueue raced in; continue
      setImmediate(() => {
        pump().catch(() => {});
      });
    }
  }
}

/**
 * @param {() => Promise<any>} task
 * @param {{ onQueued?: (info: { position: number, waiting: number, active: boolean }) => void, onStart?: () => void }} [hooks]
 */
function enqueue(task, hooks = {}) {
  return new Promise((resolve, reject) => {
    waiters.push({
      task,
      resolve,
      reject,
      onQueued: hooks.onQueued,
      onStart: hooks.onStart,
    });
    notifyWaiters();
    pump().catch((err) => {
      console.error('[queue] pump error:', err);
    });
  });
}

module.exports = {
  enqueue,
  snapshot,
};
