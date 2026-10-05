const express = require('express');
const router = express.Router();
const receiptService = require('../services/receiptService');

/**
 * GET /api/transactions/:id/receipt?token=...
 * Token is the HMAC from the receipt URL; when a bearer token is also
 * supplied the identity check applies on top (owner or station staff).
 * The token alone is sufficient: receipt links are unguessable and are only
 * ever handed to the buyer or the completing station.
 */
router.get('/transactions/:id/receipt', async (req, res, next) => {
  try {
    await receiptService.serveReceipt(req.params.id, req.query.token, req.user || null, res);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
