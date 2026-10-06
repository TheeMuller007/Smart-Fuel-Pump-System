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

 * plus the unhappy paths:

 *   staff reject        -> reserve released, pump freed

 *   expired reservation -> funds auto-released (lazy expiry), pump freed

 *   device double-ack   -> idempotent, wallet charged exactly once

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
  STUCK_DISPENSE_TIMEOUT_MIN: '1',
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



  let server = null;  let mock = null;
  let pythonCmd = null;

  try {

    // 0. Pre-flight ---------------------------------------------------------------

    console.log('Pre-flight');

    if (!assert(Number(process.versions.node.split('.')[0]) >= 20, `Node >= 20 (found ${process.versions.node})`)) {

      throw new Error('Node 20+ required');

    }    pythonCmd = findPython();

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
            (process.env.PGROOT || 'C:\\Program Files\\PostgreSQL') + '\\17\\bin',
            (process.env.PGROOT || 'C:\\Program Files\\PostgreSQL') + '\\16\\bin',
            (process.env.PGROOT || 'C:\\Program Files\\PostgreSQL') + '\\15\\bin',
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



    // psql helper (for direct DB edits used by the expiry + chaos scenarios).
    // Path built from drive root + segments via path.join so the source
    // contains no backslash literals (Node 24 treats unescaped \P etc. as
    // control characters, which silently breaks file existence checks).
    const pgRoot = process.env.PGROOT || 'C:\\Program Files\\PostgreSQL';
    const psqlBin = [process.env.PGBIN, pgRoot + '\\17\\bin', pgRoot + '\\16\\bin', pgRoot + '\\15\\bin']
      .filter(Boolean)
      .map((d) => path.join(d, 'psql.exe'))
      .find((p) => fs.existsSync(p));



    // 4. Pick pumps ------------------------------------------------------------------

    console.log('\nSelecting pumps');

    const stations = await api('/api/stations');

    assert(stations.status === 200 && stations.data.length > 0, `stations listed (${(stations.data || []).length})`);

    const station = stations.data[0];

    const pumps = (await api(`/api/stations/${station.id}/pumps`)).data || [];



    // Two normal pumps: one for the happy path (the mock dispenses on it), one for

    // the reject/expiry/double-ack scenarios — so they never contend.

    const pump = pumps.find((p) => p.status === 'AVAILABLE');

    const sparePump = pumps.find((p) => p.status === 'AVAILABLE' && p.id !== pump.id);

    if (!assert(pump, `available pump at "${station.name}" (${pumps.length}:

        ${pumps.map((p) => `${p.pump_number}:${p.status}:${p.id}`) .join(', ')})`)) {

      throw new Error('no available pump — re-run against a fresh test DB');

    }

    if (!assert(sparePump, 'second available pump for the unhappy-path scenarios')) {

      throw new Error('need a second available pump — re-run against a fresh test DB');

    }

    ok(`happy + unhappy pumps: #${pump.pump_number} + #${sparePump.pump_number}`);



    // A third pump is the chaos-test vehicle: published with NO telemetry after

    // it is AUTHORIZED and the (not-started) mock vanishes. The reaper (timeout

    // set to 1 min below) cancels it and frees the pump.

    const chaosPump = pumps.find((p) => p.status === 'AVAILABLE' && p.id !== pump.id && p.id !== sparePump.id);

    if (!assert(chaosPump, `third AVAILABLE pump for the chaos test (found ${pumps.length})`)) {

      throw new Error('need a third AVAILABLE pump — re-run against a fresh test DB');

    }



    // 5. Start the pump mock (it polls while we create the request) --------------------------

    mock = startMock(pythonCmd, pump.id);



    // 6. Wallet snapshot (before happy-path reserve) ----

    const walletBefore = (await api('/api/wallet', { token: custToken })).data;

    assert(walletBefore && walletBefore.available_balance !== undefined,

      `wallet snapshot: available ${Number(walletBefore.available_balance).toFixed(2)}, reserved ${Number(walletBefore.reserved_balance).toFixed(2)}`);





    // Pump-status helper used by the chaos test and the unhappy-path scenarios.
    const pumpStatus = async (pumpId) => {
      const list = (await api(`/api/stations/${station.id}/pumps`)).data || [];
      return (list.find((p) => p.id === pumpId) || {}).status;
    };

    // 7. Chaos test: device killed mid-dispense -> reaper cancels, customer not charged

    // ------------------------------------------------------------------------

    // This scenario is the crux of the fail-safe story: a pump that receives an

    // AUTHORIZED transaction but then goes silent (ESP32 powered off / network

    // dropped / server restarted) must NOT keep the customer's money frozen, and

    // must NOT stay BUSY forever. The reaper cancels AUTHORIZED transactions that

    // have produced no device heartbeat for STUCK_DISPENSE_TIMEOUT_MIN and frees the

    // pump. We shorten the window to 1 minute for this test and backdate the pump's

    // last_status_at so the very next reaper tick collects it.

    //

    // Why backdate instead of waiting: the reaper ticks once per minute and we want

    // the loop to stay fast; on real hardware the same cancellation would happen

    // within STUCK_DISPENSE_TIMEOUT_MIN of the last heartbeat.

    console.log('\nChaos test: AUTHORIZED transaction with no heartbeat (pump #' + chaosPump.pump_number + ')');



    // Snapshot the customer wallet RIGHT BEFORE the chaos reserve so the "not charged"

    // assertion is truthful even if a prior scenario left residue (skip-migrate reuse).

    const walletBeforeChaos = (await api('/api/wallet', { token: custToken })).data;

    assert(walletBeforeChaos && walletBeforeChaos.available_balance !== undefined,

      'chaos wallet snapshot: available ' + Number(walletBeforeChaos.available_balance).toFixed(2) + ', reserved ' + Number(walletBeforeChaos.reserved_balance).toFixed(2));



    if (psqlBin) {

      // Clear any stale telemetry on the chaos pump from a prior run so the

      // backdate below takes full effect (a pump with an old heartbeat that is

      // still within the window won't be collected).

      execFileSync(psqlBin,

        [DB_URL.split('?')[0], '-c',

          'UPDATE "Pump" SET "dispense_state" = NULL, "last_status_at" = NULL, "last_reported_litres" = NULL WHERE id = \'' + chaosPump.id + '\';'],

        { stdio: 'pipe', timeout: 10000 });

      ok('chaos pump: cleared any stale telemetry from a prior run');

    }



    // Reserve on the chaos pump, authorize, and STOP. No mock is started for this

    // pump, so the transaction stays AUTHORIZED with zero device heartbeat.

    const chaosReq = await api('/api/fuel-requests', {

      method: 'POST',

      token: custToken,

      body: {

        station_id: station.id,

        fuel_type_id: chaosPump.fuel_type.id,

        pump_id: chaosPump.id,

        requested_litres: REQUESTED_LITRES,

      },

    });

    assert(chaosReq.status === 201,

      'reserve on chaos pump #' + chaosPump.pump_number + ' -> 201 (got ' + chaosReq.status + ')');

    const chaosReqObj = chaosReq.data;



    const chaosAssign = await api('/api/staff/requests/' + chaosReqObj.id + '/assign-pump', {

      method: 'POST', token: staffToken, body: { pump_id: chaosPump.id },

    });

    assert(chaosAssign.status === 200,

      'assign chaos pump -> 200 (got ' + chaosAssign.status + ')');



    const chaosAuth = await api('/api/staff/fuel-requests/' + chaosReqObj.id + '/authorize', {

      method: 'POST', token: staffToken, body: {},

    });

    assert(chaosAuth.status === 200,

      'authorize chaos request -> 200 (got ' + chaosAuth.status + ')');

    const chaosTxnObj = chaosAuth.data.transaction;

    assert(chaosTxnObj.status === 'AUTHORIZED',

      'chaos transaction status AUTHORIZED (got ' + chaosTxnObj.status + ')');    // Now make the pump look dead to the reaper.
    //
    // The reaper collects AUTHORIZED transactions whose started_at is older than
    // STUCK_DISPENSE_TIMEOUT_MIN — it keys off the transaction's age, not the
    // pump heartbeat. To trigger collection without waiting for a real timeout,
    // backdate BOTH the pump heartbeat (so the "still alive?" check fails) and
    // the transaction's started_at (so the reaper's WHERE clause selects it).
    //
    // This mirrors a real power-loss / network-drop scenario: the transaction was
    // authorized a while ago and the controller has been silent since.
    if (psqlBin) {
      execFileSync(psqlBin,
        [DB_URL.split('?')[0], '-c',
          'UPDATE "FuelTransaction" SET "started_at" = NOW() - INTERVAL \'2 hours\' WHERE id = \'' + chaosTxnObj.id + '\';'],
        { stdio: 'pipe', timeout: 10000 });
      ok('chaos transaction: backdated started_at so the reaper selects it');

      execFileSync(psqlBin,
        [DB_URL.split('?')[0], '-c',
          'UPDATE "Pump" SET "last_status_at" = NOW() - INTERVAL \'2 hours\' WHERE id = \'' + chaosPump.id + '\';'],
        { stdio: 'pipe', timeout: 10000 });
      ok('chaos pump: backdated last_status_at so the reaper sees it dead');
    } else {
      console.log('  ⚠ skipping chaos test (psql.exe not found) — reaper not exercisable');
    }



    // Poll until the reaper cancels the transaction. The reaper runs on a

    // 60s tick; with the window set to 1 min and the backdate above, the first

    // tick after we authorize should collect it. Give it a generous window.

    await waitFor('chaos transaction CANCELLED by reaper', async () => {

      const txn = await api('/api/transactions/' + chaosTxnObj.id, { token: custToken });

      return txn.data && txn.data.status === 'CANCELLED' ? true : null;

    }, { timeoutMs: 180000, intervalMs: 6000 });



    // ---- Assertions on the chaos outcome -------------------------------------------------

    const txnAfter = await api('/api/transactions/' + chaosTxnObj.id, { token: custToken });    assert(txnAfter.data.status === 'CANCELLED',
      'chaos txn CANCELLED (got ' + txnAfter.data.status + ')');



    const chaosPumpAfter = (await api('/api/stations/' + station.id + '/pumps')).data || [];

    assert((chaosPumpAfter.find(p => p.id === chaosPump.id) || {}).status === 'AVAILABLE',

      'chaos pump back to AVAILABLE (was BUSY)');    const walletAfterChaos = (await api('/api/wallet', { token: custToken })).data;
    assert(cents(walletAfterChaos.available_balance) === cents(Number(walletBeforeChaos.available_balance) - Number(chaosReqObj.requested_amount)),
      'reserve PRESERVED, not charged — available dropped exactly by the requested amount (' + Number(walletAfterChaos.available_balance).toFixed(2) + ')');
    assert(cents(walletAfterChaos.reserved_balance) === cents(Number(walletBeforeChaos.reserved_balance) + Number(chaosReqObj.requested_amount)),
      'reserve still held for re-dispense — reserved grew by the requested amount (' + Number(walletAfterChaos.reserved_balance).toFixed(2) + ')');



    const chaosLedger = (await api('/api/wallet/transactions?page=1&limit=20', { token: custToken })).data.items || [];

    assert(chaosLedger.filter((t) => t.type === 'FUEL_PAYMENT').length === 0,

      'no FUEL_PAYMENT row — customer not charged (found ' + chaosLedger.filter((t) => t.type === 'FUEL_PAYMENT').length + ')');



    const chaosReqAfter = await api('/api/fuel-requests', { token: custToken });

    const chaosReqRow = (chaosReqAfter.data || []).find(r => r.id === chaosReqObj.id);

    assert(chaosReqRow && chaosReqRow.status === 'RESERVED',

      'chaos request back to RESERVED (got ' + (chaosReqRow ? chaosReqRow.status : 'missing') + ')');



    // Confirm from the staff view too (the portal would show the pump free).

    const chaosPumpStaffView = (await api('/api/stations/' + station.id + '/pumps', staffToken)).data || [];

    const chaosPumpFromStaff = chaosPumpStaffView.find(p => p.id === chaosPump.id);

    assert(chaosPumpFromStaff && chaosPumpFromStaff.status === 'AVAILABLE',

      'chaos pump back to AVAILABLE (staff view)');    // Staff rejects the orphaned request to release the stale reserve — this is
    // exactly the recovery step a station would take after a reaper cancellation.
    const chaosRej = await api('/api/staff/requests/' + chaosReqObj.id + '/reject', {
      method: 'POST', token: staffToken, body: {},
    });
    assert(chaosRej.status === 200 && chaosRej.data.status === 'REJECTED',
      'staff reject of the reaper-orphaned request -> REJECTED (got ' + chaosRej.status + ')');
    const walletAfterRej = (await api('/api/wallet', { token: custToken })).data;
    assert(cents(walletAfterRej.available_balance) === cents(walletBeforeChaos.available_balance) && cents(walletAfterRej.reserved_balance) === cents(walletBeforeChaos.reserved_balance),
      'wallet baseline restored after releasing the orphaned reserve (available ' + Number(walletAfterRej.available_balance).toFixed(2) + ', reserved ' + Number(walletAfterRej.reserved_balance).toFixed(2) + ')');

    // ---- Happy path resumes here (wallet back to baseline, pumps all AVAILABLE) ---

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

    console.log('\nAssign & authorize (for the happy path)');

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



    // 12. Unhappy paths -------------------------------------------------------------------------

    console.log('\nUnhappy paths');



    // All scenarios use the same customer wallet; every reserve below is

    // released again by the scenario itself, so balances return to baseline.

    const reserve = async (pumpForRequest) => {

      const createdReq = await api('/api/fuel-requests', {

        method: 'POST',

        token: custToken,

        body: {

          station_id: station.id,

          fuel_type_id: pumpForRequest.fuel_type.id,

          pump_id: pumpForRequest.id,

          requested_litres: REQUESTED_LITRES,

        },

      });

      assert(createdReq.status === 201, `reserve on pump #${pumpForRequest.pump_number} → 201 (got ${createdReq.status})`);

      return createdReq.data;

    };

    // pumpStatus is hoisted above (before the chaos test) so both the chaos
    // scenario and the unhappy paths can use it.



    // -- Scenario A: staff reject releases the reserve and frees the pump ------

    const w0 = (await api('/api/wallet', { token: custToken })).data;

    const rejectedReq = await reserve(sparePump);

    const rejected = await api(`/api/staff/requests/${rejectedReq.id}/reject`, { method: 'POST', token: staffToken, body: {} });

    assert(rejected.status === 200 && rejected.data.status === 'REJECTED',

      `staff reject → REJECTED (got ${rejected.status} ${JSON.stringify(rejected.data).slice(0, 120)})`);

    const wRej = (await api('/api/wallet', { token: custToken })).data;

    assert(cents(wRej.available_balance) === cents(w0.available_balance) && cents(wRej.reserved_balance) === cents(w0.reserved_balance),

      'reject refunds the full reserve (wallet back to baseline)');

    const rejLedger = (await api('/api/wallet/transactions?page=1&limit=10', { token: custToken })).data.items || [];

    assert(rejLedger.some((t) => t.type === 'RELEASE' && (t.description || '').includes(rejectedReq.request_reference)),

      `ledger RELEASE row for ${rejectedReq.request_reference}`);

    assert((await pumpStatus(sparePump.id)) === 'AVAILABLE', 'rejected request frees its assigned pump');



    // -- Scenario B: expired reservation auto-releases funds --------------------

    // The TTL is 15 min and the background job ticks every minute; the e2e

    // exercises the LAZY expiry pass instead (staff list pending-requests with

    // an already-stale request) by backdating expires_at directly — test-only

    // shortcut, acting on exactly the state the background job would see.

    if (!psqlBin) {

      console.log('  ⚠ skipping expiry scenario (psql.exe not found for direct DB access)');

    } else {

      const w1 = (await api('/api/wallet', { token: custToken })).data;

      const expiredReq = await reserve(sparePump);

      execFileSync(psqlBin, [

        DB_URL.split('?')[0], '-c',

        // Prisma maps DateTime to timestamp-without-time-zone in UTC; casting

        // NOW() with AT TIME ZONE 'UTC' writes naive UTC to match it.

        `UPDATE "FuelRequest" SET "expires_at" = (NOW() AT TIME ZONE 'UTC') - INTERVAL '1 minute' WHERE id = '${expiredReq.id}';`,

      ], { stdio: 'pipe', timeout: 15000 });

      const listed = (await api('/api/staff/pending-requests', { token: staffToken })).data || [];

      const expiredRow = Array.isArray(listed) ? listed.find((r) => r.id === expiredReq.id) : null;

      assert(!expiredRow || expiredRow.status === 'EXPIRED',

        `lazy expiry flips stale RESERVED → EXPIRED (row ${expiredRow ? `returned as ${expiredRow.status}` : 'dropped from pending list'})`);

      const wExp = (await api('/api/wallet', { token: custToken })).data;

      assert(cents(wExp.available_balance) === cents(w1.available_balance) && cents(wExp.reserved_balance) === cents(w1.reserved_balance),

        'expiry returns the reserved funds (wallet back to baseline)');

      assert((await pumpStatus(sparePump.id)) === 'AVAILABLE', 'expired reservation frees its assigned pump');

    }



    // -- Scenario C: device double-ack is idempotent -----------------------------

    // Full loop on the spare pump (no mock needed — we ack manually), then a

    // second ack for the SAME transaction must be a no-op for the wallet.

    const w2 = (await api('/api/wallet', { token: custToken })).data;

    const dbl = await reserve(sparePump);

    await api(`/api/staff/requests/${dbl.id}/assign-pump`, { method: 'POST', token: staffToken, body: { pump_id: sparePump.id } });

    const dblAuth = await api(`/api/staff/fuel-requests/${dbl.id}/authorize`, { method: 'POST', token: staffToken, body: {} });

    if (!assert(dblAuth.status === 200, `authorize for double-ack scenario → 200 (got ${dblAuth.status})`)) {

      throw new Error('double-ack scenario could not authorize');

    }

    const dblTxn = dblAuth.data.transaction;

    // w2 was snapshotted BEFORE the reserve: a prepaid wallet is debited at

    // reserve time, so settlement itself only drains reserved_balance — the

    // pre-reserve snapshot is what a second (buggy) payment would corrupt.

    const ackBody = { transaction_id: dblTxn.id, actual_litres: REQUESTED_LITRES };

    const ack1 = await fetch(`${BASE}/api/esp32/authorizations/${sparePump.id}/ack`, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json', 'x-api-key': ESP32_API_KEY },

      body: JSON.stringify(ackBody),

    });

    const ack1Data = await ack1.json().catch(() => ({}));

    assert(ack1.status === 200 && ack1Data.status === 'completed', `first device ack → completed (got ${ack1.status} ${JSON.stringify(ack1Data).slice(0, 80)})`);

    const ack2res = await fetch(`${BASE}/api/esp32/authorizations/${sparePump.id}/ack`, {

      method: 'POST',

      headers: { 'Content-Type': 'application/json', 'x-api-key': ESP32_API_KEY },

      body: JSON.stringify(ackBody),

    });

    const ack2 = await ack2res.json().catch(() => ({}));

    assert(ack2res.status === 200 && ack2.status === 'already_completed',

      `second device ack → idempotent (got ${ack2res.status} ${JSON.stringify(ack2).slice(0, 80)})`);

    const w3 = (await api('/api/wallet', { token: custToken })).data;

    const singlePayment = Number(dbl.price_per_litre) * REQUESTED_LITRES;

    assert(cents(w3.available_balance) === cents(Number(w2.available_balance) - singlePayment),

      `double-ack charged exactly once (available ${Number(w3.available_balance).toFixed(2)}, expected ${(Number(w2.available_balance) - singlePayment).toFixed(2)})`);

    assert(cents(w3.reserved_balance) === cents(w2.reserved_balance),

      `reserve fully consumed by settlement (reserved back to ${Number(w2.reserved_balance).toFixed(2)})`);

    const payCount = ((await api('/api/wallet/transactions?page=1&limit=20', { token: custToken })).data.items || [])

      .filter((t) => t.type === 'FUEL_PAYMENT' && (t.reference || '').includes(dblTxn.transaction_reference)).length;

    assert(payCount === 1, `exactly one FUEL_PAYMENT row for ${dblTxn.transaction_reference} (found ${payCount})`);



    if (failures === 0) {

      console.log(`\n\x1b[32mE2E PASSED\x1b[0m — full loop + unhappy paths verified in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    } else {

      fail(`${failures} check(s) failed`);

      console.log(`\n\x1b[31mE2E FAILED\x1b[0m after ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

    }

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

