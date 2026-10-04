const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../models');
const walletService = require('./walletService');

const RESERVATION_TTL_MINUTES = 15;

class FuelError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const D = (v) => new Prisma.Decimal(v);

function newReference(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Create a fuel request and atomically reserve the requested amount from the
 * customer's wallet. Price per litre is snapshotted from the fuel type at
 * creation time so later price changes never affect open requests.
 */
async function createFuelRequest(user, { station_id, fuel_type_id, pump_id, requested_litres }) {
  if (!station_id || !fuel_type_id) {
    throw new FuelError(400, 'station_id and fuel_type_id are required');
  }

  return prisma.$transaction(async (tx) => {
    const fuelType = await tx.fuelType.findUnique({ where: { id: fuel_type_id } });
    if (!fuelType || fuelType.status !== 'ACTIVE') {
      throw new FuelError(400, 'Fuel type not found or inactive');
    }

    const station = await tx.station.findUnique({ where: { id: station_id } });
    if (!station || station.status !== 'ACTIVE') {
      throw new FuelError(400, 'Station not found or inactive');
    }

    if (pump_id) {
      const pump = await tx.pump.findUnique({ where: { id: pump_id } });
      if (!pump || pump.station_id !== station_id) {
        throw new FuelError(400, 'Pump does not belong to this station');
      }
      if (pump.fuel_type_id !== fuel_type_id) {
        throw new FuelError(400, 'Pump dispenses a different fuel type');
      }
      if (pump.status !== 'AVAILABLE') {
        throw new FuelError(400, 'Pump is not available');
      }
    }

    const litres = D(requested_litres);
    if (litres.lte(0)) {
      throw new FuelError(400, 'requested_litres must be greater than zero');
    }

    const price = D(fuelType.price_per_litre); // price snapshot
    const requestedAmount = price.mul(litres).toFixed(2);

    const wallet = await tx.wallet.findUnique({ where: { user_id: user.id } });
    if (!wallet) throw new FuelError(404, 'Wallet not found');

    const request = await tx.fuelRequest.create({
      data: {
        request_reference: newReference('REQ'),
        user_id: user.id,
        station_id,
        fuel_type_id,
        pump_id: pump_id || null,
        requested_litres: litres.toFixed(3),
        requested_amount: requestedAmount,
        price_per_litre: price.toFixed(3),
        status: 'RESERVED',
        expires_at: new Date(Date.now() + RESERVATION_TTL_MINUTES * 60 * 1000),
      },
    });

    await walletService.ledgerEntryInTx(tx, {
      walletId: wallet.id,
      type: 'RESERVATION',
      amount: requestedAmount,
      reference: `RSV-${request.request_reference}`,
      description: `Fuel reservation ${request.request_reference}`,
      stationId: station_id,
      userId: user.id,
    });

    return request;
  });
}

/**
 * Release funds for RESERVED requests whose TTL has lapsed.
 * Each request is claimed atomically (status flip under a status guard) so the
 * background job and lazy expiry paths can never double-release funds.
 */
async function expireStaleRequests(tx, stationId) {
  const stale = await tx.fuelRequest.findMany({
    where: {
      status: 'RESERVED',
      expires_at: { lt: new Date() },
      ...(stationId ? { station_id: stationId } : {}),
    },
  });

  let released = 0;
  for (const request of stale) {
    const claimed = await tx.fuelRequest.updateMany({
      where: { id: request.id, status: 'RESERVED' },
      data: { status: 'EXPIRED' },
    });
    if (claimed.count !== 1) continue; // another path already handled it

    const wallet = await tx.wallet.findUnique({ where: { user_id: request.user_id } });
    if (wallet) {
      await walletService.ledgerEntryInTx(tx, {
        walletId: wallet.id,
        type: 'RELEASE',
        amount: request.requested_amount,
        reference: `REL-${request.request_reference}`,
        description: `Expired reservation ${request.request_reference}`,
        stationId: request.station_id,
        userId: request.user_id,
      });
    }
    released += 1;
  }
  return released;
}

async function getUserRequests(userId) {
  return prisma.fuelRequest.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: 50,
    include: { fuel_type: true, station: true, pump: true },
  });
}

/** Requests waiting on staff: freshly reserved plus those already accepted. */
async function getPendingRequests(stationId) {
  return prisma.$transaction(async (tx) => {
    await expireStaleRequests(tx, stationId);
    return tx.fuelRequest.findMany({
      where: { station_id: stationId, status: { in: ['RESERVED', 'ACCEPTED'] } },
      orderBy: { created_at: 'asc' },
      include: {
        user: { select: { id: true, full_name: true, phone: true, email: true } },
        fuel_type: true,
        pump: true,
      },
    });
  });
}

/**
 * Cancel a RESERVED request and release the reserved funds.
 * Customers may cancel their own requests; staff cancel within their station.
 */
async function cancelRequest(requestId, actor) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.fuelRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new FuelError(404, 'Fuel request not found');

    if (actor.type === 'customer' && request.user_id !== actor.sub) {
      throw new FuelError(403, 'This request belongs to another customer');
    }
    if (actor.type === 'staff' && request.station_id !== actor.station_id) {
      throw new FuelError(403, 'Request belongs to another station');
    }
    if (request.status !== 'RESERVED') {
      throw new FuelError(400, `Cannot cancel a request in status ${request.status}`);
    }

    const wallet = await tx.wallet.findUnique({ where: { user_id: request.user_id } });
    if (!wallet) throw new FuelError(404, 'Wallet not found');

    await walletService.ledgerEntryInTx(tx, {
      walletId: wallet.id,
      type: 'RELEASE',
      amount: request.requested_amount,
      reference: `REL-${request.request_reference}`,
      description: `Cancelled request ${request.request_reference}`,
      stationId: request.station_id,
      userId: request.user_id,
    });

    return tx.fuelRequest.update({
      where: { id: request.id },
      data: { status: 'CANCELLED' },
    });
  });
}

/**
 * Stage 7: staff accept a pending request. The reservation is kept (funds
 * stay in reserved_balance) and expiry is disabled while staff work on it.
 */
async function acceptRequest(requestId, staff) {
  return prisma.$transaction(async (tx) => {
    await expireStaleRequests(tx, staff.station_id);

    const request = await tx.fuelRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new FuelError(404, 'Fuel request not found');
    if (request.station_id !== staff.station_id) {
      throw new FuelError(403, 'Request belongs to another station');
    }
    if (request.status !== 'RESERVED') {
      throw new FuelError(400, `Only RESERVED requests can be accepted (current: ${request.status})`);
    }

    return tx.fuelRequest.update({
      where: { id: requestId },
      data: { status: 'ACCEPTED', expires_at: null },
    });
  });
}

/**
 * Stage 7: staff reject a pending request. The reservation is released back
 * to available_balance and the request is marked REJECTED.
 */
async function rejectRequest(requestId, staff) {
  return prisma.$transaction(async (tx) => {
    await expireStaleRequests(tx, staff.station_id);

    const request = await tx.fuelRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new FuelError(404, 'Fuel request not found');
    if (request.station_id !== staff.station_id) {
      throw new FuelError(403, 'Request belongs to another station');
    }
    if (!['RESERVED', 'ACCEPTED'].includes(request.status)) {
      throw new FuelError(400, `Only pending requests can be rejected (current: ${request.status})`);
    }

    const wallet = await tx.wallet.findUnique({ where: { user_id: request.user_id } });
    if (!wallet) throw new FuelError(404, 'Wallet not found');

    await walletService.ledgerEntryInTx(tx, {
      walletId: wallet.id,
      type: 'RELEASE',
      amount: request.requested_amount,
      reference: `REL-${request.request_reference}`,
      description: `Rejected request ${request.request_reference}`,
      stationId: request.station_id,
      userId: request.user_id,
    });

    return tx.fuelRequest.update({
      where: { id: requestId },
      data: { status: 'REJECTED' },
    });
  });
}

/** Staff authorize an accepted/reserved request at their station: creates the FuelTransaction. */
async function authorizeRequest(requestId, staff, pump_id) {
  return prisma.$transaction(async (tx) => {
    await expireStaleRequests(tx, staff.station_id);

    const request = await tx.fuelRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new FuelError(404, 'Fuel request not found');
    if (request.station_id !== staff.station_id) {
      throw new FuelError(403, 'Request belongs to another station');
    }
    if (!['RESERVED', 'ACCEPTED'].includes(request.status)) {
      throw new FuelError(400, `Cannot authorize a request in status ${request.status}`);
    }

    let pumpId = request.pump_id;
    if (pump_id && pump_id !== request.pump_id) {
      const pump = await tx.pump.findUnique({ where: { id: pump_id } });
      if (!pump || pump.station_id !== staff.station_id) {
        throw new FuelError(400, 'Pump not found at your station');
      }
      if (pump.fuel_type_id !== request.fuel_type_id) {
        throw new FuelError(400, 'Pump dispenses a different fuel type');
      }
      pumpId = pump_id;
    }
    if (!pumpId) throw new FuelError(400, 'A pump must be assigned to authorize dispensing');

    const transaction = await tx.fuelTransaction.create({
      data: {
        transaction_reference: newReference('FTX'),
        request_id: request.id,
        user_id: request.user_id,
        station_id: request.station_id,
        pump_id: pumpId,
        fuel_type_id: request.fuel_type_id,
        price_per_litre: request.price_per_litre,
        authorized_litres: request.requested_litres,
        authorized_amount: request.requested_amount,
        status: 'AUTHORIZED',
        started_at: new Date(),
      },
    });

    const updatedRequest = await tx.fuelRequest.update({
      where: { id: request.id },
      data: { status: 'AUTHORIZED', pump_id: pumpId },
    });
    await tx.pump.update({ where: { id: pumpId }, data: { status: 'BUSY' } });

    return { request: updatedRequest, transaction };
  });
}

/**
 * Complete a dispense: charge the wallet from reserved funds for the actual
 * litres dispensed and release the unused remainder.
 */
async function completeDispense(transactionId, { actual_litres }, staff) {
  return prisma.$transaction(async (tx) => {
    const txn = await tx.fuelTransaction.findUnique({
      where: { id: transactionId },
      include: { request: true },
    });
    if (!txn) throw new FuelError(404, 'Fuel transaction not found');
    if (txn.station_id !== staff.station_id) {
      throw new FuelError(403, 'Transaction belongs to another station');
    }
    if (txn.status !== 'AUTHORIZED') {
      throw new FuelError(400, `Cannot complete a transaction in status ${txn.status}`);
    }

    const actual = D(actual_litres);
    if (actual.lte(0)) {
      throw new FuelError(400, 'actual_litres must be greater than zero');
    }
    if (actual.gt(txn.authorized_litres)) {
      throw new FuelError(400, `Cannot dispense more than authorized (${txn.authorized_litres} L)`);
    }

    const price = D(txn.price_per_litre);
    const finalAmount = price.mul(actual).toFixed(2);
    const refundAmount = D(txn.authorized_amount).minus(finalAmount).toFixed(2);

    const wallet = await tx.wallet.findUnique({ where: { user_id: txn.user_id } });
    if (!wallet) throw new FuelError(404, 'Wallet not found');

    if (D(finalAmount).gt(0)) {
      await walletService.ledgerEntryInTx(tx, {
        walletId: wallet.id,
        type: 'FUEL_PAYMENT',
        amount: finalAmount,
        reference: `PAY-${txn.transaction_reference}`,
        description: `Fuel dispensed ${actual.toFixed(3)} L (${txn.transaction_reference})`,
        stationId: txn.station_id,
        userId: txn.user_id,
      });
    }
    if (D(refundAmount).gt(0)) {
      await walletService.ledgerEntryInTx(tx, {
        walletId: wallet.id,
        type: 'RELEASE',
        amount: refundAmount,
        reference: `REL-${txn.transaction_reference}`,
        description: `Unused reserve released (${txn.transaction_reference})`,
        stationId: txn.station_id,
        userId: txn.user_id,
      });
    }

    const completed = await tx.fuelTransaction.update({
      where: { id: txn.id },
      data: {
        actual_litres: actual.toFixed(3),
        final_amount: finalAmount,
        refund_amount: refundAmount,
        status: 'COMPLETED',
        completed_at: new Date(),
      },
    });

    await tx.fuelRequest.update({ where: { id: txn.request_id }, data: { status: 'COMPLETED' } });
    await tx.pump.update({ where: { id: txn.pump_id }, data: { status: 'AVAILABLE' } });

    return completed;
  });
}

async function getStationTransactions(stationId) {
  return prisma.fuelTransaction.findMany({
    where: { station_id: stationId },
    orderBy: { created_at: 'desc' },
    take: 50,
    include: {
      user: { select: { id: true, full_name: true, phone: true, email: true } },
      fuel_type: true,
      pump: true,
    },
  });
}

module.exports = {
  RESERVATION_TTL_MINUTES,
  FuelError,
  createFuelRequest,
  getUserRequests,
  getPendingRequests,
  expireStaleRequests,
  cancelRequest,
  acceptRequest,
  rejectRequest,
  authorizeRequest,
  completeDispense,
  getStationTransactions,
};
