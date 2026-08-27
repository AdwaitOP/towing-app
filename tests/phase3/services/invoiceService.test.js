'use strict';

const {
  FakeFirestore,
  FakeStorage,
  FakeTimestamp,
  FakePdfDocument,
} = require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createInvoiceService,
  generatePdfBuffer,
  InvoiceError,
} = require('../../../firebase/functions/src/services/invoiceService');

const instant = new Date('2026-08-25T20:00:00.000Z');

function seedPaidJob(db, id = 'job-1', overrides = {}) {
  db.seed('jobs', id, {
    customerPhone: '+919876543210',
    requestedTruckType: 'flatbed',
    bookingFeePaise: 50000,
    estimatedFarePaise: 900000,
    razorpayPaymentId: `pay_${id.replace(/-/g, '')}`,
    paymentConfirmedAt: FakeTimestamp.fromMillis(instant.getTime() - 1000),
    invoiceNumber: null,
    invoiceUrl: null,
    invoiceSentAt: null,
    ...overrides,
  });
}

function seedConfig(db, overrides = {}) {
  db.seed('business_config', 'main', {
    businessName: 'Navi Mumbai Towing',
    gstin: '27ABCDE1234F1Z5',
    registeredAddress: 'Navi Mumbai, Maharashtra',
    invoiceNumberCounter: 0,
    ...overrides,
  });
}

function harness({ sendFailure = false, onUpload, onSend } = {}) {
  const db = new FakeFirestore();
  const storage = new FakeStorage();
  seedPaidJob(db);
  seedConfig(db);
  const calls = { pdf: [], uploads: [], sends: [] };
  const whatsapp = {
    uploadDocument: async (buffer, filename, mime) => {
      calls.uploads.push({ buffer, filename, mime });
      if (onUpload) await onUpload(db);
      return 'media-invoice-1';
    },
    sendDocumentByMediaId: async (...args) => {
      calls.sends.push(args);
      if (onSend) await onSend(db);
      if (sendFailure) throw new Error('Meta unavailable');
      return { messageId: 'wamid.invoice-1' };
    },
  };
  const service = createInvoiceService({
    db,
    storage,
    TimestampClass: FakeTimestamp,
    now: () => instant,
    randomUUID: () => 'invoice-owner',
    pdfGenerator: async (...args) => { calls.pdf.push(args); return Buffer.from('%PDF-booking-fee'); },
    whatsapp,
  });
  return { db, storage, service, calls, whatsapp };
}

test('invoice number, private object, and accepted WhatsApp send are persisted recoverably', async () => {
  const { db, storage, service, calls } = harness();
  await service.ensureInvoiceAndSend('job-1');
  const job = db.read('jobs', 'job-1');
  assert.equal(job.invoiceNumber, 'TDS-0001');
  assert.equal(job.invoiceIssueDateIst, '2026-08-26');
  assert.equal(db.read('business_config', 'main').invoiceNumberCounter, 1);
  assert.equal(job.invoiceStoragePath, 'invoices/job-1.pdf');
  assert.equal(job.invoiceUrl, 'gs://unit-test.appspot.com/invoices/job-1.pdf');
  assert.equal(job.invoiceWhatsAppMediaId, 'media-invoice-1');
  assert.equal(job.invoiceWhatsAppMessageId, 'wamid.invoice-1');
  assert.equal(job.invoiceSentAt.toMillis(), instant.getTime());
  assert.equal(storage.files.has('invoices/job-1.pdf'), true);
  assert.equal(calls.pdf[0][0].bookingFeePaise, 50000);
  assert.equal(calls.pdf[0][1], 'TDS-0001');
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.sends.length, 1);
});

test('retry after completion neither increments the counter nor redelivers', async () => {
  const { db, service, calls } = harness();
  await service.ensureInvoiceAndSend('job-1');
  await service.ensureInvoiceAndSend('job-1');
  assert.equal(db.read('business_config', 'main').invoiceNumberCounter, 1);
  assert.equal(calls.pdf.length, 1);
  assert.equal(calls.uploads.length, 1);
  assert.equal(calls.sends.length, 1);
});

test('completed invoice markers are accepted only as one consistent persisted set', async () => {
  const valid = {
    invoiceNumber: 'TDS-0001',
    invoiceIssueDateIst: '2026-08-26',
    invoiceIssuedAt: FakeTimestamp.fromMillis(instant.getTime()),
    invoiceStoragePath: 'invoices/job-1.pdf',
    invoiceUrl: 'gs://unit-test.appspot.com/invoices/job-1.pdf',
    invoiceWhatsAppMediaId: 'media-existing',
    invoiceWhatsAppMessageId: 'wamid.existing',
    invoiceSentAt: FakeTimestamp.fromMillis(instant.getTime()),
    invoiceSendOwner: null,
    invoiceSendLeaseUntil: null,
  };
  const complete = harness();
  seedConfig(complete.db, { invoiceNumberCounter: 1 });
  seedPaidJob(complete.db, 'job-1', valid);
  const result = await complete.service.ensureInvoiceAndSend('job-1');
  assert.equal(result.invoiceNumber, 'TDS-0001');
  assert.equal(complete.calls.uploads.length, 0);
  assert.equal(complete.calls.sends.length, 0);

  const corruptions = [
    { invoiceUrl: null },
    { invoiceStoragePath: null },
    { invoiceWhatsAppMediaId: null },
    { invoiceWhatsAppMessageId: null },
    { invoiceSentAt: 'not-a-timestamp' },
    { invoiceSendOwner: 'stale-owner' },
    { invoiceSendLeaseUntil: FakeTimestamp.fromMillis(instant.getTime() + 60_000) },
  ];
  for (const corruption of corruptions) {
    const setup = harness();
    seedConfig(setup.db, { invoiceNumberCounter: 1 });
    seedPaidJob(setup.db, 'job-1', { ...valid, ...corruption });
    await assert.rejects(
      setup.service.ensureInvoiceAndSend('job-1'),
      error => error instanceof InvoiceError && error.code === 'INVOICE_MARKERS_INCONSISTENT'
    );
    assert.equal(setup.calls.uploads.length, 0);
    assert.equal(setup.calls.sends.length, 0);
  }
});

test('recoverable private invoice URL with a missing Storage path is repaired before delivery', async () => {
  const setup = harness();
  seedConfig(setup.db, { invoiceNumberCounter: 1 });
  seedPaidJob(setup.db, 'job-1', {
    invoiceNumber: 'TDS-0001',
    invoiceIssueDateIst: '2026-08-26',
    invoiceIssuedAt: FakeTimestamp.fromMillis(instant.getTime()),
    invoiceStoragePath: null,
    invoiceUrl: 'gs://unit-test.appspot.com/invoices/job-1.pdf',
    invoiceSentAt: null,
  });
  setup.storage.files.set('invoices/job-1.pdf', {
    buffer: Buffer.from('%PDF-existing'),
    options: { metadata: { contentType: 'application/pdf' } },
  });
  await setup.service.ensureInvoiceAndSend('job-1');
  const job = setup.db.read('jobs', 'job-1');
  assert.equal(job.invoiceStoragePath, 'invoices/job-1.pdf');
  assert.equal(job.invoiceWhatsAppMessageId, 'wamid.invoice-1');
  assert.equal(setup.calls.pdf.length, 0);
  assert.equal(setup.calls.sends.length, 1);
});

test('invoice provider calls retain an active owned send lease', async () => {
  let checks = 0;
  const assertLease = db => {
    const job = db.read('jobs', 'job-1');
    checks += 1;
    assert.equal(job.invoiceSendOwner, 'invoice-owner');
    assert.ok(job.invoiceSendLeaseUntil.toMillis() > instant.getTime());
  };
  const setup = harness({ onUpload: assertLease, onSend: assertLease });
  await setup.service.ensureInvoiceAndSend('job-1');
  assert.equal(checks, 2);
});

test('WhatsApp failure preserves number and Storage recovery but not invoiceSentAt', async () => {
  const setup = harness({ sendFailure: true });
  await assert.rejects(setup.service.ensureInvoiceAndSend('job-1'), /Meta unavailable/);
  let job = setup.db.read('jobs', 'job-1');
  assert.equal(job.invoiceNumber, 'TDS-0001');
  assert.equal(job.invoiceUrl, 'gs://unit-test.appspot.com/invoices/job-1.pdf');
  assert.equal(job.invoiceSentAt, null);
  assert.equal(job.invoiceSendOwner, null);
  setup.whatsapp.sendDocumentByMediaId = async (...args) => {
    setup.calls.sends.push(args);
    return { messageId: 'wamid.recovered' };
  };
  await setup.service.ensureInvoiceAndSend('job-1');
  job = setup.db.read('jobs', 'job-1');
  assert.equal(job.invoiceWhatsAppMessageId, 'wamid.recovered');
  assert.equal(setup.db.read('business_config', 'main').invoiceNumberCounter, 1);
  assert.equal(setup.calls.pdf.length, 1);
});

test('invoice allocation fails closed for missing identity, counter, or payment', async () => {
  const missingIdentity = harness();
  missingIdentity.db.seed('business_config', 'main', {
    businessName: '', gstin: '', registeredAddress: '', invoiceNumberCounter: 0,
  });
  await assert.rejects(missingIdentity.service.allocateInvoiceNumber('job-1'), InvoiceError);

  const badCounter = harness();
  seedConfig(badCounter.db, { invoiceNumberCounter: -1 });
  await assert.rejects(badCounter.service.allocateInvoiceNumber('job-1'), /invoiceNumberCounter/);

  const badGstin = harness();
  seedConfig(badGstin.db, { gstin: 'not-a-gstin' });
  await assert.rejects(badGstin.service.allocateInvoiceNumber('job-1'), /gstin is invalid/);

  const unpaid = harness();
  seedPaidJob(unpaid.db, 'job-1', { paymentConfirmedAt: null, razorpayPaymentId: null });
  await assert.rejects(unpaid.service.allocateInvoiceNumber('job-1'), /before verified payment/);
});

test('separate paid jobs receive distinct sequential numbers without retry gaps', async () => {
  const { db, service } = harness();
  seedPaidJob(db, 'job-2');
  const one = await service.allocateInvoiceNumber('job-1');
  const oneAgain = await service.allocateInvoiceNumber('job-1');
  const two = await service.allocateInvoiceNumber('job-2');
  assert.equal(one.invoiceNumber, 'TDS-0001');
  assert.equal(oneAgain.invoiceNumber, 'TDS-0001');
  assert.equal(two.invoiceNumber, 'TDS-0002');
  assert.equal(db.read('business_config', 'main').invoiceNumberCounter, 2);
});

test('existing invoice number recovers its immutable IST issue date without incrementing', async () => {
  const { db, service } = harness();
  seedConfig(db, { invoiceNumberCounter: 7 });
  seedPaidJob(db, 'job-1', {
    invoiceNumber: 'TDS-0007',
    invoiceIssueDateIst: null,
    invoiceIssuedAt: null,
    paymentConfirmedAt: FakeTimestamp.fromMillis(Date.parse('2026-08-25T20:00:00Z')),
  });
  const allocation = await service.allocateInvoiceNumber('job-1');
  assert.equal(allocation.invoiceNumber, 'TDS-0007');
  assert.equal(allocation.issueDateIst, '2026-08-26');
  assert.equal(db.read('business_config', 'main').invoiceNumberCounter, 7);
  assert.equal(db.read('jobs', 'job-1').invoiceIssueDateIst, '2026-08-26');
});

test('generated PDF describes booking fee only and uses immutable IST issue date', async () => {
  FakePdfDocument.documents.length = 0;
  await generatePdfBuffer(
    { customerPhone: '+919876543210', requestedTruckType: 'flatbed', bookingFeePaise: 50000, estimatedFarePaise: 999900 },
    'TDS-0001',
    { businessName: 'Business', gstin: 'GSTIN', registeredAddress: 'Address' },
    '2026-08-26'
  );
  const rendered = FakePdfDocument.documents.at(-1).textValues.join('\n');
  assert.match(rendered, /Total: INR 500\.00/);
  assert.match(rendered, /Issue Date \(IST\): 2026-08-26/);
  assert.doesNotMatch(rendered, /9999\.00/);
  assert.match(rendered, /paid directly to the driver/);
});
