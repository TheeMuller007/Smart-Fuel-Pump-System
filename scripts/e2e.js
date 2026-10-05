#!/usr/bin/env node
/**
 * End-to-end integration test (stage 13).
 *
 * Boots the real Express server against a TEST database, seeds it, then
 * drives the complete prepaid loop through the public API exactly like the
 * portals and the ESP32 do:
 *
 *   customer login -> create fuel request (reserve)
 *   staff login -> assign pump -> authorize
 *   python pump mock dispenses (poll -> verify signature -> telemetry -> ack)
 *   wallet settles (FUEL_PAYMENT + release) -> receipt PDF generated
 *
 * Everything is asserted over HTTP; nothing is imported from src/, so this
 * tests the deployed behavior, not the internals.
 *
 * Usage:
 *   node scripts/e2e.js [--db-url postgresql://...] [--port 4100] [--skip-migrate]
 *
 * Prerequisites:
 *   - A reachable PostgreSQL test database (default smart_fuel_test on :5433
 *     to match docker-compose; pass --db-url to override)
 *     compose credentials). Create it once, e.g.:
 *       docker compose up -d db
 *       docker exec smart-fuel-db psql -U postgres -c 'CREATE DATABASE smart_fuel_test;'
 *   - Python 3 for the pump mock (stdlib only — no pip installs needed)
 */

const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- CLI ---------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(name);

const PORT = Number(argValue('--port', '4100'));
const BASE = `http://localhost:${PORT}`;
require('dotenv').config();

/**
 * Test DB URL resolution order:
 *   1. --db-url flag
 *   2. E2E_DATABASE_URL env var
 *   3. Derived from DATABASE_URL in .env (same server, database smart_fuel_test)
 *   4. Last-resort default
 */
function resolveDbUrl() {
  const explicit = argValue('--db-url', process.env.E2E_DATABASE_URL);
  if (explicit) return explicit;
  const base = (process.env.DATABASE_URL || 'postgresql://postgres:password@127.0.0.1:5433/smart_fuel_db')
    .replace('@localhost:', '@127.0.0.1:'); // Prisma's IPv6-first resolution fails on some Windows hosts
  return base.replace(/\/[?]?[^/?]*(\?|$)/, '/smart_fuel_test$1');
}
const DB_URL = resolveDbUrl();
const ESP32_API_KEY = 'itest-device-api-key-0123456789abcdef';
const DEVICE_SIGNING_SECRET = 'itest-device-signing-secret-0123456789';
const REQUESTED_LITRES = 10;

const serverEnv = {
  ...process.env,
  NODE_ENV: 'test',
  PORT: String(PORT),
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'itest-jwt-secret',
  ESP32_API_KEY,
  DEVICE_SIGNING_SECRET,
  RATE_LIMIT_MAX: '2000',
};

// ---- Small helpers ------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;

function ok(message) {
  console.log(`  \x1b[32m✓\x1b[0m ${message}`);
}

function fail(message) {
  failures++;
  console.error(`  \x1b[31m✗ ${message}\x1b[0m`);
}

function assert(cond, message) {
  if (cond) ok(message);
  else fail(message);
  return cond;
}

function approx(a, b, eps = 0.005) {
  return Math.abs(Number(a) - Number(b)) <= eps;
}

function cents(v) {
  return Math.round(Number(v) * 100);
}

async function api(pathname, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitFor(desc, fn, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      lastError = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${desc}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch { /* fall through to forceful kill */ }
  setTimeout(() => {
    if (child.exitCode === null) {
      try {
        if (process.platform === 'win32') execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: 'ignore' });
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    }
  }, 1500).unref();
}

// ---- Process management ---------------------------------------------------------
function startServer() {
  const child = spawn(process.execPath, ['src/index.js'], {
    env: serverEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(`[srv] ${d}`));
  child.stderr.on('data', (d) => logs.push(`[srv!] ${d}`));
  child.logs = logs;
  return child;
}

function findPython() {
  for (const cmd of [['python', '--version'], ['py', '-3', '--version']]) {
    try {
      execSync(cmd.join(' '), { stdio: 'ignore' });
      return cmd[0] === 'py' ? ['py', '-3'] : [cmd[0]];
    } catch { /* try next */ }
  }
  return null;
}

function startMock(pythonCmd, pumpId) {
  const script = path.join(__dirname, '..', 'esp32-mock', 'pump_mock.py');
  const child = spawn(pythonCmd[0], [
    ...pythonCmd.slice(1),
    script,
    '--base-url', BASE,
    '--api-key', ESP32_API_KEY,
    '--signing-secret', DEVICE_SIGNING_SECRET,
    '--pump-id', pumpId,
    '--rate', '20', // 10 L in 0.5 s — keep the test fast
    '--poll-interval', '0.4',
    '--status-interval', '0.4',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: path.join(__dirname, '..'),
  });
  const logs = [];
  child.stdout.on('data', (d) => logs.push(`[mock] ${d}`.trim()));
  child.stderr.on('data', (d) => logs.push(`[mock!] ${d}`.trim()));
  child.logs = logs;
  return child;
}

// ---- Main ------------------------------------------------------------------------
async function main() {
  const startedAt = Date.now();
  console.log(`E2E: request → authorize → mock-dispense → settle → receipt`);
  console.log(`  db: ${DB_URL.replace(/:[^:@/]+@/, ':****@')}`);
  console.log(`  api: ${BASE}\n`);

  let server = null;
  let mock = null;
  let pythonCmd = null;

  try {
    // 0. Pre-flight ---------------------------------------------------------------
    console.log('Pre-flight');
    if (!assert(Number(process.versions.node.split('.')[0]) >= 20, `Node >= 20 (found ${process.versions.node})`)) {
      throw new Error('Node 20+ required');
    }
    pythonCmd = findPython();
    if (!assert(pythonCmd !== null, 'Python 3 available for the pump mock')) {
      throw new Error('Python not found — install it or run with the real ESP32 instead');
    }

    if (!hasFlag('--skip-migrate')) {
      console.log('  applying Prisma schema to the test database…');
      try {
        execSync('npx prisma db push --skip-generate', {
          env: serverEnv, stdio: 'pipe', cwd: path.join(__dirname, '..'), timeout: 120000,
        });
        ok('schema applied (prisma db push)');

        // Reset leftover state from earlier runs — the test DB is throwaway.
        // (Skipped with --skip-migrate, which means "leave my data alone".)
        try {
          const pgBins = [
            process.env.PGBIN,
            'C:\\Program Files\\PostgreSQL\\17\\bin',
            'C:\\Program Files\\PostgreSQL\\16\\bin',
            'C:\\Program Files\\PostgreSQL\\15\\bin',
          ].filter(Boolean);
          const psql = pgBins.map((d) => path.join(d, 'psql.exe')).find((p) => fs.existsSync(p));
          if (!psql) throw new Error('psql.exe not found');
          // psql doesn't understand Prisma's "?schema=" URL parameter — strip it.
          const psqlUrl = DB_URL.split('?')[0];
          execFileSync(
            psql,
            [
              psqlUrl,
              '-c',
              "DO $$ DECLARE r RECORD; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname='public') LOOP EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE'; END LOOP; END $$;",
            ],
            { stdio: 'pipe', timeout: 30000 },
          );
          ok('test database reset (all tables truncated)');
        } catch (e) {
          console.log(`  ⚠ could not reset the test database (${String(e.message).split('\n')[0].slice(0, 160)}) — reusing existing data`);
        }
      } catch (e) {
        console.error(String(e.stderr || e.message).slice(0, 600));
        throw new Error(
          'Could not reach/prepare the test database. Create it first, e.g.:\n' +
          '    docker compose up -d db\n' +
          '    docker exec smart-fuel-db psql -U postgres -c "CREATE DATABASE smart_fuel_test;"\n' +
          'or pass --db-url postgresql://user:pass@host:5432/mydb'
        );
      }
    } else {
      console.log('  skipping migrate (--skip-migrate)');
    }

    // 1. Boot the server ------------------------------------------------------------
    console.log('\nBooting server');
    server = startServer();
    await waitFor('GET /api/health', async () => {
      const r = await fetch(`${BASE}/api/health`);
      return r.ok;
    }, { timeoutMs: 30000, intervalMs: 400 });
    ok(`server up on :${PORT}`);

    // 2. Seed -------------------------------------------------------------------------
    console.log('\nSeeding demo data');
    try {
      execSync('node prisma/seed.js', { env: serverEnv, stdio: 'pipe', cwd: path.join(__dirname, '..'), timeout: 60000 });
      ok('seed complete (idempotent)');
    } catch (e) {
      console.error(String(e.stderr || e.message).slice(0, 400));
      throw new Error('Seeding failed');
    }

    // 3. Log in -------------------------------------------------------------------------
    console.log('\nAuthenticating');
    const cust = await api('/api/auth/login', { method: 'POST', body: { email: 'john@example.com', password: 'customer123' } });
    if (!assert(cust.status === 200 && cust.data.accessToken, 'customer login (john@example.com)')) {
      throw new Error('customer login failed');
    }
    const staff = await api('/api/auth/login', { method: 'POST', body: { email: 'admin', password: 'admin123' } });
    if (!assert(staff.status === 200 && staff.data.accessToken, 'staff login (admin)')) {
      throw new Error('staff login failed');
    }
    const custToken = cust.data.accessToken;
    const staffToken = staff.data.accessToken;

    // 4. Pick a free pump ------------------------------------------------------------------
    console.log('\nSelecting pump');
    const stations = await api('/api/stations');
    assert(stations.status === 200 && stations.data.length > 0, `stations listed (${(stations.data || []).length})`);
    const station = stations.data[0];
    const pumps = (await api(`/api/stations/${station.id}/pumps`)).data || [];
    const pump = pumps.find((p) => p.status === 'AVAILABLE');
    if (!assert(pump, `available pump at "${station.name}" (found ${pumps.length}: ${pumps.map((p) => `${p.pump_number}:${p.status}`).join(', ')})`)) {
      throw new Error('no available pump — re-run against a fresh test DB');
    }
    ok(`pump #${pump.pump_number} (${pump.fuel_type.name} @ ${Number(pump.fuel_type.price_per_litre).toFixed(3)}/L)`);

    // 5. Wallet snapshot --------------------------------------------------------------------
    const walletBefore = (await api('/api/wallet', { token: custToken })).data;
    assert(walletBefore && walletBefore.available_balance !== undefined,
      `wallet snapshot: available ${Number(walletBefore.available_balance).toFixed(2)}, reserved ${Number(walletBefore.reserved_balance).toFixed(2)}`);

    // 6. Start the pump mock (it polls while we create the request) --------------------------
    mock = startMock(pythonCmd, pump.id);

    // 7. Customer creates the request (reserve) ----------------------------------------------
    console.log('\nRequest & reserve');
    const created = await api('/api/fuel-requests', {
      method: 'POST',
      token: custToken,
      body: {
        station_id: station.id,
        fuel_type_id: pump.fuel_type.id,
        pump_id: pump.id,
        requested_litres: REQUESTED_LITRES,
      },
    });
    if (!assert(created.status === 201, `POST /fuel-requests → 201 (got ${created.status} ${JSON.stringify(created.data).slice(0, 160)})`)) {
      throw new Error('request creation failed');
    }
    const request = created.data;
    assert(!!request.request_reference, `request_reference ${request.request_reference}`);
    assert(request.status === 'RESERVED', `status RESERVED (got ${request.status})`);
    assert(approx(request.requested_amount, REQUESTED_LITRES * Number(request.price_per_litre), 0.001),
      `reserved ${Number(request.requested_amount).toFixed(2)} = ${REQUESTED_LITRES} L × ${Number(request.price_per_litre).toFixed(3)}`);

    const walletAfterReserve = (await api('/api/wallet', { token: custToken })).data;
    assert(cents(walletAfterReserve.available_balance) === cents(Number(walletBefore.available_balance) - Number(request.requested_amount)),
      'available_balance decreased by the reserved amount');
    assert(cents(walletAfterReserve.reserved_balance) === cents(Number(walletBefore.reserved_balance) + Number(request.requested_amount)),
      'reserved_balance increased by the reserved amount');

    // 8. Staff assigns the pump and authorizes ----------------------------------------------
    console.log('\nAssign & authorize');
    const assigned = await api(`/api/staff/requests/${request.id}/assign-pump`, {
      method: 'POST', token: staffToken, body: { pump_id: pump.id },
    });
    assert(assigned.status === 200, `assign-pump → 200 (got ${assigned.status} ${JSON.stringify(assigned.data).slice(0, 160)})`);

    const authed = await api(`/api/staff/fuel-requests/${request.id}/authorize`, { method: 'POST', token: staffToken, body: {} });
    if (!assert(authed.status === 200, `authorize → 200 (got ${authed.status} ${JSON.stringify(authed.data).slice(0, 160)})`)) {
      throw new Error('authorization failed');
    }
    const txnId = authed.data.transaction.id;
    const txnRef = authed.data.transaction.transaction_reference;
    assert(/^FUEL-\d{8}-\d{6}$/.test(txnRef), `transaction_reference format ${txnRef}`);
    assert(authed.data.transaction.status === 'AUTHORIZED', 'transaction status AUTHORIZED');

    // 9. The mock dispenses; wait for settlement ----------------------------------------------
    console.log('\nMock dispensing (esp32-mock/pump_mock.py)');
    const settled = await waitFor('transaction COMPLETED', async () => {
      const r = await api(`/api/transactions/${txnId}`, { token: custToken });
      return r.status === 200 && r.data.status === 'COMPLETED' ? r.data : null;
    }, { timeoutMs: 60000, intervalMs: 700 });
    ok(`dispensed ${Number(settled.actual_litres).toFixed(3)} L → settled ${settled.transaction_reference}`);

    // 10. Assertions on the settled state ------------------------------------------------------
    console.log('\nVerification');
    assert(settled.status === 'COMPLETED', 'fuel_transaction status COMPLETED');
    assert(approx(settled.actual_litres, REQUESTED_LITRES, 0.001), `actual_litres = ${Number(settled.actual_litres).toFixed(3)}`);
    assert(approx(settled.final_amount, Number(settled.actual_litres) * Number(settled.price_per_litre), 0.01),
      `final_amount ${Number(settled.final_amount).toFixed(2)} = actual × ${Number(settled.price_per_litre).toFixed(3)}`);

    // Wallet math: payment leaves the reserve; any over-reserve refund returns to available.
    const walletAfter = (await api('/api/wallet', { token: custToken })).data;
    const expectedAvailable = Number(walletBefore.available_balance) - Number(settled.final_amount);
    const expectedReserved = Number(walletBefore.reserved_balance);
    assert(cents(walletAfter.available_balance) === cents(expectedAvailable),
      `available ${Number(walletAfter.available_balance).toFixed(2)} == before − final_amount`);
    assert(cents(walletAfter.reserved_balance) === cents(expectedReserved),
      `reserved back to ${Number(walletAfter.reserved_balance).toFixed(2)}`);

    // Ledger: a RESERVATION row for the request and a FUEL_PAYMENT row for the final amount.
    const ledger = await api('/api/wallet/transactions?page=1&limit=20', { token: custToken });
    const items = ledger.data.items || [];
    assert(items.some((t) => t.type === 'RESERVATION' && (t.description || '').includes(request.request_reference)),
      `ledger RESERVATION row for ${request.request_reference}`);
    assert(items.some((t) => t.type === 'FUEL_PAYMENT' && approx(t.amount, settled.final_amount, 0.001)),
      `ledger FUEL_PAYMENT row of ${Number(settled.final_amount).toFixed(2)}`);

    // 11. Receipt --------------------------------------------------------------------------------
    console.log('\nReceipt');
    const withReceipt = await waitFor('receipt_url on the settled transaction', async () => {
      const r = await api(`/api/transactions/${txnId}`, { token: custToken });
      return r.status === 200 && r.data.receipt_url ? r.data : null;
    }, { timeoutMs: 30000, intervalMs: 600 });
    ok(`receipt_url ${withReceipt.receipt_url}`);

    const pdfRes = await fetch(BASE + withReceipt.receipt_url, { headers: { Authorization: `Bearer ${custToken}` } });
    assert(pdfRes.status === 200, `receipt download → 200 (got ${pdfRes.status})`);
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    assert(buf.subarray(0, 5).toString('ascii') === '%PDF-', `payload is a PDF (${buf.length} bytes)`);

    // The receipt URL embeds its own signed token — anonymous fetch must work too.
    const anonRes = await fetch(BASE + withReceipt.receipt_url);
    assert(anonRes.status === 200, 'receipt URL works without a bearer token (signed link)');

    console.log(`\n\x1b[32mE2E PASSED\x1b[0m — full loop verified in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (error) {
    fail(error.message);
    console.log(`\n\x1b[31mE2E FAILED\x1b[0m after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    killTree(mock);
    killTree(server);
    await sleep(500);
    const dump = [...(mock?.logs || []), ...(server?.logs || [])];
    if (failures > 0 && dump.length > 0) {
      console.log('\n--- process output (tail) ---');
      for (const line of dump.slice(-40)) console.log('  ' + line);
    }
  }

  process.exit(failures === 0 ? 0 : 1);
}

main();
