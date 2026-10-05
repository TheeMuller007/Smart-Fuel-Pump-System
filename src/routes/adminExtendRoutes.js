const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const adminService = require('../services/adminService');

router.use(authenticateToken, authorizeRole('admin'));

// ---- Dashboard --------------------------------------------------------------
// GET /api/admin/dashboard
router.get('/dashboard', async (_req, res, next) => {
  try {
    res.json(await adminService.getDashboard());
  } catch (error) {
    next(error);
  }
});

// ---- Customers --------------------------------------------------------------
// GET /api/admin/users?page=&limit=&q=&status=
router.get('/users', async (req, res, next) => {
  try {
    res.json(await adminService.listUsers(req.query));
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/users/:id/status { status: 'ACTIVE' | 'BLOCKED' }
router.patch('/users/:id/status', async (req, res, next) => {
  try {
    const result = await adminService.setUserStatus(req.params.id, (req.body || {}).status);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ---- Stations ---------------------------------------------------------------
// GET /api/admin/stations
router.get('/stations', async (_req, res, next) => {
  try {
    res.json(await adminService.listStations());
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/stations { name, location }
router.post('/stations', async (req, res, next) => {
  try {
    const station = await adminService.createStation(req.body || {});
    res.status(201).json(station);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/stations/:id
router.patch('/stations/:id', async (req, res, next) => {
  try {
    res.json(await adminService.updateStation(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

// ---- Pumps ------------------------------------------------------------------
// GET /api/admin/pumps?station_id=
router.get('/pumps', async (req, res, next) => {
  try {
    res.json(await adminService.listPumps(req.query.station_id));
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/pumps { station_id, pump_number, fuel_type_id, controller_id? }
router.post('/pumps', async (req, res, next) => {
  try {
    const pump = await adminService.createPump(req.body || {});
    res.status(201).json(pump);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/pumps/:id { fuel_type_id?, controller_id?, status? }
router.patch('/pumps/:id', async (req, res, next) => {
  try {
    res.json(await adminService.updatePump(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

// DELETE /api/admin/pumps/:id — delete, or set OFFLINE when history exists
router.delete('/pumps/:id', async (req, res, next) => {
  try {
    res.json(await adminService.deletePump(req.params.id));
  } catch (error) {
    next(error);
  }
});

// ---- Staff accounts -----------------------------------------------------------
// GET /api/admin/staff?station_id=
router.get('/staff', async (req, res, next) => {
  try {
    res.json(await adminService.listStationUsers(req.query.station_id));
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/staff { station_id, username, password, full_name, role }
router.post('/staff', async (req, res, next) => {
  try {
    const su = await adminService.createStationUser(req.body || {});
    res.status(201).json(su);
  } catch (error) {
    next(error);
  }
});

// PATCH /api/admin/staff/:id { full_name?, role?, status?, password? }
router.patch('/staff/:id', async (req, res, next) => {
  try {
    res.json(await adminService.updateStationUser(req.params.id, req.body || {}));
  } catch (error) {
    next(error);
  }
});

// ---- Audit log ----------------------------------------------------------------
// GET /api/admin/audit-logs?page=&action=&entity_type=&user_id=&station_id=&from=&to=
router.get('/audit-logs', async (req, res, next) => {
  try {
    res.json(await adminService.listAuditLogs(req.query));
  } catch (error) {
    next(error);
  }
});

// ---- Recent requests feed (admin dashboard) ------------------------------------
// GET /api/admin/fuel-requests?limit=10 — latest requests across all stations
router.get('/fuel-requests', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const requests = await adminService.recentFuelRequests(limit);
    res.json(requests);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
