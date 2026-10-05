/* Ledger engine self-test: runs walletService.ledgerEntryInTx against an
   in-memory stub, verifying every balance transition and error path. */
const assert = require('assert');
const walletService = require('../src/services/walletService');

function makeStubWallet() {
  return {
    id: 'w1',
    status: 'ACTIVE',
    available_balance: '100.00',
    reserved_balance: '0.00',
    currency: 'USD',
  };
}

function makeStubTx() {
  const wallet = makeStubWallet();
  const entries = [];
  return {
    wallet,
    entries,
    async walletFindUnique() {
      return { ...wallet };
    },
    async walletUpdate({ data }) {
      wallet.available_balance = data.available_balance;
      wallet.reserved_balance = data.reserved_balance;
      return { ...wallet };
    },
    async walletTransactionCreate({ data }) {
      entries.push(data);
      return data;
    },
  };
}

function fakeTx(stub) {
  return {
    // Emulate the FOR UPDATE row lock the real ledger takes on the wallet row.
    async $queryRaw() { return [{ id: 'w1' }]; },
    wallet: {
      findUnique: stub.walletFindUnique.bind(stub),
      update: stub.walletUpdate.bind(stub),
    },
    walletTransaction: { create: stub.walletTransactionCreate.bind(stub) },
  };
}

async function run() {
  // 1. Deposit
  let stub = makeStubTx();
  let r = await walletService.ledgerEntryInTx(fakeTx(stub), {
    walletId: 'w1', type: 'CASH_DEPOSIT', amount: 50, reference: 'D1',
  });
  assert.strictEqual(r.wallet.available_balance, '150.00');
  assert.strictEqual(r.wallet.reserved_balance, '0.00');
  assert.strictEqual(r.entry.balance_before, '100.00');
  assert.strictEqual(r.entry.balance_after, '150.00');

  // 2. Reserve
  r = await walletService.ledgerEntryInTx(fakeTx(stub), {
    walletId: 'w1', type: 'RESERVATION', amount: '40.00', reference: 'R1',
  });
  assert.strictEqual(r.wallet.available_balance, '110.00');
  assert.strictEqual(r.wallet.reserved_balance, '40.00');
  assert.strictEqual(r.entry.balance_before, '0.00'); // reserved pool
  assert.strictEqual(r.entry.balance_after, '40.00');

  // 3. Reserve more than available -> rejected
  await assert.rejects(
    () => walletService.ledgerEntryInTx(fakeTx(stub), {
      walletId: 'w1', type: 'RESERVATION', amount: '500',
    }),
    (e) => e.status === 400 && /Insufficient/.test(e.message)
  );

  // 4. Fuel payment from reserve
  r = await walletService.ledgerEntryInTx(fakeTx(stub), {
    walletId: 'w1', type: 'FUEL_PAYMENT', amount: '35.50', reference: 'P1',
  });
  assert.strictEqual(r.wallet.reserved_balance, '4.50');
  assert.strictEqual(r.wallet.available_balance, '110.00');

  // 5. Release remainder
  r = await walletService.ledgerEntryInTx(fakeTx(stub), {
    walletId: 'w1', type: 'RELEASE', amount: '4.50', reference: 'REL1',
  });
  assert.strictEqual(r.wallet.reserved_balance, '0.00');
  assert.strictEqual(r.wallet.available_balance, '114.50');

  // 6. Refund
  r = await walletService.ledgerEntryInTx(fakeTx(stub), {
    walletId: 'w1', type: 'REFUND', amount: '10',
  });
  assert.strictEqual(r.wallet.available_balance, '124.50');

  // 7. Release more than reserved -> rejected
  await assert.rejects(
    () => walletService.ledgerEntryInTx(fakeTx(stub), {
      walletId: 'w1', type: 'RELEASE', amount: '999',
    }),
    (e) => e.status === 400
  );

  // 8. Bad type / bad amount rejected
  await assert.rejects(
    () => walletService.ledgerEntryInTx(fakeTx(stub), { walletId: 'w1', type: 'HACK', amount: 5 }),
    (e) => e.status === 400
  );
  await assert.rejects(
    () => walletService.ledgerEntryInTx(fakeTx(stub), { walletId: 'w1', type: 'REFUND', amount: -5 }),
    (e) => e.status === 400
  );

  // 9. Decimal precision: 0.1 + 0.2 style cases stay exact
  stub = makeStubTx();
  await walletService.ledgerEntryInTx(fakeTx(stub), { walletId: 'w1', type: 'CASH_DEPOSIT', amount: '0.1' });
  r = await walletService.ledgerEntryInTx(fakeTx(stub), { walletId: 'w1', type: 'CASH_DEPOSIT', amount: '0.2' });
  assert.strictEqual(r.wallet.available_balance, '100.30');

  console.log('LEDGER SELF-TEST: all 9 scenarios passed ✔');
}

run().catch((e) => {
  console.error('LEDGER SELF-TEST FAILED:', e.message);
  process.exit(1);
});
