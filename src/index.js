require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');
const yaml = require('js-yaml');

const authRoutes = require('./routes/authRoutes');
const customerRoutes = require('./routes/customerRoutes');
const walletRoutes = require('./routes/walletRoutes');
const fuelRoutes = require('./routes/fuelRoutes');
const staffRoutes = require('./routes/staffRoutes');
const adminRoutes = require('./routes/adminRoutes');
const adminExtendRoutes = require('./routes/adminExtendRoutes');
const catalogRoutes = require('./routes/catalogRoutes');
const deviceRoutes = require('./routes/deviceRoutes');
const receiptRoutes = require('./routes/receiptRoutes');
const transactionRoutes = require('./routes/transactionRoutes');
const streamRoutes = require('./routes/streamRoutes');
const { startRequestExpiryJob } = require('./jobs/requestExpiryJob');
const { startStuckDispenseJob } = require('./jobs/stuckDispenseJob');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---- Security headers & CORS (stage 13) ------------------------------------
app.use(
  helmet({
    // The bundled portal uses inline scripts/styles; CSP stays off for it.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

// CORS_ORIGIN: comma-separated allow-list, e.g. "http://localhost:4000,https://demo.example.com".
// Unset → allow all (single-origin demo default).
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()).filter(Boolean)
  : true;
app.use(cors({ origin: corsOrigin }));

app.use(express.json({ limit: '100kb' }));

// ---- Rate limiting (stage 13) ------------------------------------------------
// Device controllers poll every few seconds; the SSE stream is long-lived.
// Both are excluded from the general API budget and get their own.
const deviceLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts from this address; try again later' },
});
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/esp32') || req.path.startsWith('/stream'),
});
app.use('/api/esp32', deviceLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/customers/register', authLimiter);
app.use('/api', globalLimiter);

// Liveness probe must be registered before the routers mounted at /api so the
// transaction router's auth middleware cannot swallow it.
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Prepaid Smart Fuel Dispensing API' });
});

// ---- API ---------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/fuel-requests', fuelRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin', adminExtendRoutes);
app.use('/api', catalogRoutes);
app.use('/api/esp32', deviceRoutes);
app.use('/api', receiptRoutes);
app.use('/api', transactionRoutes);
app.use('/api/stream', streamRoutes);

// ---- Swagger UI at /docs (stage 13/14) ----------------------------------------
let openapiSpec = null;
try {
  openapiSpec = yaml.load(fs.readFileSync(path.join(__dirname, '..', 'api', 'openapi.yaml'), 'utf8'));
} catch (error) {
  console.warn('openapi.yaml could not be loaded for /docs:', error.message);
}
if (openapiSpec) {
  app.get('/docs.json', (_req, res) => res.json(openapiSpec));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, { customSiteTitle: 'Smart Fuel API Docs' }));
}

// ---- Web portal (customer + staff UI) ------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Central error handler — services throw errors carrying an HTTP status ----
app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ message: err.message || 'Internal server error' });
});

// ---- Background jobs ------------------------------------------------------------
// Auto-expire stale RESERVED fuel requests and release funds.
startRequestExpiryJob();
// Recover pumps whose controller died mid-dispense (power loss, network drop).
startStuckDispenseJob();

// A crash must never take the DB down with it (e.g. mid-transaction), and
// operators need the reason in the log — log loudly, exit non-zero.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason);
});

// Ignore empty/zero PORT env values (some sandboxes export PORT=0).
const portEnv = parseInt(process.env.PORT, 10);
const PORT = Number.isFinite(portEnv) && portEnv > 0 ? portEnv : 4000;
const server = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  console.log(`Portal: http://localhost:${PORT}`);
  if (openapiSpec) console.log(`API docs: http://localhost:${PORT}/docs`);
});

// Graceful shutdown: stop accepting new work, let in-flight requests (and any
// in-flight DB transactions — wallet math must never be interrupted) finish.
function shutdown(signal) {
  console.log(`[shutdown] ${signal} received — closing server`);
  const force = setTimeout(() => process.exit(1), 10000);
  if (typeof force.unref === 'function') force.unref();
  server.close(() => {
    console.log('[shutdown] server closed cleanly');
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
