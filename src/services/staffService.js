const { Prisma } = require('@prisma/client');
const prisma = require('../models');
const walletService = require('./walletService');
const auditService = require('./auditService');

const MAX_DEPOSIT = new Prisma.Decimal(10000);

class StaffError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Search customers by phone (primary), falling back to name/email. */
async function searchCustomers({ phone, q } = {}) {
  const term = (phone || q || '').trim();
  if (!term) {
    throw new StaffError(400, 'Provide a phone search term, e.g. ?phone=+1555');
  }

  const users = await prisma.user.findMany({
    where: {
      OR: [
        { phone: { contains: term } },
        { full_name: { contains: term } },
        { email: { contains: term } },
      ],
    },
    orderBy: { full_name: 'asc' },
    take: 20,
    include: { wallet: true },
  });

  return users.map((u) => ({
    id: u.id,
    full_name: u.full_name,
    phone: u.phone,
    email: u.email,
    status: u.status,
    wallet: u.wallet
      ? {
          available_balance: u.wallet.available_balance,
          reserved_balance: u.wallet.reserved_balance,
          currency: u.wallet.currency,
        }
      : null,
  }));
}

/**
 * Staff credit a customer's wallet with cash. performed_by and audit_logs
 * both record the acting staff member.
 */
async function cashDeposit(staff, { user_id, amount, description } = {}, ipAddress) {
  if (!user_id) throw new StaffError(400, 'user_id is required');

  const amt = new Prisma.Decimal(amount ?? 0);
  if (amt.lte(0)) throw new StaffError(400, 'amount must be greater than zero');
  if (amt.gt(MAX_DEPOSIT)) {
    throw new StaffError(400, `Single deposits are capped at ${MAX_DEPOSIT.toFixed(2)}`);
  }

  const user = await prisma.user.findUnique({ where: { id: user_id }, include: { wallet: true } });
  if (!user) throw new StaffError(404, 'Customer not found');
  if (!user.wallet) throw new StaffError(404, 'Customer has no wallet');

  const staffLabel = `${staff.name || 'staff'} (${staff.sub})`.slice(0, 100);
  const { wallet, entry } = await walletService.deposit(user.id, amt.toFixed(2), {
    description: description || `Cash deposit by ${staffLabel}`,
    performedBy: staffLabel,
  });

  await auditService.log({
    stationUserId: staff.sub,
    stationId: staff.station_id,
    action: 'CASH_DEPOSIT',
    entityType: 'wallet',
    entityId: wallet.id,
    description: `Credited ${amt.toFixed(2)} ${wallet.currency} to customer ${user.email}; ref ${entry.reference}`,
    ipAddress,
  });

  return {
    customer: {
      id: user.id,
      full_name: user.full_name,
      email: user.email,
      phone: user.phone,
    },
    wallet: {
      id: wallet.id,
      available_balance: wallet.available_balance,
      reserved_balance: wallet.reserved_balance,
      currency: wallet.currency,
    },
    entry: {
      id: entry.id,
      type: entry.type,
      amount: entry.amount,
      reference: entry.reference,
      created_at: entry.created_at,
    },
  };
}

module.exports = { searchCustomers, cashDeposit, StaffError };
