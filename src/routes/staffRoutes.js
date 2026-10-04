const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const staffService = require('../services/staffService');
const fuelService = require('../services/fuelService');
const auditService = require('../services/auditService');

router.use(authenticateToken, authorizeRole('staff', 'admin'));

// ---- Stage 4: customer search + cash deposit -------------------------------

// GET /api/staff/customers?phone=+1555
router.get('/customers', async (req, res, next) => {
  try {
    const customers = await staffService.searchCustomers(req.query);
    res.json(customers);
  } catch (error) {
    next(error);
  }
});

// POST /api/staff/deposits { user_id, amount, description? }
router.post('/deposits', async (req, res, next) => {
  try {
    const result = await staffService.cashDeposit(req.user, req.body || {}, req.ip);
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// ---- Fuel request handling at the staff member's station -------------------

// GET /api/staff/pending-requests — RESERVED + ACCEPTED requests (stage 7)
// GET /api/staff/fuel-requests is kept as a backwards-compatible alias.
const pendingRequestsHandler = async (req, res, next) => {
  try {
    const requests = await fuelService.getPendingRequests(req.user.station_id);
    res.json(requests);
  } catch (error) {
    next(error);
  }
};
router.get('/pending-requests', pendingRequestsHandler);
router.get('/fuel-requests', pendingRequestsHandler);

// POST /api/staff/requests/:id/accept — keep reservation, status ACCEPTED (stage 7)
router.post('/requests/:id/accept', async (req, res, next) => {
  try {
    const request = await fuelService.acceptRequest(req.params.id, req.user);
    await auditService.log({
      stationUserId: req.user.sub,
      stationId: req.user.station_id,
      action: 'ACCEPT_FUEL_REQUEST',
      entityType: 'fuel_request',
      entityId: req.params.id,
      description: `Accepted request ${request.request_reference}; reservation kept`,
      ipAddress: req.ip,
    });
    res.json(request);
  } catch (error) {
    next(error);
  }
});

// POST /api/staff/requests/:id/reject — release reservation, status REJECTED (stage 7)
router.post('/requests/:id/reject', async (req, res, next) => {
  try {
    const request = await fuelService.rejectRequest(req.params.id, req.user);
    await auditService.log({
      stationUserId: req.user.sub,
      stationId: req.user.station_id,
      action: 'REJECT_FUEL_REQUEST',
      entityType: 'fuel_request',
      entityId: req.params.id,
      description: `Rejected request ${request.request_reference}; reservation released`,
      ipAddress: req.ip,
    });
    res.json(request);
  } catch (error) {
    next(error);
  }
});

// POST /api/staff/fuel-requests/:id/authorize { pump_id? }
router.post('/fuel-requests/:id/authorize', async (req, res, next) => {
  try {
    const result = await fuelService.authorizeRequest(
      req.params.id,
      req.user,
      (req.body || {}).pump_id
    );
    await auditService.log({
      stationUserId: req.user.sub,
      stationId: req.user.station_id,
      action: 'AUTHORIZE_FUEL_REQUEST',
      entityType: 'fuel_request',
      entityId: req.params.id,
      description: `Authorized request; transaction ${result.transaction.transaction_reference}`,
      ipAddress: req.ip,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// POST /api/staff/fuel-requests/:id/cancel
router.post('/fuel-requests/:id/cancel', async (req, res, next) => {
  try {
    const request = await fuelService.cancelRequest(req.params.id, req.user);
    await auditService.log({
      stationUserId: req.user.sub,
      stationId: req.user.station_id,
      action: 'CANCEL_FUEL_REQUEST',
      entityType: 'fuel_request',
      entityId: req.params.id,
      description: `Cancelled request ${request.request_reference}`,
      ipAddress: req.ip,
    });
    res.json(request);
  } catch (error) {
    next(error);
  }
});

// GET /api/staff/fuel-transactions — recent station transactions
router.get('/fuel-transactions', async (req, res, next) => {
  try {
    const transactions = await fuelService.getStationTransactions(req.user.station_id);
    res.json(transactions);
  } catch (error) {
    next(error);
  }
});

// POST /api/staff/fuel-transactions/:id/complete { actual_litres }
router.post('/fuel-transactions/:id/complete', async (req, res, next) => {
  try {
    const txn = await fuelService.completeDispense(
      req.params.id,
      req.body || {},
      req.user
    );
    await auditService.log({
      stationUserId: req.user.sub,
      stationId: req.user.station_id,
      action: 'COMPLETE_FUEL_DISPENSE',
      entityType: 'fuel_transaction',
      entityId: txn.id,
      description: `Completed dispense: ${txn.actual_litres} L, final ${txn.final_amount}, refund ${txn.refund_amount ?? 0}`,
      ipAddress: req.ip,
    });
    res.json(txn);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
