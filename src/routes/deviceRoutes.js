const express = require('express');
const router = express.Router();
const deviceService = require('../services/deviceService');

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
 * POST /api/esp32/authorizations/:pump_id/ack
 * Controller reports the dispense result; the wallet is charged from the
 * reserve and the remainder released (same settlement as staff completion).
 */
router.post('/authorizations/:pump_id/ack', async (req, res, next) => {
  try {
    const result = await deviceService.ackDispense(req.params.pump_id, req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
