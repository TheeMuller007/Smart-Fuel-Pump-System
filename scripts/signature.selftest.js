/* Signature self-test: verifies the HMAC scheme the ESP32 must reproduce. */
const assert = require('assert');
const crypto = require('crypto');
process.env.DEVICE_SIGNING_SECRET = 'test-secret';

const { signTransaction } = require('../src/services/deviceService');

const txn = {
  transaction_reference: 'FUEL-20261004-000184',
  request_id: 'req-1',
  user_id: 'user-1',
  station_id: 'station-1',
  pump_id: 'pump-1',
  fuel_type_id: 'fuel-1',
  price_per_litre: '1.500',
  authorized_litres: '10.000',
  authorized_amount: '15.00',
  status: 'AUTHORIZED',
  started_at: new Date('2026-10-04T12:00:00Z'),
};

const sig = signTransaction(txn);

// Server-side signing matches an independent HMAC computation over the
// documented field order — this is exactly what the ESP32 must do.
const payload = [
  txn.transaction_reference, txn.request_id, txn.user_id, txn.station_id, txn.pump_id,
  txn.fuel_type_id, txn.price_per_litre, txn.authorized_litres, txn.authorized_amount,
  txn.status, new Date(txn.started_at).toISOString(),
].join('|');
const expected = crypto.createHmac('sha256', 'test-secret').update(payload).digest('hex');
assert.strictEqual(sig, expected, 'signature must match the documented payload');

// Deterministic: same txn -> same signature; any field change -> different sig.
assert.strictEqual(signTransaction(txn), sig, 'signing must be deterministic');
const tampered = signTransaction({ ...txn, authorized_amount: '99.00' });
assert.notStrictEqual(tampered, sig, 'tampered payload must produce a different signature');

console.log('SIGNATURE SELF-TEST: passed ✔');
console.log('payload:', payload);
console.log('signature:', sig.slice(0, 32) + '…');
