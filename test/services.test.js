/* Stage 13 unit tests — services with an in-memory Prisma stub (no DB).
   Run: npm test  (mocha) */
const assert = require('assert');
const path = require('path');

// ---- Prisma stub ----------------------------------------------------------
// Injected before requiring services so `require('../models')` resolves here.
const calls = { user: {}, refreshToken: {}, wallet: {}, walletTransaction: {} };

const prismaStub = {
  $transaction: async (arg) => {
    if (typeof arg === 'function') return arg(prismaStub);
    // array form not used by services
    return Promise.all(arg);
  },
  user: {
    findUnique: async ({ where }) => calls.user.find?.[where.email] || calls.user.find?.[where.id] || null,
    update: async ({ where, data }) => ({ id: where.id, ...calls.user.find?.[where.id], ...data }),
  },
  wallet: {
    findUnique: async ({ where }) => calls.wallet.find?.[where.user_id] || null,
    update: async ({ where, data }) => Object.assign(calls.wallet.row?.[where.id] || {}, data),
  },
  walletTransaction: {
    create: async ({ data }) => (calls.walletTransaction.created ||= []).push(data) && data,
  },
  refreshToken: {
    create: async ({ data }) => {
      const row = { id: 'rt' + (calls.refreshToken.created?.length || 0), ...data };
      (calls.refreshToken.created ||= []).push(row);
      (calls.refreshToken.rows ||= {})[data.token_hash] = row;
      return row;
    },
    findUnique: async ({ where }) => {
      const row = calls.refreshToken.rows?.[where.token_hash];
      if (!row) return null;
      // Emulate `include: { user: true, stationUser: true }`
      if (row.user_id) row.user = calls.user.find?.[row.user_id] || null;
      if (row.station_user_id) row.stationUser = calls.stationUser?.find?.[row.station_user_id] || null;
      return row;
    },
    update: async ({ where, data }) => {
      const row = Object.values(calls.refreshToken.rows || {}).find((r) => r.id === where.id);
      if (row) Object.assign(row, data);
      return row;
    },
    updateMany: async ({ where, data }) => {
      const rows = Object.values(calls.refreshToken.rows || {});
      let count = 0;
      for (const r of rows) {
        if (r.token_hash === where.token_hash && !r.revoked_at) { Object.assign(r, data); count++; }
      }
      return { count };
    },
  },
  stationUser: {
    findUnique: async ({ where }) => calls.stationUser?.find?.[where.username] || null,
    update: async ({ where, data }) => ({ id: where.id, ...calls.stationUser?.find?.[where.id], ...data }),
  },
};

delete require.cache[require.resolve('../src/models')];
require.cache[require.resolve('../src/models')] = {
  id: require.resolve('../src/models'),
  filename: require.resolve('../src/models'),
  loaded: true,
  exports: prismaStub,
  path: path.dirname(require.resolve('../src/models')),
};

const walletService = require('../src/services/walletService');
const authService = require('../src/services/authService');

describe('walletService.ledgerEntryInTx', () => {
  function makeTx(startAvailable = '100.00') {
    const wallet = {
      id: 'w1', status: 'ACTIVE',
      available_balance: startAvailable, reserved_balance: '0.00', currency: 'USD',
    };
    const entries = [];
    return {
      wallet: {
        async findUnique() { return { ...wallet }; },
        async update({ data }) {
          if (data.available_balance !== undefined) wallet.available_balance = data.available_balance;
          if (data.reserved_balance !== undefined) wallet.reserved_balance = data.reserved_balance;
          return { ...wallet };
        },
      },
      walletTransaction: { async create({ data }) { entries.push(data); return data; } },
      _entries: entries,
      _wallet: wallet,
    };
  }

  it('deposit increases available balance and records before/after', async () => {
    const tx = makeTx();
    const r = await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'CASH_DEPOSIT', amount: 50, reference: 'D1' });
    assert.strictEqual(r.wallet.available_balance, '150.00');
    assert.strictEqual(r.entry.balance_before, '100.00');
    assert.strictEqual(r.entry.balance_after, '150.00');
  });

  it('reservation moves available -> reserved', async () => {
    const tx = makeTx();
    await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'RESERVATION', amount: '40.00' });
    assert.strictEqual(tx._wallet.available_balance, '60.00');
    assert.strictEqual(tx._wallet.reserved_balance, '40.00');
  });

  it('reservation beyond available is rejected', async () => {
    const tx = makeTx();
    await assert.rejects(
      () => walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'RESERVATION', amount: '500' }),
      (e) => e.status === 400 && /Insufficient/.test(e.message)
    );
  });

  it('fuel payment draws from reserved pool only', async () => {
    const tx = makeTx();
    await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'RESERVATION', amount: '40.00' });
    const r = await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'FUEL_PAYMENT', amount: '35.50' });
    assert.strictEqual(r.wallet.reserved_balance, '4.50');
    assert.strictEqual(r.wallet.available_balance, '60.00');
  });

  it('release returns reserved funds to available', async () => {
    const tx = makeTx();
    await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'RESERVATION', amount: '40.00' });
    await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'FUEL_PAYMENT', amount: '35.50' });
    const r = await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'RELEASE', amount: '4.50' });
    assert.strictEqual(r.wallet.reserved_balance, '0.00');
    assert.strictEqual(r.wallet.available_balance, '64.50');
  });

  it('release beyond reserved is rejected', async () => {
    const tx = makeTx();
    await assert.rejects(
      () => walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'RELEASE', amount: '999' }),
      (e) => e.status === 400
    );
  });

  it('unknown type and negative amounts are rejected', async () => {
    const tx = makeTx();
    await assert.rejects(() => walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'HACK', amount: 5 }), (e) => e.status === 400);
    await assert.rejects(() => walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'REFUND', amount: -5 }), (e) => e.status === 400);
  });

  it('decimal precision stays exact (0.1 + 0.2 style)', async () => {
    const tx = makeTx();
    await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'CASH_DEPOSIT', amount: '0.1' });
    const r = await walletService.ledgerEntryInTx(tx, { walletId: 'w1', type: 'CASH_DEPOSIT', amount: '0.2' });
    assert.strictEqual(r.wallet.available_balance, '100.30');
  });
});

describe('authService', () => {
  const pass = 'supersecret-password';
  let hash;

  before(async () => {
    hash = await require('bcrypt').hash(pass, 4);
  });

  beforeEach(() => {
    const john = {
      id: 'u1', full_name: 'John', email: 'john@example.com', status: 'ACTIVE', password_hash: hash,
    };
    // Keyed by email (login) and by id (refresh-token include hydration).
    calls.user.find = { 'john@example.com': john, u1: john };
    calls.stationUser = { find: {} };
    calls.refreshToken.rows = {};
    calls.refreshToken.created = [];
  });

  it('login with valid credentials issues access + refresh tokens', async () => {
    const r = await authService.login({ email: 'john@example.com', password: pass });
    assert.strictEqual(r.user.role, 'customer');
    assert.ok(r.accessToken.split('.').length === 3);
    assert.ok(r.refreshToken.length >= 32);
  });

  it('login rejects a wrong password', async () => {
    await assert.rejects(
      () => authService.login({ email: 'john@example.com', password: 'wrong' }),
      (e) => e.status === 401
    );
  });

  it('login rejects a blocked account', async () => {
    calls.user.find['john@example.com'].status = 'BLOCKED';
    await assert.rejects(
      () => authService.login({ email: 'john@example.com', password: pass }),
      (e) => e.status === 403
    );
  });

  it('refresh rotates the token and revokes the old one', async () => {
    // Fresh login inside this test: beforeEach resets the stub between tests.
    const login = await authService.login({ email: 'john@example.com', password: pass });
    const r = await authService.refresh(login.refreshToken);
    assert.ok(r.refreshToken && r.refreshToken !== login.refreshToken);
    // Old token must now be revoked
    await assert.rejects(
      () => authService.refresh(login.refreshToken),
      (e) => e.status === 401
    );
  });

  it('logout revokes the session', async () => {
    const r = await authService.login({ email: 'john@example.com', password: pass });
    await authService.logout(r.refreshToken);
    await assert.rejects(
      () => authService.refresh(r.refreshToken),
      (e) => e.status === 401
    );
  });
});
