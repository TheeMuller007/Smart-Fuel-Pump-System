#!/usr/bin/env node
/**
 * Database + receipts backup, restore and restore-drill tool.
 *
 *   node scripts/backup.js backup  [--out <dir>] [--keep <n>]
 *   node scripts/backup.js restore --file <backup.tar.gz> [--force]
 *   node scripts/backup.js drill   [--keep-hole]   (full round-trip test)
 *
 * backup:  pg_dump the database (custom format) plus the receipts/ folder,
 *          wrapped in one timestamped tar.gz under backups/.
 * restore: drops and recreates the database, restores the dump with pg_restore,
 *          and unpacks the receipts over the existing ones.
 * drill:   performs a backup, writes a canary row + canary receipt, restores
 *          the backup, then verifies the canary is gone (DB) and the receipt
 *          set matches the pre-canary state — proving the backup is restorable
 *          end to end. By default the drill cleans up after itself.
 *
 * The default target is the project-local cluster on :5433 (see localdb.js).
 * Override with --db-url or DATABASE_URL. Requires PostgreSQL binaries
 * (pg_dump / pg_restore / psql) and a `tar` on PATH.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BACKUP_DIR = path.join(ROOT, 'backups');
const RECEIPTS_DIR = process.env.RECEIPTS_DIR
  ? path.resolve(process.env.RECEIPTS_DIR)
  : path.join(ROOT, 'receipts');

const PGBIN_CANDIDATES = [
  process.env.PGBIN,
  'C:\\Program Files\\PostgreSQL\\17\\bin',
  'C:\\Program Files\\PostgreSQL\\16\\bin',
  'C:\\Program Files\\PostgreSQL\\15\\bin',
].filter(Boolean);

// ---- CLI -------------------------------------------------------------------
const args = process.argv.slice(2);
function argValue(name, fallback) {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}
const hasFlag = (name) => args.includes(name);
const cmd = args[0] || '';

// ---- Helpers ---------------------------------------------------------------
function onPath(name) {
  // Direct PATH scan — avoids spawning a shell (and Node's DEP0190 warning)
  // just to learn whether a binary is resolvable.
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of ['.exe', '.cmd', '.bat', '']) {
      if (fs.existsSync(path.join(dir, name + ext))) return true;
    }
  }
  return false;
}

function findBinary(name) {
  for (const dir of PGBIN_CANDIDATES) {
    const full = path.join(dir, `${name}.exe`);
    if (fs.existsSync(full)) return full;
  }
  if (onPath(name)) return name;
  console.error(`Could not find ${name}. Install PostgreSQL or set PGBIN.`);
  process.exit(1);
}

function requireTool(name) {
  // Used only for tar, which is always invoked as a bare name on PATH.
  if (!onPath(name)) {
    console.error(`Required tool "${name}" is not on PATH.`);
    process.exit(1);
  }
}

function dbUrl() {
  const explicit = argValue('--db-url', process.env.BACKUP_DATABASE_URL);
  if (explicit) return stripSchemaParam(explicit);
  const base = process.env.DATABASE_URL || 'postgresql://postgres:clidemlambo12334@127.0.0.1:5433/smart_fuel_db';
  return stripSchemaParam(base.replace('@localhost:', '@127.0.0.1:'));
}

// psql/pg_dump don't understand Prisma's "?schema=" parameter.
function stripSchemaParam(url) {
  return url.split('?')[0];
}

function parseDbUrl(url) {
  const m = url.match(/^postgresql:\/\/([^:]+):([^@]+)@([^:/]+):(\d+)\/(.+)$/);
  if (!m) {
    console.error(`Could not parse DATABASE_URL: ${url.replace(/:[^:@/]+@/, ':****@')}`);
    process.exit(1);
  }
  return { user: m[1], password: m[2], host: m[3], port: m[4], database: m[5] };
}

function run(bin, argv, { quiet = false, env = process.env, cwd } = {}) {
  // shell:false on every platform — the binary may be a full path with spaces
  // (C:\\Program Files\\...), which shell:true would butcher.
  // stdin:'ignore' is critical: without it a wrong PGPASSWORD makes pg_dump
  // sit waiting on the interactive password prompt forever.
  const res = spawnSync(bin, argv, { encoding: 'utf8', shell: false, env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.error) {
    console.error(`Failed to spawn ${bin}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`${bin} ${argv.join(' ')} failed (exit ${res.status}):`);
    console.error((res.stderr || res.stdout || '').slice(0, 800));
    process.exit(1);
  }
  if (!quiet && res.stdout) process.stdout.write(res.stdout);
  return res;
}

function receiptsList() {
  if (!fs.existsSync(RECEIPTS_DIR)) return [];
  return fs.readdirSync(RECEIPTS_DIR).filter((f) => f.endsWith('.pdf')).sort();
}

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function die(msg) { console.error(`  ✗ ${msg}`); process.exit(1); }

// ---- backup ----------------------------------------------------------------
function doBackup() {
  requireTool('tar');
  const pgDump = findBinary('pg_dump');
  const url = dbUrl();
  const outDir = argValue('--out', DEFAULT_BACKUP_DIR);
  const keep = Number(argValue('--keep', '14'));
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = path.join(outDir, `.work-${stamp}`);
  const dbDump = path.join(workDir, 'database.dump');
  const receiptsDir = path.join(workDir, 'receipts');
  const finalPath = path.join(outDir, `smart-fuel-backup-${stamp}.tar.gz`);

  log(`Backing up ${url.replace(/:[^:@/]+@/, ':****@')}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const db = parseDbUrl(url);
    run(pgDump, [
      '-Fc', // custom format, compressed, restorable with pg_restore
      '--no-owner', '--no-privileges',
      '-h', db.host, '-p', db.port, '-U', db.user,
      '-f', dbDump, db.database,
    ], { env: { ...process.env, PGPASSWORD: db.password } });
    const dbSize = fs.statSync(dbDump).size;
    ok(`database dump (pg_dump -Fc): ${(dbSize / 1024).toFixed(0)} KiB`);

    const receipts = receiptsList();
    if (receipts.length > 0) {
      fs.mkdirSync(receiptsDir, { recursive: true });
      for (const f of receipts) fs.copyFileSync(path.join(RECEIPTS_DIR, f), path.join(receiptsDir, f));
      ok(`receipts collected: ${receipts.length} PDF(s)`);
    } else {
      ok('receipts: none yet (empty folder in the archive)');
      fs.mkdirSync(receiptsDir, { recursive: true });
    }

    // tar the whole work dir (database.dump + receipts/) into the final archive.
    // Run with cwd=workDir and RELATIVE output paths: the project path contains
    // spaces AND a Windows drive colon, which GNU tar otherwise parses as a
    // remote host/rsh specification ("Cannot execute remote shell").
    // Write the archive OUTSIDE the work dir (its parent) so tar isn't reading
    // the very directory it's writing into ("file changed as we read it").
    // tar creates the archive relative to cwd (the work dir); move it into
    // place afterwards.
    run('tar', ['-czf', 'archive.tar.gz', 'database.dump', 'receipts'], { quiet: true, cwd: workDir });
    fs.renameSync(path.join(workDir, 'archive.tar.gz'), finalPath);
    const finalSize = fs.statSync(finalPath).size;
    ok(`archive: ${path.relative(ROOT, finalPath)} (${(finalSize / 1024).toFixed(0)} KiB)`);

    // Retention: keep the newest N archives.
    const archives = fs.readdirSync(outDir)
      .filter((f) => f.startsWith('smart-fuel-backup-') && f.endsWith('.tar.gz'))
      .sort().reverse();
    for (const stale of archives.slice(keep)) {
      fs.unlinkSync(path.join(outDir, stale));
      log(`  retention: removed ${stale} (keeping ${keep})`);
    }
    log(`Done. ${archives.length} archive(s) in ${path.relative(ROOT, outDir)}`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---- restore ----------------------------------------------------------------
function doRestore() {
  requireTool('tar');
  const pgRestore = findBinary('pg_restore');
  const psql = findBinary('psql');
  const file = argValue('--file');
  if (!file || !fs.existsSync(file)) {
    die(`--file is required (and must exist): ${file || '(missing)'}`);
  }
  if (!hasFlag('--force')) {
    die('Refusing to restore without --force (this DROPS the current database).');
  }

  const url = dbUrl();
  const db = parseDbUrl(url);
  const env = { ...process.env, PGPASSWORD: db.password };
  log(`Restoring ${path.basename(file)} into ${db.database} on ${db.host}:${db.port}`);

  const workDir = path.join(path.dirname(path.resolve(file)), `.restore-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    // Copy the archive inside first, then extract with relative paths — tar
    // mis-parses `C:`-prefixed filenames as remote-host specs.
    const absFile = path.resolve(file);
    const localName = path.basename(absFile);
    fs.copyFileSync(absFile, path.join(workDir, localName));
    run('tar', ['-xzf', localName], { quiet: true, cwd: workDir });
    const dumpFile = path.join(workDir, 'database.dump');
    if (!fs.existsSync(dumpFile)) die('archive does not contain database.dump');

    // Drop + recreate for a clean, deterministic restore.
    run(psql, ['-h', db.host, '-p', db.port, '-U', db.user, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${db.database}";`], { env, quiet: true });
    run(psql, ['-h', db.host, '-p', db.port, '-U', db.user, '-d', 'postgres',
      '-c', `CREATE DATABASE "${db.database}";`], { env, quiet: true });
    ok('database dropped + recreated');

    run(pgRestore, [
      '--no-owner', '--no-privileges',
      '-h', db.host, '-p', db.port, '-U', db.user,
      '-d', db.database, dumpFile,
    ], { env, quiet: true });
    ok('schema + data restored (pg_restore)');

    const restoredReceipts = path.join(workDir, 'receipts');
    if (fs.existsSync(restoredReceipts)) {
      // Snapshot semantics: remove receipts NOT in the archive, then copy the
      // archived ones over. A copy-merge would let post-backup strays survive,
      // which would make the restore drill meaningless.
      const archived = new Set(fs.readdirSync(restoredReceipts));
      let removed = 0;
      for (const f of receiptsList()) {
        if (!archived.has(f)) { fs.unlinkSync(path.join(RECEIPTS_DIR, f)); removed++; }
      }
      for (const f of fs.readdirSync(restoredReceipts)) {
        fs.copyFileSync(path.join(restoredReceipts, f), path.join(RECEIPTS_DIR, f));
      }
      ok(`receipts restored: ${archived.size} archived, ${removed} post-backup stray(s) removed`);
    } else {
      ok('receipts: archive contained none (nothing to restore)');
    }

    // Sanity: row counts on the core tables.
    for (const table of ['"User"', '"FuelRequest"', '"FuelTransaction"', '"WalletTransaction"']) {
      const res = spawnSync(psql, ['-t', '-A',
        '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database,
        '-c', `SELECT COUNT(*) FROM ${table};`],
        { env, encoding: 'utf8', shell: process.platform !== 'win32' });
      const n = (res.stdout || '').trim();
      ok(`${table.replace(/"/g, '')}: ${n} row(s)`);
    }
    log('Restore complete. Restart the backend if it was running.');
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---- drill -------------------------------------------------------------------
// Proves the backup is restorable: snapshot -> canary row + receipt ->
// restore -> canary must be gone and the receipt set must match the snapshot.
function doDrill() {
  const keepHole = hasFlag('--keep-hole');
  requireTool('tar');
  const psql = findBinary('psql');

  log('RESTORE DRILL — proving the backup is actually restorable\n');
  const drillDir = path.join(ROOT, 'backups', 'drill');
  fs.mkdirSync(drillDir, { recursive: true });

  // 1. Take the backup.
  log('1. Taking a backup');
  const beforeReceipts = receiptsList();
  doBackupForDrill(drillDir);
  const archive = fs.readdirSync(drillDir)
    .filter((f) => f.startsWith('smart-fuel-backup-') && f.endsWith('.tar.gz'))
    .sort().pop();
  if (!archive) die('drill backup was not created');
  ok(`archive: ${archive}`);

  // 2. Damage the system: a canary wallet row and a canary receipt.
  log('\n2. Writing canaries (simulating data created after the backup)');
  const url = dbUrl();
  const db = parseDbUrl(url);
  const env = { ...process.env, PGPASSWORD: db.password };
  const canaryWalletId = 'drill-00000000-0000-0000-0000-000000000001';
  const canaryUserId = 'drill-00000000-0000-0000-0000-0000000000c1';
  const canaryReceipt = path.join(RECEIPTS_DIR, 'receipt-drill-canary-00000000-0000-0000-0000-0000000000ef.pdf');

  // The canary is a standalone wallet row (unique user_id forces a synthetic
  // user) so it never collides with seeded data; its presence is what the
  // verification looks for after the restore.
  run(psql, [
    '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database,
    '-c',
    `INSERT INTO "User" ("id", "full_name", "email", "password_hash", "status", "created_at", "updated_at")
     VALUES ('${canaryUserId}', 'Restore Drill Canary', 'drill-canary@example.com', 'x', 'ACTIVE', NOW(), NOW())
     ON CONFLICT ("id") DO NOTHING;
     INSERT INTO "Wallet" ("id", "user_id", "available_balance", "reserved_balance", "currency", "created_at", "updated_at")
     VALUES ('${canaryWalletId}', '${canaryUserId}', 12345.67, 0, 'USD', NOW(), NOW())
     ON CONFLICT ("id") DO NOTHING;`,
  ], { env, quiet: true });
  fs.writeFileSync(canaryReceipt, '%PDF-1.4 drill canary\n');
  ok('canary user + wallet row inserted (balance 12345.67) + canary receipt written');

  // 3. Restore from the pre-canary archive.
  log('\n3. Restoring the pre-canary backup (--force implied by the drill)');
  restoreForDrill(path.join(drillDir, archive));

  // 4. Verify: canaries must be gone; pre-backup receipts must be present.
  log('\n4. Verifying the restored state');
  const walletCount = spawnSync(psql, ['-t', '-A',
    '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database,
    '-c', `SELECT COUNT(*) FROM "Wallet" WHERE "id" = '${canaryWalletId}';`],
    { env, encoding: 'utf8', shell: process.platform !== 'win32' });
  const canaryGone = (walletCount.stdout || '').trim() === '0';
  if (canaryGone) ok('canary wallet row is GONE — restore really replaced the data');
  else die('canary wallet row survived the restore — the backup was NOT restored');

  const seeded = spawnSync(psql, ['-t', '-A',
    '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database,
    '-c', `SELECT COUNT(*) FROM "Wallet" w JOIN "User" u ON u."id" = w."user_id" WHERE u."email" = 'john@example.com';`],
    { env, encoding: 'utf8', shell: process.platform !== 'win32' });
  const seededN = (seeded.stdout || '').trim();
  if (seededN !== '0') ok(`seeded data intact after restore (john's wallet rows: ${seededN})`);
  else die('seeded wallet data is missing after restore — restore lost data');

  const afterReceipts = receiptsList();
  const preMissing = beforeReceipts.filter((f) => !afterReceipts.includes(f));
  if (preMissing.length === 0) ok(`all ${beforeReceipts.length} pre-backup receipt(s) present after restore`);
  else die(`receipts lost in restore: ${preMissing.join(', ')}`);
  const canaryReceiptGone = !fs.existsSync(canaryReceipt);
  if (canaryReceiptGone) ok('canary receipt is GONE — receipt restore is a true snapshot, not a merge');
  else die('canary receipt survived — restore did not run');

  // 5. Cleanup (unless --keep-hole keeps the archive for manual inspection).
  if (keepHole) {
    log('\n--keep-hole: drill archive kept in backups/drill/ for inspection');
  } else {
    log('\n5. Cleanup');
    fs.rmSync(path.join(drillDir, archive), { force: true });
    if (fs.readdirSync(drillDir).length === 0) fs.rmdirSync(drillDir);
    ok('drill archive removed (pass --keep-hole to keep it)');
  }

  log('\nDRILL PASSED — backup → damage → restore → verify round-trip is sound.');
}

// Backup variant that targets the drill directory without retention deletes.
function doBackupForDrill(dir) {
  const pgDump = findBinary('pg_dump');
  const url = dbUrl();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const workDir = path.join(dir, `.work-${stamp}`);
  const dbDump = path.join(workDir, 'database.dump');
  const receiptsDir = path.join(workDir, 'receipts');
  const finalPath = path.join(dir, `smart-fuel-backup-${stamp}.tar.gz`);

  fs.mkdirSync(workDir, { recursive: true });
  const db = parseDbUrl(url);
  run(pgDump, ['-Fc', '--no-owner', '--no-privileges',
    '-h', db.host, '-p', db.port, '-U', db.user, '-f', dbDump, db.database],
    { env: { ...process.env, PGPASSWORD: db.password } });
  const receipts = receiptsList();
  fs.mkdirSync(receiptsDir, { recursive: true });
  for (const f of receipts) fs.copyFileSync(path.join(RECEIPTS_DIR, f), path.join(receiptsDir, f));
  run('tar', ['-czf', 'archive.tar.gz', 'database.dump', 'receipts'], { quiet: true, cwd: workDir });
  fs.renameSync(path.join(workDir, 'archive.tar.gz'), finalPath);
  fs.rmSync(workDir, { recursive: true, force: true });
}

// Restore variant that skips the --force gate (the drill always means it).
function restoreForDrill(file) {
  const pgRestore = findBinary('pg_restore');
  const psql = findBinary('psql');
  const url = dbUrl();
  const db = parseDbUrl(url);
  const env = { ...process.env, PGPASSWORD: db.password };

  const workDir = path.join(path.dirname(path.resolve(file)), `.restore-${Date.now()}`);
  fs.mkdirSync(workDir, { recursive: true });
  try {
    // Copy the archive inside first, then extract with relative paths — tar
    // mis-parses `C:`-prefixed filenames as remote-host specs.
    const absFile = path.resolve(file);
    const localName = path.basename(absFile);
    fs.copyFileSync(absFile, path.join(workDir, localName));
    run('tar', ['-xzf', localName], { quiet: true, cwd: workDir });
    const dumpFile = path.join(workDir, 'database.dump');
    if (!fs.existsSync(dumpFile)) die('drill archive does not contain database.dump');

    run(psql, ['-h', db.host, '-p', db.port, '-U', db.user, '-d', 'postgres',
      '-c', `DROP DATABASE IF EXISTS "${db.database}";`], { env, quiet: true });
    run(psql, ['-h', db.host, '-p', db.port, '-U', db.user, '-d', 'postgres',
      '-c', `CREATE DATABASE "${db.database}";`], { env, quiet: true });
    run(pgRestore, ['--no-owner', '--no-privileges',
      '-h', db.host, '-p', db.port, '-U', db.user, '-d', db.database, dumpFile],
      { env, quiet: true });

    const restoredReceipts = path.join(workDir, 'receipts');
    if (fs.existsSync(restoredReceipts)) {
      // Snapshot semantics: remove receipts that are NOT in the archive, then
      // copy the archived ones over. A plain copy-merge would let stray files
      // survive a "restore" — useless for verifying a backup drill.
      const archived = new Set(fs.readdirSync(restoredReceipts));
      for (const f of receiptsList()) {
        if (!archived.has(f)) fs.unlinkSync(path.join(RECEIPTS_DIR, f));
      }
      for (const f of fs.readdirSync(restoredReceipts)) {
        fs.copyFileSync(path.join(restoredReceipts, f), path.join(RECEIPTS_DIR, f));
      }
    }
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// ---- main --------------------------------------------------------------------
switch (cmd) {
  case 'backup': doBackup(); break;
  case 'restore': doRestore(); break;
  case 'drill': doDrill(); break;
  default:
    console.log('Usage: node scripts/backup.js <backup|restore|drill> [options]\n' +
      '  backup  --out <dir> --keep <n>     default out: backups/, keep 14\n' +
      '  restore --file <archive> --force   DROPS and replaces the database\n' +
      '  drill   [--keep-hole]              full backup→damage→restore→verify round-trip');
    process.exit(cmd === '' ? 0 : 1);
}
