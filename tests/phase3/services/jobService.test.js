'use strict';

const { FakeFirestore, FakeTimestamp } = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createJobService,
  JobIntegrityError,
  ProvisioningBusyError,
} = require('../../../firebase/functions/src/services/jobService');

const pickup = { lat: 19.033, lng: 73.0297 };
const destination = { lat: 19.076, lng: 72.998 };
const fixedDate = new Date('2026-08-25T20:00:00.000Z'); // 01:30 IST

function paymentLink(overrides = {}) {
  return {
    id: 'plink_JOB1', reference_id: 'job-1', amount: 50000, amount_paid: 0,
    currency: 'INR', accept_partial: false, status: 'created', short_url: 'https://rzp.io/i/job1',
    ...overrides,
  };
}

function harness({ db = new FakeFirestore(), remote = [], createImpl } = {}) {
  const calls = { commission: [], fare: [], create: [], recover: [] };
  const pricing = {
    getPricingConfig: async () => ({ source: 'pricing_config/main' }),
    calculateCommission: (distance, config) => {
      calls.commission.push({ distance, config });
      return { tier: 2, bookingFeePaise: 50000, driverCommissionPaise: 30000 };
    },
    calculateFare: (distance, serviceType, hour, config) => {
      calls.fare.push({ distance, serviceType, hour, config });
      return { estimatedFarePaise: 250000 };
    },
  };
  const razorpay = {
    getPaymentLinksByReferenceId: async referenceId => {
      calls.recover.push(referenceId);
      return remote;
    },
    createPaymentLink: async input => {
      calls.create.push(input);
      return createImpl ? createImpl(input) : paymentLink({ reference_id: input.reference_id });
    },
  };
  const service = createJobService({
    db,
    TimestampClass: FakeTimestamp,
    now: () => fixedDate,
    randomUUID: () => 'provision-owner',
    pricing,
    razorpay,
  });
  return { db, service, calls, razorpay };
}

test('createJobAndQuote persists exact job ID, immutable inputs, and Phase 2 paise outputs', async () => {
  const { db, service, calls } = harness();
  const result = await service.createJobAndQuote(
    'job-1', '98765 43210', pickup, destination, 'pulling', 'phone'
  );
  const job = db.read('jobs', 'job-1');
  assert.equal(result.jobId, 'job-1');
  assert.equal(db.read('jobs', 'auto-id-1'), undefined);
  assert.equal(job.customerPhone, '+919876543210');
  assert.deepEqual(job.pickupCoords, pickup);
  assert.deepEqual(job.destCoords, destination);
  assert.equal(job.requestedTruckType, 'pulling');
  assert.equal(job.channel, 'phone');
  assert.equal(job.status, 'awaiting_payment');
  assert.equal(job.bookingFeePaise, 50000);
  assert.equal(job.driverCommissionPaise, 30000);
  assert.equal(job.estimatedFarePaise, 250000);
  assert.equal(calls.commission.length, 1);
  assert.equal(calls.fare[0].serviceType, 'standard');
  assert.equal(calls.fare[0].hour, 1);
  assert.equal(calls.create[0].amount, 50000);
  assert.equal(calls.create[0].reference_id, 'job-1');
});

test('same immutable retry reuses local link without another Razorpay side effect', async () => {
  const { service, calls } = harness();
  await service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp');
  await service.createJobAndQuote('job-1', '919876543210', pickup, destination, 'flatbed', 'whatsapp');
  assert.equal(calls.create.length, 1);
  assert.equal(calls.recover.length, 1);
  assert.equal(calls.commission.length, 1);
  assert.equal(calls.fare.length, 1);
});

test('retry rejects any changed immutable booking input', async () => {
  const { service } = harness();
  await service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp');
  await assert.rejects(
    service.createJobAndQuote('job-1', '+919999999999', pickup, destination, 'flatbed', 'whatsapp'),
    JobIntegrityError
  );
  await assert.rejects(
    service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'pulling', 'whatsapp'),
    JobIntegrityError
  );
});

test('remote Payment Link recovery occurs before creation and validates one candidate', async () => {
  const recovered = paymentLink();
  const { db, service, calls } = harness({ remote: [recovered] });
  const result = await service.createJobAndQuote(
    'job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'
  );
  assert.equal(calls.create.length, 0);
  assert.equal(result.razorpayPaymentLinkId, 'plink_JOB1');
  assert.equal(db.read('jobs', 'job-1').razorpayPaymentLinkUrl, 'https://rzp.io/i/job1');
});

test('ambiguous or invalid remote candidates fail instead of creating another link', async () => {
  const duplicate = harness({ remote: [paymentLink(), paymentLink({ id: 'plink_JOB2' })] });
  await assert.rejects(
    duplicate.service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /Multiple Razorpay/
  );
  assert.equal(duplicate.calls.create.length, 0);

  const invalid = harness({ remote: [paymentLink({ amount: 1 })] });
  await assert.rejects(
    invalid.service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /amount mismatch/
  );
  assert.equal(invalid.calls.create.length, 0);
});

test('remote-create/local-save crash is recovered by reference without a second creation', async () => {
  const db = new FakeFirestore();
  const remote = [];
  const setup = harness({
    db,
    remote,
    createImpl: input => {
      const created = paymentLink({ reference_id: input.reference_id });
      remote.push(created);
      return created;
    },
  });
  const original = db.runTransaction.bind(db);
  let transactionCall = 0;
  db.runTransaction = async callback => {
    transactionCall += 1;
    if (transactionCall === 3) throw new Error('simulated local save crash');
    return original(callback);
  };
  await assert.rejects(
    setup.service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /simulated local save crash/
  );
  db.runTransaction = original;
  const recovered = await setup.service.createJobAndQuote(
    'job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'
  );
  assert.equal(setup.calls.create.length, 1);
  assert.equal(recovered.razorpayPaymentLinkId, 'plink_JOB1');
});

test('an active provisioning owner rejects a second worker', async () => {
  const db = new FakeFirestore();
  const { service } = harness({ db });
  db.seed('jobs', 'job-1', {
    customerPhone: '+919876543210', pickupCoords: pickup, destCoords: destination,
    requestedTruckType: 'flatbed', channel: 'whatsapp', status: 'awaiting_payment', bookingFeePaise: 50000,
    driverCommissionPaise: 30000, estimatedFarePaise: 250000,
    razorpayPaymentLinkId: null, razorpayPaymentLinkUrl: null,
    paymentLinkProvisioningOwner: 'other-owner',
    paymentLinkProvisioningLeaseUntil: FakeTimestamp.fromMillis(fixedDate.getTime() + 60000),
  });
  await assert.rejects(
    service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    ProvisioningBusyError
  );
});

test('partial or malformed local Payment Link fields are integrity failures', async () => {
  const partial = harness();
  partial.db.seed('jobs', 'job-1', {
    customerPhone: '+919876543210', pickupCoords: pickup, destCoords: destination,
    requestedTruckType: 'flatbed', channel: 'whatsapp', status: 'awaiting_payment',
    bookingFeePaise: 50000, driverCommissionPaise: 30000, estimatedFarePaise: 250000,
    razorpayPaymentLinkId: 'plink_JOB1', razorpayPaymentLinkUrl: null,
  });
  await assert.rejects(
    partial.service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /partially persisted/
  );

  const malformed = harness();
  malformed.db.seed('jobs', 'job-1', {
    customerPhone: '+919876543210', pickupCoords: pickup, destCoords: destination,
    requestedTruckType: 'flatbed', channel: 'whatsapp', status: 'awaiting_payment',
    bookingFeePaise: 50000, driverCommissionPaise: 30000, estimatedFarePaise: 250000,
    razorpayPaymentLinkId: 'wrong-id', razorpayPaymentLinkUrl: 'http://unsafe.example',
  });
  await assert.rejects(
    malformed.service.createJobAndQuote('job-1', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /malformed Payment Link/
  );
});

test('job input validation accepts zero coordinates and rejects unsafe values', async () => {
  const zero = harness();
  await zero.service.createJobAndQuote(
    'job-zero', '+919876543210', { lat: 0, lng: 0 }, { lat: 0, lng: 1 }, 'flatbed', 'whatsapp'
  );
  await assert.rejects(
    zero.service.createJobAndQuote('job/bad', '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /Invalid jobId/
  );
  await assert.rejects(
    zero.service.createJobAndQuote('x'.repeat(41), '+919876543210', pickup, destination, 'flatbed', 'whatsapp'),
    /Invalid jobId/
  );
});
