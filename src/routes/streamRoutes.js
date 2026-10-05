const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const bus = require('../events/eventBus');
const deviceService = require('../services/deviceService');

router.use(authenticateToken);

/**
 * Open an SSE response subscribed to the bus with the given filters, send an
 * initial snapshot, then keep the connection alive with heartbeats until the
 * client disconnects.
 */
function openStream(res, req, filters) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = bus.subscribe(res, filters);

  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  // Initial snapshot so the UI renders immediately instead of waiting for
  // the next event.
  const snapshot = async () => {
    if (filters.stationId) {
      send('hello', { scope: 'station', station_id: filters.stationId });
    } else if (filters.userId) {
      send('hello', { scope: 'customer', user_id: filters.userId });
    } else if (filters.pumpId) {
      send('hello', { scope: 'pump', pump_id: filters.pumpId });
      const txn = await latestAuthorizedTransaction(filters.pumpId);
      if (txn) send('pump_transaction', txn);
    }
    for (const pumpId of filters.pumpIds || []) {
      const status = deviceService.getLastStatus(pumpId);
      if (status) send('pump_status', status);
    }
    res.write(': snapshot-done\n\n');
  };
  snapshot().catch(() => {});

  // Heartbeat keeps proxies from closing idle connections.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      cleanup();
    }
  }, 25000);

  function cleanup() {
    clearInterval(heartbeat);
    unsubscribe();
  }
  req.on('close', cleanup);
  req.on('error', cleanup);
}

async function latestAuthorizedTransaction(pumpId) {
  const prisma = require('../models');
  return prisma.fuelTransaction.findFirst({
    where: { pump_id: pumpId, status: 'AUTHORIZED' },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      transaction_reference: true,
      authorized_litres: true,
      authorized_amount: true,
      price_per_litre: true,
      pump_id: true,
      status: true,
      user: { select: { full_name: true } },
      fuel_type: { select: { name: true } },
    },
  });
}

/**
 * GET /api/stream/pumps/:pump_id — live dispensing for one pump.
 * Customers may only watch a pump that is currently dispensing for them;
 * staff/admin may watch any pump at their own station.
 */
router.get('/pumps/:pump_id', async (req, res, next) => {
  try {
    const prisma = require('../models');
    const pump = await prisma.pump.findUnique({ where: { id: req.params.pump_id } });
    if (!pump) return res.status(404).json({ message: 'Pump not found' });

    const u = req.user;
    if (u.type === 'customer') {
      const owns = await prisma.fuelTransaction.findFirst({
        where: { pump_id: pump.id, user_id: u.sub, status: 'AUTHORIZED' },
      });
      if (!owns) return res.status(403).json({ message: 'You have no active dispense on this pump' });
    } else if (u.type === 'staff' && u.station_id !== pump.station_id) {
      return res.status(403).json({ message: 'Pump belongs to another station' });
    }

    openStream(res, req, { pumpId: pump.id, pumpIds: [pump.id] });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/stream/station — staff view: every pump at the caller's station.
 */
router.get('/station', async (req, res, next) => {
  try {
    const u = req.user;
    if (u.type !== 'staff') return res.status(403).json({ message: 'Staff stream only' });

    const prisma = require('../models');
    const pumps = await prisma.pump.findMany({
      where: { station_id: u.station_id },
      select: { id: true },
    });
    openStream(res, req, { stationId: u.station_id, pumpIds: pumps.map((p) => p.id) });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/stream/me — customer stream: receives events targeted at the
 * signed-in user (wallet, requests, dispense completion, receipt ready).
 */
router.get('/me', (req, res, next) => {
  try {
    const u = req.user;
    if (u.type !== 'customer') return res.status(403).json({ message: 'Customer stream only' });
    openStream(res, req, { userId: u.sub });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
