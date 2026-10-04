const express = require('express');
const router = express.Router();
const authService = require('../services/authService');

// POST /api/customers/register — creates user + wallet, returns tokens
router.post('/register', async (req, res, next) => {
  try {
    const result = await authService.registerCustomer(req.body || {});
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
