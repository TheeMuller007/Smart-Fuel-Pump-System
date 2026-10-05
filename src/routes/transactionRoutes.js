const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../middleware/auth');
const prisma = require('../models');
const receiptService = require('../services/receiptService');

router.use(authenticateToken);

/**
 * GET /api/transactions/:id — full transaction detail for the buyer or the
 * completing station's staff, including the receipt download URL when ready.
 */
router.get('/transactions/:id', async (req, res, next) => {
  try {
    const txn = await prisma.fuelTransaction.findUnique({
      where: { id: req.params.id },
      include: {
        user: { select: { full_name: true, email: true } },
        station: { select: { name: true, location: true } },
        pump: { select: { pump_number: true } },
        fuel_type: { select: { name: true, currency: true } },
        request: { select: { request_reference: true, requested_litres: true } },
      },
    });
    if (!txn) return res.status(404).json({ message: 'Transaction not found' });

    const u = req.user;
    if (u.type === 'customer' && txn.user_id !== u.sub) {
      return res.status(403).json({ message: 'Not your transaction' });
    }
    if (u.type === 'staff' && txn.station_id !== u.station_id) {
      return res.status(403).json({ message: 'Transaction belongs to another station' });
    }

    let receipt_url = txn.receipt_url || null;
    if (txn.status === 'COMPLETED') {
      try {
        receipt_url = await receiptService.getReceiptUrl(txn.id, u);
      } catch {
        /* receipt not generated yet */
      }
    }

    res.json({ ...txn, receipt_url });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
