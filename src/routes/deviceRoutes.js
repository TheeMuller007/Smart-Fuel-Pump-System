const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');
const auditService = require('../services/auditService');

// Device authentication: x-api-key header checked in constant time.
router.use((req, res, next) => {
  try {
    deviceService.assertDeviceAccess(req);
    next();
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/esp32/authorizations/:pump_id
 * Pump controller polls this to fetch the signed AUTHORIZED transaction for
 * its pump. Responds with authorization: null when nothing is pending.
 */
router.get('/authorizations/:pump_id', async (req, res, next) => {
  try {
    const result = await deviceService.getAuthorizationForPump(req.params.pump_id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/esp32/status/:pump_id
 * Periodic telemetry from the controller: current litres dispensed, relay
 * state, optional error string. Broadcast to station dashboards (stage 10).
 */
router.post('/status/:pump_id', async (req, res, next) => {
  try {
    const result = await deviceService.updateStatus(req.params.pump_id, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/esp32/completed/:pump_id
 * Alternative completion path used by firmware that tracks its own flow
 * totals: identical semantics to /ack but named for the dispense lifecycle.
 */
router.post('/completed/:pump_id', async (req, res, next) => {
  try {
    const result = await deviceService.ackDispense(req.params.pump_id, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/esp32/authorizations/:pump_id/ack
 * Controller reports the dispense result; the wallet is charged from the
 * reserve and the remainder released (same settlement as staff completion).
 */
router.post('/authorizations/:pump_id/ack', async (req, res, next) => {
  try {
    const result = await deviceService.ackDispense(req.params.pump_id, req.body || {});
    // Audit device completions: for reconciliation the pump controller is the
    // 'user' and its identity is the authenticated API key, not a staff login.
    if (result && result.status === 'completed') {
      await auditService.log({
        userId: null,
        stationId: req.device_station_id || null,
        action: 'DEVICE_COMPLETE_FUEL_DISPENSE',
        entityType: 'fuel_transaction',
        entityId: req.body && req.body.transaction_id ? String(req.body.transaction_id) : null,
        description: `Pump controller reported completion: ${result.transaction_reference}, ${result.actual_litres} L, final ${result.final_amount}`,
        ipAddress: req.ip,
      }).catch(() => { /* audit must never break settlement */ });
    }
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
