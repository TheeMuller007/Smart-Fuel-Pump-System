#!/usr/bin/env node
/**
 * Project-local PostgreSQL helper (no Docker, no admin rights needed).
 *
 * The app's database is a dedicated cluster in <project>/.pgdata running on
 * port 5433, created with `initdb` from the machine's PostgreSQL install.
 * It does NOT survive reboots (it's a plain process, not a service), so run:
 *
 *   npm run db:start      # start the cluster (no-op if already running)
 *   npm run db:stop       # stop it cleanly
 *   npm run db:status     # report current state
 *
 * Requires: PostgreSQL binaries in "C:\Program Files\PostgreSQL\17\bin"
 * (override with PGBIN env var if installed elsewhere).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const net = require('net');

const ROOT = path.resolve(__dirname, '..');
const PGDATA = path.join(ROOT, '.pgdata');
const PGLOG = path.join(ROOT, '.pglog');
const PGPWFILE = path.join(ROOT, '.pgpwfile');
const PORT = 5433;
const DB_PASSWORD = 'clidemlambo12334'; // local cluster superuser password
const PGBIN_CANDIDATES = [
  process.env.PGBIN,
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  'C:\\Program Files\\PostgreSQL\\15\\bin',
].filter(Boolean);

function pgBinary(name) {
  for (const dir of PGBIN_CANDIDATES) {
    const full = path.join(dir, `${name}.exe`);
    if (fs.existsSync(full)) return full;
  }
  console.error(`Could not find ${name}.exe. Install PostgreSQL or set PGBIN.`);
  process.exit(1);
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 1500 });
    s.on('connect', () => { s.end(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const portFree = !(await portOpen('127.0.0.1', PORT));

  if (cmd === 'status') {
    if (fs.existsSync(PGDATA) && !portFree) console.log(`RUNNING on port ${PORT} (data: ${PGDATA})`);
    else if (fs.existsSync(PGDATA)) console.log(`STOPPED (data dir exists at ${PGDATA} — run "npm run db:start")`);
    else console.log('NOT INITIALIZED (run "npm run db:setup")');
    return;
  }

  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
    if (cmd === 'setup') {
      console.log(`Initializing a project-local PostgreSQL cluster in ${PGDATA}...`);
      fs.writeFileSync(PGPWFILE, DB_PASSWORD);
      const init = spawnSync(pgBinary('initdb'), ['-D', PGDATA, '-U', 'postgres', '--pwfile=' + PGPWFILE, '--auth=scram-sha-256', '-E', 'UTF8'], { stdio: 'inherit' });
      fs.rmSync(PGPWFILE, { force: true });
      if (init.status !== 0) {
        console.error('initdb failed. Is PostgreSQL installed?');
        process.exit(1);
      }
      console.log('Cluster initialized. Run "npm run db:start" to boot it.');
      return;
    }
    console.error(`Cluster at ${PGDATA} is not initialized. Run "npm run db:setup" first.`);
    process.exit(1);
  }

  if (cmd === 'start') {
    if (!portFree) {
      console.log(`Already running on port ${PORT}.`);
      return;
    }
    console.log('Starting local PostgreSQL on port 5433...');
    spawnSync(pgBinary('pg_ctl'), ['-D', PGDATA, '-o', `-p ${PORT}`, '-l', PGLOG, 'start'], { stdio: 'ignore' });
    // pg_ctl start returns when the server detaches; ignore odd exit codes on
    // Windows where console-handle quirks can produce a non-zero code anyway.
    for (let i = 0; i < 20; i++) {
      await new Promise((r2) => setTimeout(r2, 500));
      if (!(await portOpen('127.0.0.1', PORT))) continue;
      console.log(`PostgreSQL is up on port ${PORT}. Run "npm run dev" to start the app.`);
      return;
    }
    console.error(`Server did not come up on port ${PORT}. Check ${PGLOG}.`);
    process.exit(1);
  }

  if (cmd === 'stop') {
    if (portFree) {
      console.log('Not running.');
      return;
    }
    spawnSync(pgBinary('pg_ctl'), ['-D', PGDATA, '-m', 'fast', 'stop'], { stdio: 'inherit' });
    console.log('Stopped.');
    return;
  }

  console.error(`Unknown command "${cmd}". Use start | stop | status.`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
