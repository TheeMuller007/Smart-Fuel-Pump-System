const prisma = require('../models');
const fuelService = require('../services/fuelService');

/**
 * Stage 6: background job that auto-expires pending (RESERVED) fuel requests
 * past their TTL and releases the reserved funds. Runs alongside the lazy
 * expiry performed when staff list pending requests / authorize; the status
 * guard inside expireStaleRequests makes the two paths safe together.
 */
function startRequestExpiryJob(intervalMs = 60 * 1000) {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const count = await prisma.$transaction((tx) => fuelService.expireStaleRequests(tx, null));
      if (count > 0) {
        console.log(`[expiry-job] expired ${count} stale fuel request(s)`);
      }
    } catch (error) {
      console.error('[expiry-job] run failed:', error.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[expiry-job] started (every ${Math.round(intervalMs / 1000)}s)`);
  return timer;
}

module.exports = { startRequestExpiryJob };
