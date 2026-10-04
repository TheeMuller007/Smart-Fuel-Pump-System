const express = require('express');
const router = express.Router();
const authService = require('../services/authService');

router.post('/login', async (req, res, next) => {
  try {
    const result = await authService.login(req.body || {});
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const result = await authService.refresh((req.body || {}).refreshToken);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const result = await authService.logout((req.body || {}).refreshToken);
    res.json(result);
  } catch (error) {
    next(error);
  }
});

module.exports = router;
