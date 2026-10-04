const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const fuelService = require('../services/fuelService');

router.use(authenticateToken, authorizeRole('customer'));

// POST /api/fuel-requests — create request + reserve wallet funds
router.post('/', async (req, res, next) => {
  try {
    const request = await fuelService.createFuelRequest(req.user, req.body || {});
    res.status(201).json(request);
  } catch (error) {
    next(error);
  }
});

// GET /api/fuel-requests — list own requests
router.get('/', async (req, res, next) => {
  try {
    const requests = await fuelService.getUserRequests(req.user.sub);
    res.json(requests);
  } catch (error) {
    next(error);
  }
});

// POST /api/fuel-requests/:id/cancel — cancel + release reserved funds
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const request = await fuelService.cancelRequest(req.params.id, req.user);
    res.json(request);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
