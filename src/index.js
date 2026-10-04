require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const walletRoutes = require('./routes/walletRoutes');
const fuelRoutes = require('./routes/fuelRoutes');
const staffRoutes = require('./routes/staffRoutes');
const adminRoutes = require('./routes/adminRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const { startRequestExpiryJob } = require('./jobs/requestExpiryJob');

const app = express();

app.use(cors());
app.use(express.json());

// API
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/fuel-requests', fuelRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api', catalogRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Prepaid Smart Fuel Dispensing API' });
});

// Web portal (customer + staff UI)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Central error handler — services throw errors carrying an HTTP status.
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ message: err.message || 'Internal server error' });
});

// Background job: auto-expire stale RESERVED fuel requests and release funds.
startRequestExpiryJob();

// Ignore empty/zero PORT env values (some sandboxes export PORT=0).
const portEnv = parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(portEnv) && portEnv > 0 ? portEnv : 4000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Portal: http://localhost:${PORT}`);
});
