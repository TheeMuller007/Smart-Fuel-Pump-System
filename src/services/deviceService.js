const crypto = require('crypto');
const prisma = require('../models');
const bus = require('../events/eventBus');

class DeviceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function apiKey() {
  return process.env.ESP32_API_KEY || '';
}

function signingSecret() {
  return process.env.DEVICE_SIGNING_SECRET || apiKey();
}

/**
 * Constant-time API key check for pump controllers.
 * The key must be configured via ESP32_API_KEY; when unset the endpoint is
 * disabled entirely (fail closed) with a 503.
 */
function assertDeviceAccess(req) {
  if (!apiKey()) {
    throw new DeviceError(503, 'Pump controller API is not configured (set ESP32_API_KEY)');
  }
  const provided = req.headers['x-api-key'] || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(apiKey());
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new DeviceError(401, 'Invalid device API key');
  }
}

/** Canonical string of the transaction fields that get signed. */
function payloadString(txn) {
  return [
    txn.transaction_reference,
    txn.request_id,
    txn.user_id,
    txn.station_id,
    txn.pump_id,
    txn.fuel_type_id,
    txn.price_per_litre,
    txn.authorized_litres,
    txn.authorized_amount,
    txn.status,
    txn.started_at ? new Date(txn.started_at).toISOString() : '',
  ].join('|');
}

function signTransaction(txn) {
  return crypto.createHmac('sha256', signingSecret()).update(payloadString(txn)).digest('hex');
}

/**
 * Latest reported device status per pump (in-memory; transient telemetry,
 * not persisted). Shape: { current_litres, pump_state, error, updated_at }.
 */
const lastStatus = new Map();

function getLastStatus(pumpId) {
  return lastStatus.get(pumpId) || null;
}

/**
 * ESP32 periodic status report: { current_litres, pump_state, error? }.
 * Broadcast to station dashboards over SSE (stage 10).
 */
async function updateStatus(pumpId, { current_litres, pump_state, error } = {}) {
  const pump = await prisma.pump.findUnique({ where: { id: pumpId } });
  if (!pump) throw new DeviceError(404, 'Pump not found');

  const current = current_litres === undefined || current_litres === null ? null : Number(current_litres);
  if (current !== null && !Number.isFinite(current)) {
    throw new DeviceError(400, 'current_litres must be a number');
  }
  const state = pump_state ? String(pump_state).toUpperCase().slice(0, 20) : null;

  const status = {
    pump_id: pumpId,
    pump_number: pump.pump_number,
    station_id: pump.station_id,
    current_litres: current,
    pump_state: state,
    error: error ? String(error).slice(0, 300) : null,
    updated_at: new Date().toISOString(),
  };
  lastStatus.set(pumpId, status);

  // Customers watching their own dispense via /api/stream/me also get the
  // telemetry when their transaction is the active one on this pump.
  const targets = [{ type: 'pump', id: pumpId }, { type: 'station', id: pump.station_id }];
  const active = await prisma.fuelTransaction.findFirst({
    where: { pump_id: pumpId, status: 'AUTHORIZED' },
    select: { user_id: true },
  });
  if (active) targets.push({ type: 'user', id: active.user_id });

  bus.publish('pump_status', status, targets);
  return { status: 'ok' };
}

/**
 * The signed authorization for one pump: the latest AUTHORIZED transaction
 * that has not been dispensed yet. Stations can be pinned to the device via
 * DEVICE_STATION_ID for multi-controller setups.
 */
async function getAuthorizationForPump(pumpId) {
  const pump = await prisma.pump.findUnique({
    where: { id: pumpId },
    include: { fuel_type: { select: { id: true, name: true } } },
  });
  if (!pump) throw new DeviceError(404, 'Pump not found');

  const pinnedStation = process.env.DEVICE_STATION_ID || '';
  if (pinnedStation && pump.station_id !== pinnedStation) {
    throw new DeviceError(403, 'Pump belongs to a different station');
  }

  const txn = await prisma.fuelTransaction.findFirst({
    where: { pump_id: pumpId, status: 'AUTHORIZED' },
    orderBy: { created_at: 'desc' },
  });

  if (!txn) {
    return { pump: { id: pump.id, pump_number: pump.pump_number, status: pump.status }, authorization: null };
  }

  return {
    pump: { id: pump.id, pump_number: pump.pump_number, status: pump.status },
    authorization: {
      transaction_id: txn.id,
      transaction_reference: txn.transaction_reference,
      authorized_litres: txn.authorized_litres,
      authorized_amount: txn.authorized_amount,
      price_per_litre: txn.price_per_litre,
      fuel_type: pump.fuel_type.name,
      status: txn.status,
      started_at: txn.started_at,
      signature: signTransaction(txn),
      signature_alg: 'HMAC-SHA256',
      signature_payload_fields: [
        'transaction_reference', 'request_id', 'user_id', 'station_id', 'pump_id',
        'fuel_type_id', 'price_per_litre', 'authorized_litres', 'authorized_amount',
        'status', 'started_at',
      ],
    },
  };
}

/** ESP32 acknowledges a dispense result; validates its signature claim first. */
async function ackDispense(pumpId, { transaction_id, actual_litres, device_signature } = {}) {
  if (!transaction_id) throw new DeviceError(400, 'transaction_id is required');
  const actual = Number(actual_litres);
  if (!Number.isFinite(actual) || actual <= 0) {
    throw new DeviceError(400, 'actual_litres must be a positive number');
  }

  const txn = await prisma.fuelTransaction.findUnique({ where: { id: transaction_id } });
  if (!txn) throw new DeviceError(404, 'Fuel transaction not found');
  if (txn.pump_id !== pumpId) throw new DeviceError(403, 'Transaction is for a different pump');

  if (txn.status === 'COMPLETED') {
    return { status: 'already_completed', transaction_reference: txn.transaction_reference };
  }
  if (txn.status !== 'AUTHORIZED') {
    throw new DeviceError(400, `Transaction is ${txn.status}, cannot be completed`);
  }

  if (device_signature && device_signature !== signTransaction(txn)) {
    throw new DeviceError(400, 'device_signature does not match the server signature');
  }

  const staffContext = {
    sub: 'esp32-controller',
    station_id: txn.station_id,
    type: 'device',
    name: 'ESP32 pump controller',
  };
  const fuelService = require('./fuelService');
  // completeDispense broadcasts dispense_completed/receipt_ready and triggers
  // PDF generation for every completion path (device ack and staff alike).
  const completed = await fuelService.completeDispense(txn.id, { actual_litres: actual }, staffContext);

  return {
    status: 'completed',
    transaction_reference: completed.transaction_reference,
    actual_litres: completed.actual_litres,
    final_amount: completed.final_amount,
    refund_amount: completed.refund_amount,
    receipt_url: completed.receipt_url || null,
  };
}

module.exports = {
  assertDeviceAccess,
  getAuthorizationForPump,
  updateStatus,
  getLastStatus,
  ackDispense,
  signTransaction,
  DeviceError,
};
