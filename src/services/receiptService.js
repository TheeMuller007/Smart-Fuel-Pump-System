const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const prisma = require('../models');

class ReceiptError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const RECEIPTS_DIR = process.env.RECEIPTS_DIR
  ? path.resolve(process.env.RECEIPTS_DIR)
  : path.join(__dirname, '..', '..', 'receipts');

const DOWNLOAD_TOKEN_SECRET =
  process.env.RECEIPT_TOKEN_SECRET || process.env.JWT_SECRET || 'receipt-token-secret';

/** HMAC token binding the transaction id; cannot be forged or enumerated. */
function downloadToken(transactionId) {
  return crypto
    .createHmac('sha256', DOWNLOAD_TOKEN_SECRET)
    .update(`receipt:${transactionId}`)
    .digest('hex')
    .slice(0, 32);
}

function receiptPath(transactionId) {
  return path.join(RECEIPTS_DIR, `receipt-${transactionId}.pdf`);
}

function receiptUrl(transactionId) {
  return `/api/transactions/${transactionId}/receipt?token=${downloadToken(transactionId)}`;
}

/**
 * Generate (or reuse) the PDF receipt for a COMPLETED fuel transaction.
 * Idempotent: returns the existing file when already generated.
 */
async function generateReceipt(transactionId) {
  const txn = await prisma.fuelTransaction.findUnique({
    where: { id: transactionId },
    include: {
      user: { select: { full_name: true } },
      station: { select: { name: true, location: true } },
      pump: { select: { pump_number: true } },
      fuel_type: { select: { name: true, currency: true } },
      request: { select: { request_reference: true } },
    },
  });
  if (!txn) throw new ReceiptError(404, 'Fuel transaction not found');
  if (txn.status !== 'COMPLETED') {
    throw new ReceiptError(400, 'Receipts are only issued for COMPLETED transactions');
  }

  await fs.promises.mkdir(RECEIPTS_DIR, { recursive: true });
  const filePath = receiptPath(transactionId);

  if (fs.existsSync(filePath)) {
    if (!txn.receipt_url) {
      await prisma.fuelTransaction.update({
        where: { id: transactionId },
        data: { receipt_url: receiptUrl(transactionId) },
      });
    }
    return { receipt_url: receiptUrl(transactionId), file_path: filePath, generated: false };
  }

  const currency = txn.fuel_type.currency || 'USD';
  const n = (v, d = 2) => Number(v ?? 0).toFixed(d);

  const doc = new PDFDocument({
    size: 'A4',
    margin: 56,
    info: { Title: `Receipt ${txn.transaction_reference}` },
  });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Header
  doc.fontSize(22).text('Fuel Receipt');
  doc.moveDown(0.2);
  doc.fontSize(10).fillColor('#555').text(`Reference ${txn.transaction_reference}`);
  doc.fillColor('#000');
  doc.moveTo(56, doc.y + 6).lineTo(539, doc.y + 6).strokeColor('#cccccc').stroke();
  doc.moveDown(1);

  // Station block
  doc.fontSize(13).text(txn.station.name);
  doc.fontSize(10).fillColor('#555').text(txn.station.location);
  doc.fillColor('#000');
  doc.moveDown(1);

  const line = (label, value, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
    doc.text(label, 56, y);
    doc.text(value, 340, y, { width: 199, align: 'right' });
    doc.text('', 56, y + 16);
  };

  line('Customer', txn.user.full_name);
  line('Date', new Date(txn.completed_at || txn.created_at).toLocaleString());
  line('Pump', `#${txn.pump.pump_number}`);
  line('Fuel type', txn.fuel_type.name);
  line('Request reference', txn.request.request_reference);
  doc.moveDown(0.6);
  doc.moveTo(56, doc.y + 2).lineTo(539, doc.y + 2).strokeColor('#e5e5e5').stroke();
  doc.moveDown(0.6);

  line('Price per litre', `${currency} ${n(txn.price_per_litre, 3)}`);
  line('Authorized', `${n(txn.authorized_litres, 3)} L  (${currency} ${n(txn.authorized_amount)})`);
  line('Dispensed', `${n(txn.actual_litres, 3)} L`);
  line('Refund to wallet', `${currency} ${n(txn.refund_amount)}`);
  doc.moveDown(0.8);

  const totalY = doc.y + 4;
  doc.font('Helvetica-Bold').fontSize(14);
  doc.text('TOTAL', 56, totalY);
  doc.text(`${currency} ${n(txn.final_amount)}`, 340, totalY, { width: 199, align: 'right' });
  doc.font('Helvetica').fontSize(10);

  doc.moveDown(2);
  doc
    .fontSize(9)
    .fillColor('#777')
    .text(
      'Paid from prepaid wallet balance. This receipt was generated automatically on dispensing completion.',
      56,
      doc.y,
      { width: 483 }
    );

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  await prisma.fuelTransaction.update({
    where: { id: transactionId },
    data: { receipt_url: receiptUrl(transactionId) },
  });

  return { receipt_url: receiptUrl(transactionId), file_path: filePath, generated: true };
}

/**
 * Stream a receipt PDF after validating its HMAC download token.
 * Token proves intent; identity checks still apply on top.
 */
async function serveReceipt(transactionId, token, viewer, res) {
  if (!token || token !== downloadToken(transactionId)) {
    throw new ReceiptError(403, 'Invalid receipt token');
  }
  const txn = await prisma.fuelTransaction.findUnique({ where: { id: transactionId } });
  if (!txn) throw new ReceiptError(404, 'Receipt not found');

  if (viewer) {
    if (viewer.type === 'customer' && viewer.sub !== txn.user_id) {
      throw new ReceiptError(403, 'Not your receipt');
    }
    if (viewer.type === 'staff' && viewer.station_id !== txn.station_id) {
      throw new ReceiptError(403, 'Receipt belongs to another station');
    }
  }

  const filePath = receiptPath(transactionId);
  if (!fs.existsSync(filePath)) {
    // Regenerate on demand (e.g. after the receipts volume was wiped).
    await generateReceipt(transactionId);
  }
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${txn.transaction_reference}.pdf"`);
  fs.createReadStream(filePath).pipe(res);
}

/** Receipt URL for a transaction the caller is allowed to see. */
async function getReceiptUrl(transactionId, viewer) {
  const txn = await prisma.fuelTransaction.findUnique({ where: { id: transactionId } });
  if (!txn) throw new ReceiptError(404, 'Fuel transaction not found');
  if (viewer.type === 'customer' && txn.user_id !== viewer.sub) {
    throw new ReceiptError(403, 'Not your transaction');
  }
  if (viewer.type === 'staff' && txn.station_id !== viewer.station_id) {
    throw new ReceiptError(403, 'Transaction belongs to another station');
  }
  return txn.receipt_url || receiptUrl(transactionId);
}

module.exports = { generateReceipt, serveReceipt, getReceiptUrl, receiptUrl, downloadToken, ReceiptError };
