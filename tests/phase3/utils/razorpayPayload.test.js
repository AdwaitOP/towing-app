'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRazorpayPayload } = require('../../../firebase/functions/src/utils/razorpayPayload');

function paidPayload(overrides = {}) {
  const link = {
    id: 'plink_ABC123', reference_id: 'job-1', currency: 'INR', status: 'paid',
    amount: 50000, amount_paid: 50000, accept_partial: false,
    ...(overrides.link || {}),
  };
  const payment = {
    id: 'pay_ABC123', currency: 'INR', status: 'captured', amount: 50000,
    ...(overrides.payment || {}),
  };
  return { event: 'payment_link.paid', payload: { payment_link: { entity: link }, payment: { entity: payment } } };
}

test('paid payload returns payment-ID idempotency inputs only after strict validation', () => {
  assert.deepEqual(validateRazorpayPayload(paidPayload()), {
    paymentLinkId: 'plink_ABC123', jobId: 'job-1', paymentId: 'pay_ABC123', amountPaise: 50000,
  });
});

test('paid payload rejects malformed IDs, currencies, statuses, amounts, and partial payments', () => {
  const cases = [
    paidPayload({ link: { id: '' } }),
    paidPayload({ payment: { id: 'payment-1' } }),
    paidPayload({ link: { currency: 'USD' } }),
    paidPayload({ payment: { currency: 'USD' } }),
    paidPayload({ link: { status: 'created' } }),
    paidPayload({ payment: { status: 'authorized' } }),
    paidPayload({ link: { amount_paid: 49999 } }),
    paidPayload({ payment: { amount: 49999 } }),
    paidPayload({ link: { accept_partial: true } }),
    paidPayload({ link: { reference_id: ' job-1' } }),
    paidPayload({ link: { reference_id: 'x'.repeat(41) } }),
    paidPayload({ link: { reference_id: 'job/bad' } }),
  ];
  for (const payload of cases) assert.throws(() => validateRazorpayPayload(payload));
});

test('refund payload requires exact processed INR refund identity and payment identity', () => {
  const payload = {
    event: 'refund.processed',
    payload: { refund: { entity: {
      id: 'rfnd_ABC123', payment_id: 'pay_ABC123', status: 'processed', currency: 'INR', amount: 50000,
    } } },
  };
  assert.deepEqual(validateRazorpayPayload(payload), {
    refundId: 'rfnd_ABC123', paymentId: 'pay_ABC123', amountPaise: 50000,
  });
  assert.throws(() => validateRazorpayPayload({ ...payload, payload: { refund: { entity: { ...payload.payload.refund.entity, payment_id: '' } } } }));
});
