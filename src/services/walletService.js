const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../models');

const LEDGER_TYPES = Object.freeze([
  'CASH_DEPOSIT',
  'RESERVATION',
  'RELEASE',
  'FUEL_PAYMENT',
  'REFUND',
]);

class LedgerError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const D = (v) => new Prisma.Decimal(v);

function newReference(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

async function getWalletByUserId(userId) {
  return prisma.wallet.findUnique({ where: { user_id: userId } });
}

/**
 * Core ledger entry. Every wallet balance change MUST go through here so that
 * each change is recorded as a wallet_transactions row with before/after balances.
 *
 * balance_before/balance_after snapshot the balance pool the operation touches:
 * available_balance for CASH_DEPOSIT/REFUND, reserved_balance for
 * RESERVATION/RELEASE/FUEL_PAYMENT.
 *
 * Can run standalone (opens its own transaction) or inside an existing
 * interactive transaction via ledgerEntryInTx.
 */
async function ledgerEntryInTx(tx, data) {
  const {
    walletId,
    type,
    amount,
    reference,
    description,
    performedBy,
    stationId,
    userId,
  } = data;

  if (!LEDGER_TYPES.includes(type)) {
    throw new LedgerError(400, `Unknown ledger type: ${type}`);
  }
  if (amount === undefined || amount === null || amount === '') {
    throw new LedgerError(400, 'amount is required');
  }
  const amt = D(amount);
  if (amt.lte(0)) {
    throw new LedgerError(400, 'amount must be greater than zero');
  }

  const wallet = await tx.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) {
    throw new LedgerError(404, 'Wallet not found');
  }
  if (wallet.status !== 'ACTIVE') {
    throw new LedgerError(403, 'Wallet is not active');
  }

  let available = D(wallet.available_balance);
  let reserved = D(wallet.reserved_balance);
  const before = type === 'CASH_DEPOSIT' || type === 'REFUND' ? available : reserved;

  switch (type) {
    case 'CASH_DEPOSIT':
    case 'REFUND':
      available = available.plus(amt);
      break;
    case 'RESERVATION':
      if (available.lt(amt)) {
        throw new LedgerError(400, 'Insufficient available balance');
      }
      available = available.minus(amt);
      reserved = reserved.plus(amt);
      break;
    case 'RELEASE':
      if (reserved.lt(amt)) {
        throw new LedgerError(400, 'Reserved balance is insufficient to release');
      }
      reserved = reserved.minus(amt);
      available = available.plus(amt);
      break;
    case 'FUEL_PAYMENT':
      if (reserved.lt(amt)) {
        throw new LedgerError(400, 'Reserved balance is insufficient for payment');
      }
      reserved = reserved.minus(amt);
      break;
    default:
      throw new LedgerError(400, `Unhandled ledger type: ${type}`);
  }

  const updatedWallet = await tx.wallet.update({
    where: { id: walletId },
    data: {
      available_balance: available.toFixed(2),
      reserved_balance: reserved.toFixed(2),
    },
  });

  const entry = await tx.walletTransaction.create({
    data: {
      wallet_id: walletId,
      type,
      amount: amt.toFixed(2),
      balance_before: before.toFixed(2),
      balance_after: (type === 'CASH_DEPOSIT' || type === 'REFUND' ? available : reserved).toFixed(2),
      reference: reference || newReference(type.slice(0, 4)),
      performed_by: performedBy ?? null,
      description: description ?? null,
      station_id: stationId ?? null,
      user_id: userId ?? null,
    },
  });

  return { wallet: updatedWallet, entry };
}

async function applyLedgerEntry(data) {
  return prisma.$transaction((tx) => ledgerEntryInTx(tx, data));
}

async function deposit(userId, amount, opts = {}) {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) throw new LedgerError(404, 'Wallet not found');
  const { wallet: updated, entry } = await applyLedgerEntry({
    walletId: wallet.id,
    type: 'CASH_DEPOSIT',
    amount,
    reference: opts.reference,
    description: opts.description || 'Cash deposit',
    userId,
  });
  return { wallet: updated, entry };
}

async function reserve(userId, amount, opts = {}) {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) throw new LedgerError(404, 'Wallet not found');
  return applyLedgerEntry({
    walletId: wallet.id,
    type: 'RESERVATION',
    amount,
    reference: opts.reference,
    description: opts.description || 'Fuel reservation',
    stationId: opts.stationId,
    userId,
  });
}

async function release(userId, amount, opts = {}) {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) throw new LedgerError(404, 'Wallet not found');
  return applyLedgerEntry({
    walletId: wallet.id,
    type: 'RELEASE',
    amount,
    reference: opts.reference,
    description: opts.description || 'Release reserved funds',
    stationId: opts.stationId,
    userId,
  });
}

async function payFromReserved(userId, amount, opts = {}) {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) throw new LedgerError(404, 'Wallet not found');
  return applyLedgerEntry({
    walletId: wallet.id,
    type: 'FUEL_PAYMENT',
    amount,
    reference: opts.reference,
    description: opts.description || 'Fuel payment',
    stationId: opts.stationId,
    userId,
  });
}

async function refund(userId, amount, opts = {}) {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) throw new LedgerError(404, 'Wallet not found');
  return applyLedgerEntry({
    walletId: wallet.id,
    type: 'REFUND',
    amount,
    reference: opts.reference,
    description: opts.description || 'Refund',
    stationId: opts.stationId,
    userId,
  });
}

async function getTransactions(userId, { page = 1, limit = 20 } = {}) {
  const wallet = await getWalletByUserId(userId);
  if (!wallet) throw new LedgerError(404, 'Wallet not found');

  const safePage = Math.max(1, parseInt(page, 10) || 1);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
  const skip = (safePage - 1) * safeLimit;
  const where = { wallet_id: wallet.id };

  const [items, total] = await prisma.$transaction([
    prisma.walletTransaction.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip,
      take: safeLimit,
    }),
    prisma.walletTransaction.count({ where }),
  ]);

  return {
    page: safePage,
    limit: safeLimit,
    total,
    total_pages: Math.max(1, Math.ceil(total / safeLimit)),
    items,
  };
}

module.exports = {
  LEDGER_TYPES,
  LedgerError,
  getWalletByUserId,
  getTransactions,
  applyLedgerEntry,
  ledgerEntryInTx,
  deposit,
  reserve,
  release,
  payFromReserved,
  refund,
};
