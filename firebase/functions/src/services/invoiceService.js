'use strict';

const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const PDFDocument = require('pdfkit');
const { getIstDateString } = require('../utils/date');
const { uploadDocument, sendDocumentByMediaId } = require('./whatsappClient');

const INVOICE_SEND_LEASE_MS = 120000;

class InvoiceError extends Error {
  constructor(message, code = 'INVOICE_ERROR', status = 500) {
    super(message);
    this.name = 'InvoiceError';
    this.code = code;
    this.status = status;
  }
}

function createInvoiceService({
  db = getFirestore(),
  storage = getStorage(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  pdfGenerator = generatePdfBuffer,
  whatsapp = { uploadDocument, sendDocumentByMediaId },
  sendLeaseMs = INVOICE_SEND_LEASE_MS,
} = {}) {
  async function allocateInvoiceNumber(jobId) {
    const jobRef = db.collection('jobs').doc(jobId);
    const configRef = db.collection('business_config').doc('main');
    return db.runTransaction(async transaction => {
      const jobSnapshot = await transaction.get(jobRef);
      if (!jobSnapshot.exists) throw new InvoiceError('Job does not exist', 'JOB_NOT_FOUND', 404);
      const job = jobSnapshot.data();
      if (!job.paymentConfirmedAt || !job.razorpayPaymentId) {
        throw new InvoiceError('Invoice cannot be issued before verified payment', 'PAYMENT_NOT_CONFIRMED', 409);
      }
      if (markerPresent(job.invoiceSentAt) && !job.invoiceNumber) {
        throw new InvoiceError(
          'Completed invoice is missing its invoiceNumber',
          'INVOICE_MARKERS_INCONSISTENT'
        );
      }
      const configSnapshot = await transaction.get(configRef);
      const businessConfig = validateBusinessConfig(configSnapshot);
      const currentCounter = businessConfig.invoiceNumberCounter;
      if (!Number.isSafeInteger(currentCounter) || currentCounter < 0) {
        throw new InvoiceError('invoiceNumberCounter is invalid', 'CONFIGURATION_ERROR', 503);
      }
      if (job.invoiceNumber) {
        const match = /^TDS-(\d{4,})$/.exec(job.invoiceNumber);
        if (!match) throw new InvoiceError('Existing invoiceNumber is malformed');
        if (Number(match[1]) > currentCounter) {
          throw new InvoiceError('invoiceNumberCounter is behind the assigned invoice number');
        }
        let issueDateIst = job.invoiceIssueDateIst;
        const issuedDate = timestampDate(job.invoiceIssuedAt);
        if (issueDateIst) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDateIst) || !issuedDate) {
            throw new InvoiceError('Existing invoice issue markers are inconsistent');
          }
          if (getIstDateString(issuedDate) !== issueDateIst) {
            throw new InvoiceError('Existing invoice issue date does not match invoiceIssuedAt');
          }
        } else {
          const recoverableDate = issuedDate || timestampDate(job.paymentConfirmedAt || job.createdAt);
          if (!recoverableDate) throw new InvoiceError('Invoice number has no recoverable issue date');
          issueDateIst = getIstDateString(recoverableDate);
          transaction.update(jobRef, {
            invoiceIssueDateIst: issueDateIst,
            invoiceIssuedAt: job.invoiceIssuedAt || TimestampClass.fromMillis(recoverableDate.getTime()),
            updatedAt: TimestampClass.fromMillis(now().getTime()),
          });
        }
        return { invoiceNumber: job.invoiceNumber, issueDateIst, businessConfig };
      }
      const nextCounter = currentCounter + 1;
      const invoiceNumber = `TDS-${String(nextCounter).padStart(4, '0')}`;
      const instant = now();
      const issueDateIst = getIstDateString(instant);
      const timestamp = TimestampClass.fromMillis(instant.getTime());
      transaction.update(configRef, { invoiceNumberCounter: nextCounter });
      transaction.update(jobRef, {
        invoiceNumber,
        invoiceIssueDateIst: issueDateIst,
        invoiceIssuedAt: timestamp,
        updatedAt: timestamp,
      });
      return { invoiceNumber, issueDateIst, businessConfig: { ...businessConfig, invoiceNumberCounter: nextCounter } };
    });
  }

  async function ensureInvoiceAndSend(jobId) {
    const allocation = await allocateInvoiceNumber(jobId);
    const jobRef = db.collection('jobs').doc(jobId);
    let snapshot = await jobRef.get();
    if (!snapshot.exists) throw new InvoiceError('Job disappeared', 'JOB_NOT_FOUND', 404);
    let job = snapshot.data();
    const bucket = storage.bucket();
    const bucketName = bucket?.name;
    if (typeof bucketName !== 'string' || !bucketName) {
      throw new InvoiceError('Storage bucket name is unavailable');
    }
    const storagePath = `invoices/${jobId}.pdf`;
    const completionContext = { jobId, bucketName, storagePath };
    if (markerPresent(job.invoiceSentAt)) {
      validateCompletedInvoice(job, completionContext);
      return invoiceResult(jobId, job);
    }

    const file = bucket.file(storagePath);
    let pdfBuffer;
    if (!job.invoiceUrl) {
      if (job.invoiceStoragePath && job.invoiceStoragePath !== storagePath) {
        throw new InvoiceError('Invoice Storage path does not match the job');
      }
      pdfBuffer = await pdfGenerator(job, allocation.invoiceNumber, allocation.businessConfig, allocation.issueDateIst);
      if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) {
        throw new InvoiceError('PDF generator returned no document');
      }
      await file.save(pdfBuffer, {
        resumable: false,
        metadata: { contentType: 'application/pdf', cacheControl: 'private, no-store' },
      });
      const privateUrl = `gs://${bucketName}/${storagePath}`;
      await db.runTransaction(async transaction => {
        const current = await transaction.get(jobRef);
        if (!current.exists) throw new InvoiceError('Job disappeared');
        const data = current.data();
        if (data.invoiceUrl && data.invoiceUrl !== privateUrl) {
          throw new InvoiceError('Job already references a different invoice object');
        }
        transaction.update(jobRef, {
          invoiceUrl: privateUrl,
          invoiceStoragePath: storagePath,
          updatedAt: TimestampClass.fromMillis(now().getTime()),
        });
      });
    } else {
      if (job.invoiceStoragePath && job.invoiceStoragePath !== storagePath) {
        throw new InvoiceError('Invoice Storage path does not match the job');
      }
      if (job.invoiceUrl !== `gs://${bucket.name}/${storagePath}`) {
        throw new InvoiceError('Invoice URL is not the expected private Storage URL');
      }
      if (!job.invoiceStoragePath) {
        await db.runTransaction(async transaction => {
          const current = await transaction.get(jobRef);
          if (!current.exists) throw new InvoiceError('Job disappeared');
          const data = current.data();
          if (data.invoiceStoragePath && data.invoiceStoragePath !== storagePath) {
            throw new InvoiceError('Invoice Storage path does not match the job');
          }
          if (data.invoiceUrl !== `gs://${bucketName}/${storagePath}`) {
            throw new InvoiceError('Invoice URL changed during recovery');
          }
          transaction.update(jobRef, {
            invoiceStoragePath: storagePath,
            updatedAt: TimestampClass.fromMillis(now().getTime()),
          });
        });
      }
    }

    const ownerToken = randomUUID();
    const claim = await claimSend(jobRef, ownerToken, completionContext);
    if (claim.sent) return invoiceResult(jobId, claim.job);
    job = claim.job;
    if (!pdfBuffer) {
      [pdfBuffer] = await file.download();
      if (!Buffer.isBuffer(pdfBuffer) || pdfBuffer.length === 0) throw new InvoiceError('Stored invoice is empty');
    }
    try {
      const filename = `Invoice_${allocation.invoiceNumber}.pdf`;
      await renewSend(jobRef, ownerToken);
      const mediaId = await whatsapp.uploadDocument(pdfBuffer, filename, 'application/pdf');
      if (typeof mediaId !== 'string' || !mediaId) {
        throw new InvoiceError('WhatsApp did not accept the invoice media upload');
      }
      await renewSend(jobRef, ownerToken);
      const accepted = await whatsapp.sendDocumentByMediaId(
        job.customerPhone,
        mediaId,
        filename,
        'Here is your towing booking-fee invoice.'
      );
      if (typeof accepted?.messageId !== 'string' || !accepted.messageId) {
        throw new InvoiceError('WhatsApp did not accept the invoice message');
      }
      const sentJob = await markSent(jobRef, ownerToken, mediaId, accepted.messageId);
      return invoiceResult(jobId, sentJob);
    } catch (error) {
      await releaseSend(jobRef, ownerToken);
      throw error;
    }
  }

  async function renewSend(jobRef, ownerToken) {
    await db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) throw new InvoiceError('Job not found', 'JOB_NOT_FOUND', 404);
      const job = snapshot.data();
      if (markerPresent(job.invoiceSentAt) || job.invoiceSendOwner !== ownerToken) {
        throw new InvoiceError('Invoice send ownership was lost', 'INVOICE_SEND_OWNERSHIP_LOST', 503);
      }
      const nowMs = now().getTime();
      transaction.update(jobRef, {
        invoiceSendLeaseUntil: TimestampClass.fromMillis(nowMs + sendLeaseMs),
        updatedAt: TimestampClass.fromMillis(nowMs),
      });
    });
  }

  async function claimSend(jobRef, ownerToken, completionContext) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) throw new InvoiceError('Job not found', 'JOB_NOT_FOUND', 404);
      const job = snapshot.data();
      if (markerPresent(job.invoiceSentAt)) {
        validateCompletedInvoice(job, completionContext);
        return { sent: true, job };
      }
      const nowMs = now().getTime();
      if (
        job.invoiceSendOwner &&
        job.invoiceSendOwner !== ownerToken &&
        timestampMillis(job.invoiceSendLeaseUntil) > nowMs
      ) {
        throw new InvoiceError('Invoice send is already in progress', 'INVOICE_SEND_BUSY', 503);
      }
      transaction.update(jobRef, {
        invoiceSendOwner: ownerToken,
        invoiceSendLeaseUntil: TimestampClass.fromMillis(nowMs + sendLeaseMs),
        updatedAt: TimestampClass.fromMillis(nowMs),
      });
      return { sent: false, job };
    });
  }

  async function markSent(jobRef, ownerToken, mediaId, messageId) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) {
        throw new InvoiceError('Invoice send ownership was lost', 'INVOICE_SEND_OWNERSHIP_LOST', 503);
      }
      const job = snapshot.data();
      if (job.invoiceSendOwner !== ownerToken) {
        throw new InvoiceError('Invoice send ownership was lost', 'INVOICE_SEND_OWNERSHIP_LOST', 503);
      }
      const update = {
        invoiceSentAt: TimestampClass.fromMillis(now().getTime()),
        invoiceWhatsAppMediaId: mediaId,
        invoiceWhatsAppMessageId: messageId,
        invoiceSendOwner: null,
        invoiceSendLeaseUntil: null,
        updatedAt: TimestampClass.fromMillis(now().getTime()),
      };
      transaction.update(jobRef, update);
      return { ...job, ...update };
    });
  }

  async function releaseSend(jobRef, ownerToken) {
    try {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(jobRef);
        if (!snapshot.exists || snapshot.data().invoiceSendOwner !== ownerToken) return;
        transaction.update(jobRef, {
          invoiceSendOwner: null,
          invoiceSendLeaseUntil: null,
          updatedAt: TimestampClass.fromMillis(now().getTime()),
        });
      });
    } catch (error) {
      console.error('Failed to release invoice send lease', error);
    }
  }

  return { allocateInvoiceNumber, ensureInvoiceAndSend };
}

function generatePdfBuffer(job, invoiceNumber, businessConfig, issueDateIst) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, info: { Title: invoiceNumber } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.fontSize(20).text('TAX INVOICE - BOOKING FEE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(11)
      .text(`Business Name: ${businessConfig.businessName}`)
      .text(`GSTIN: ${businessConfig.gstin}`)
      .text(`Registered Address: ${businessConfig.registeredAddress}`);
    doc.moveDown();
    doc.text(`Invoice Number: ${invoiceNumber}`);
    doc.text(`Issue Date (IST): ${issueDateIst}`);
    doc.text(`Customer Phone: ${job.customerPhone}`);
    doc.moveDown();
    doc.text(`Platform towing booking fee (${job.requestedTruckType})`);
    doc.fontSize(14).text(`Total: INR ${(job.bookingFeePaise / 100).toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(9).text(
      'This invoice covers only the platform booking fee. The towing fare is paid directly to the driver.',
      { align: 'center' }
    );
    doc.end();
  });
}

function validateBusinessConfig(snapshot) {
  if (!snapshot.exists) throw new InvoiceError('business_config/main is missing', 'CONFIGURATION_ERROR', 503);
  const config = snapshot.data();
  for (const field of ['businessName', 'gstin', 'registeredAddress']) {
    if (typeof config[field] !== 'string' || !config[field].trim()) {
      throw new InvoiceError(`business_config.${field} is not configured`, 'CONFIGURATION_ERROR', 503);
    }
  }
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(config.gstin.trim().toUpperCase())) {
    throw new InvoiceError('business_config.gstin is invalid', 'CONFIGURATION_ERROR', 503);
  }
  return config;
}

function invoiceResult(jobId, job) {
  return {
    jobId,
    invoiceNumber: job.invoiceNumber,
    invoiceUrl: job.invoiceUrl,
    invoiceSentAt: job.invoiceSentAt,
  };
}

function validateCompletedInvoice(job, { jobId, bucketName, storagePath }) {
  if (!validTimestamp(job.invoiceSentAt)) {
    throw new InvoiceError('invoiceSentAt is invalid', 'INVOICE_MARKERS_INCONSISTENT');
  }
  if (typeof job.invoiceNumber !== 'string' || !/^TDS-\d{4,}$/.test(job.invoiceNumber)) {
    throw new InvoiceError('Completed invoice is missing a valid invoiceNumber', 'INVOICE_MARKERS_INCONSISTENT');
  }
  const issuedDate = timestampDate(job.invoiceIssuedAt);
  if (
    typeof job.invoiceIssueDateIst !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(job.invoiceIssueDateIst) ||
    !issuedDate ||
    getIstDateString(issuedDate) !== job.invoiceIssueDateIst
  ) {
    throw new InvoiceError('Completed invoice issue markers are inconsistent', 'INVOICE_MARKERS_INCONSISTENT');
  }
  if (job.invoiceStoragePath !== storagePath) {
    throw new InvoiceError('Completed invoice Storage path is inconsistent', 'INVOICE_MARKERS_INCONSISTENT');
  }
  if (job.invoiceUrl !== `gs://${bucketName}/${storagePath}`) {
    throw new InvoiceError('Completed invoice URL is inconsistent', 'INVOICE_MARKERS_INCONSISTENT');
  }
  for (const field of ['invoiceWhatsAppMediaId', 'invoiceWhatsAppMessageId']) {
    if (typeof job[field] !== 'string' || !job[field]) {
      throw new InvoiceError(`Completed invoice is missing ${field}`, 'INVOICE_MARKERS_INCONSISTENT');
    }
  }
  if (markerPresent(job.invoiceSendOwner) || markerPresent(job.invoiceSendLeaseUntil)) {
    throw new InvoiceError('Completed invoice retains an active send lease', 'INVOICE_MARKERS_INCONSISTENT');
  }
  if (typeof jobId !== 'string' || !jobId) {
    throw new InvoiceError('Completed invoice job identity is invalid', 'INVOICE_MARKERS_INCONSISTENT');
  }
}

function markerPresent(value) {
  return value !== undefined && value !== null;
}

function validTimestamp(value) {
  const milliseconds = timestampMillis(value);
  return Number.isFinite(milliseconds) && milliseconds > 0;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return NaN;
}

function timestampDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.toMillis === 'function') return new Date(value.toMillis());
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  return null;
}

let defaultService;
function getDefaultService() {
  if (!defaultService) defaultService = createInvoiceService();
  return defaultService;
}

module.exports = {
  INVOICE_SEND_LEASE_MS,
  InvoiceError,
  createInvoiceService,
  generatePdfBuffer,
  allocateInvoiceNumber: (...args) => getDefaultService().allocateInvoiceNumber(...args),
  ensureInvoiceAndSend: (...args) => getDefaultService().ensureInvoiceAndSend(...args),
};
