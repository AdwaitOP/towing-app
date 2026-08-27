'use strict';

function requireId(value, prefix, field) {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[A-Za-z0-9]+$`).test(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

function requireAmount(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer paise amount`);
  }
  return value;
}

function requireCurrency(value, field) {
  if (value !== 'INR') throw new Error(`${field} currency must be INR`);
}

function validateRazorpayPayload(payload) {
  if (!payload || typeof payload !== 'object' || typeof payload.event !== 'string') {
    throw new Error('Invalid Razorpay payload structure');
  }
  if (payload.event === 'payment_link.paid') {
    const link = payload.payload?.payment_link?.entity;
    const payment = payload.payload?.payment?.entity;
    if (!link || !payment) throw new Error('Missing payment_link or payment entity in payload');
    const paymentLinkId = requireId(link.id, 'plink', 'payment_link.id');
    const paymentId = requireId(payment.id, 'pay', 'payment.id');
    if (
      typeof link.reference_id !== 'string' ||
      !link.reference_id ||
      link.reference_id !== link.reference_id.trim() ||
      link.reference_id.length > 40 ||
      link.reference_id.includes('/')
    ) {
      throw new Error('payment_link.reference_id is invalid');
    }
    requireCurrency(link.currency, 'payment_link');
    requireCurrency(payment.currency, 'payment');
    if (link.status !== 'paid') throw new Error('Payment link is not marked as paid');
    if (payment.status !== 'captured') throw new Error('Payment is not captured');
    const amount = requireAmount(link.amount, 'payment_link.amount');
    if (amount !== requireAmount(link.amount_paid, 'payment_link.amount_paid')) {
      throw new Error('Amount mismatch: amount does not equal amount_paid');
    }
    if (amount !== requireAmount(payment.amount, 'payment.amount')) {
      throw new Error('Payment amount mismatch');
    }
    if (link.accept_partial !== false) throw new Error('accept_partial must be false');
    return {
      paymentLinkId,
      jobId: link.reference_id,
      paymentId,
      amountPaise: amount,
    };
  }
  if (payload.event === 'refund.processed') {
    const refund = payload.payload?.refund?.entity;
    if (!refund) throw new Error('Missing refund entity in payload');
    const refundId = requireId(refund.id, 'rfnd', 'refund.id');
    const paymentId = requireId(refund.payment_id, 'pay', 'refund.payment_id');
    if (refund.status !== 'processed') throw new Error('Refund status is not processed');
    requireCurrency(refund.currency, 'refund');
    return { refundId, paymentId, amountPaise: requireAmount(refund.amount, 'refund.amount') };
  }
  throw new Error(`Unsupported event: ${payload.event}`);
}

module.exports = { validateRazorpayPayload };
