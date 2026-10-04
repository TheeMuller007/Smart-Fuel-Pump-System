const express = require('express');
const router = express.Router();
const { authenticateToken, authorizeRole } = require('../middleware/auth');
const walletService = require('../services/walletService');

router.use(authenticateToken, authorizeRole('customer'));

// GET /api/wallet — available / reserved balances
router.get('/', async (req, res, next) => {
  try {
    const wallet = await walletService.getWalletByUserId(req.user.sub);
    if (!wallet) return res.status(404).json({ message: 'Wallet not found' });
    res.json(wallet);
  } catch (error) {
    next(error);
  }
});

// POST /api/wallet/deposit — cash deposit (ledger CASH_DEPOSIT)
router.post('/deposit', async (req, res, next) => {
  try {
    const result = await walletService.deposit(req.user.sub, (req.body || {}).amount, {
      description: (req.body || {}).description,
    });
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

// GET /api/wallet/transactions?page=1&limit=20 — paginated ledger history
router.get('/transactions', async (req, res, next) => {
  try {
    const result = await walletService.getTransactions(req.user.sub, {
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
