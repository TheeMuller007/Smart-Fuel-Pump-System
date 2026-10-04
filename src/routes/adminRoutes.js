const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const adminService = require('../services/adminService');

router.use(authenticateToken, authorizeRole('admin'));

// GET /api/admin/fuel-types — full catalogue including inactive
router.get('/fuel-types', async (req, res, next) => {
  try {
    const fuelTypes = await adminService.listFuelTypes(true);
    res.json(fuelTypes);
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/fuel-types
router.post('/fuel-types', async (req, res, next) => {
  try {
    const fuelType = await adminService.createFuelType(req.body || {});
    res.status(201).json(fuelType);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/fuel-types/:id — live price/name/status edits
router.patch('/fuel-types/:id', async (req, res, next) => {
  try {
    const fuelType = await adminService.updateFuelType(req.params.id, req.body || {});
    res.json(fuelType);
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/fuel-types/:id — deletes, or deactivates when in use
router.delete('/fuel-types/:id', async (req, res, next) => {
  try {
    const result = await adminService.deleteFuelType(req.params.id);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
