const prisma = require('../models');

/**
 * Fail-safe for pumps stuck mid-loop (power loss on the ESP32, network drop,
 * server restart between authorize and completion). A pump whose ACTIVE
 * transaction is AUTHORIZED with no heartbeat for STUCK_DISPENSE_TIMEOUT_MIN
 * is put back in play:
 *   - pump          -> AVAILABLE
 *   - request       -> back to RESERVED (pump assignment cleared) so staff can
 *                      reassign it to a working pump; funds stay reserved
 *   - transaction   -> CANCELLED (never settled, never charged)
 * The customer is never charged for fuel that was never confirmed dispensed.
 * Devices that are merely slow are protected by the heartbeat grace: if the
 * controller still posts telemetry, the transaction looks recently active and
 * is left alone.
 */
function startStuckDispenseJob(intervalMs = 60 * 1000) {
  let running = false;

  async function reap() {
    const timeoutMin = Number(process.env.STUCK_DISPENSE_TIMEOUT_MIN || 10);
    const cutoff = new Date(Date.now() - timeoutMin * 60 * 1000);

    const stuck = await prisma.fuelTransaction.findMany({
      where: { status: 'AUTHORIZED', started_at: { lt: cutoff } },
      include: { pump: true },
      take: 20,
    });

    for (const txn of stuck) {
      const lastBeat = txn.pump.last_status_at ? new Date(txn.pump.last_status_at) : null;
      const stillAlive = lastBeat && lastBeat > cutoff && txn.pump.dispense_state === 'DISPENSING';
      if (stillAlive) continue; // device is alive and dispensing — leave it be

      try {
        await prisma.$transaction(async (tx) => {
          const claimed = await tx.$queryRaw`SELECT id FROM "FuelTransaction" WHERE id = ${txn.id} AND status = 'AUTHORIZED' FOR UPDATE`;
          if (!claimed || claimed.length === 0) return; // completed elsewhere meanwhile

          await tx.pump.update({
            where: { id: txn.pump_id },
            data: { status: 'AVAILABLE', dispense_state: null, last_reported_litres: null },
          });
          await tx.fuelRequest.update({
            where: { id: txn.request_id },
            data: { status: 'RESERVED', pump_id: null },
          });
          await tx.fuelTransaction.update({
            where: { id: txn.id },
            data: { status: 'CANCELLED' },
          });
        });
        console.log(`[stuck-job] recovered pump ${txn.pump_id}: ${txn.transaction_reference} -> CANCELLED, request back to RESERVED`);
      } catch (error) {
        console.error(`[stuck-job] failed to recover ${txn.transaction_reference}:`, error.message);
      }
    }
  }

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reap();
    } catch (error) {
      console.error('[stuck-job] run failed:', error.message);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  console.log(`[stuck-job] started (every ${Math.round(intervalMs / 1000)}s, timeout ${process.env.STUCK_DISPENSE_TIMEOUT_MIN || 10}min)`);
  return timer;
}

module.exports = { startStuckDispenseJob };
