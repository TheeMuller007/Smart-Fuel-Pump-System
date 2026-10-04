const express = require('express');
const router = express.Router();
const prisma = require('../models');

// GET /api/stations — public list of active stations
router.get('/stations', async (_req, res, next) => {
  try {
    const stations = await prisma.station.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
    });
    res.json(stations);
  } catch (error) {
    next(error);
  }
});

// GET /api/stations/:id/pumps — public pump list with fuel type
router.get('/stations/:id/pumps', async (req, res, next) => {
  try {
    const pumps = await prisma.pump.findMany({
      where: { station_id: req.params.id },
      orderBy: { pump_number: 'asc' },
      include: { fuel_type: { select: { id: true, name: true, price_per_litre: true } } },
    });
    res.json(pumps);
  } catch (error) {
    next(error);
  }
});

// GET /api/fuel-types — public active fuel catalogue with prices
router.get('/fuel-types', async (_req, res, next) => {
  try {
    const fuelTypes = await prisma.fuelType.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, price_per_litre: true, currency: true, status: true },
    });
    res.json(fuelTypes);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
