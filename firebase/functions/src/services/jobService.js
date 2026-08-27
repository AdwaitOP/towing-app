'use strict';

const crypto = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const {
  calculateCommission,
  calculateFare,
  getPricingConfig,
} = require('../fareCalculator');
const { normalizeCoordinates, haversineDistance } = require('../utils/haversine');
const { normalizePhone } = require('../utils/phone');
const { getServiceType } = require('../utils/truckTypeMapper');
const { getIstHour } = require('../utils/date');
const {
  createPaymentLink,
  getPaymentLinksByReferenceId,
  validatePaymentLink,
} = require('./razorpayClient');

const PROVISIONING_LEASE_MS = 120000;

class JobIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JobIntegrityError';
    this.code = 'JOB_INTEGRITY_ERROR';
  }
}

class ProvisioningBusyError extends Error {
  constructor() {
    super('Payment Link provisioning is already in progress');
    this.name = 'ProvisioningBusyError';
    this.code = 'PROVISIONING_BUSY';
    this.status = 503;
  }
}

function createJobService({
  db = getFirestore(),
  TimestampClass = Timestamp,
  now = () => new Date(),
  randomUUID = () => crypto.randomUUID(),
  pricing = { calculateCommission, calculateFare, getPricingConfig },
  razorpay = { createPaymentLink, getPaymentLinksByReferenceId },
  provisioningLeaseMs = PROVISIONING_LEASE_MS,
} = {}) {
  async function createJobAndQuote(
    jobId,
    customerPhone,
    pickupCoords,
    destCoords,
    requestedTruckType,
    channel
  ) {
    const inputs = validateInputs({
      jobId,
      customerPhone,
      pickupCoords,
      destCoords,
      requestedTruckType,
      channel,
    });
    const instant = now();
    if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new Error('Clock returned invalid Date');
    const jobRef = db.collection('jobs').doc(inputs.jobId);
    const initialSnapshot = await jobRef.get();
    let jobData;
    if (initialSnapshot.exists) {
      jobData = initialSnapshot.data();
      validateImmutableJob(jobData, inputs);
    } else {
      const config = await pricing.getPricingConfig();
      const distanceKm = haversineDistance(inputs.pickupCoords, inputs.destCoords);
      const serviceType = getServiceType(inputs.requestedTruckType);
      const departureHourIst = getIstHour(instant);
      const commission = pricing.calculateCommission(distanceKm, config);
      const fare = pricing.calculateFare(distanceKm, serviceType, departureHourIst, config);
      assertPaise(commission.bookingFeePaise, 'bookingFeePaise');
      assertPaise(commission.driverCommissionPaise, 'driverCommissionPaise');
      assertPaise(fare.estimatedFarePaise, 'estimatedFarePaise');
      jobData = await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(jobRef);
        if (snapshot.exists) {
          const existing = snapshot.data();
          validateImmutableJob(existing, inputs);
          return existing;
        }
        const timestamp = TimestampClass.fromMillis(instant.getTime());
        const created = {
          customerPhone: inputs.customerPhone,
          pickupCoords: inputs.pickupCoords,
          destCoords: inputs.destCoords,
          requestedTruckType: inputs.requestedTruckType,
          channel: inputs.channel,
          createdByAdmin: null,
          distanceKm,
          pricingTier: commission.tier,
          bookingFeePaise: commission.bookingFeePaise,
          driverCommissionPaise: commission.driverCommissionPaise,
          estimatedFarePaise: fare.estimatedFarePaise,
          status: 'awaiting_payment',
          offeredTo: null,
          assignedDriver: null,
          razorpayPaymentLinkId: null,
          razorpayPaymentLinkUrl: null,
          razorpayPaymentId: null,
          paymentConfirmedAt: null,
          invoiceNumber: null,
          invoiceUrl: null,
          invoiceSentAt: null,
          cancellationRequestedAt: null,
          cancelledBy: null,
          cancellationReason: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        transaction.set(jobRef, created);
        return created;
      });
    }

    if (hasCompleteLocalLink(jobData)) return { jobId: inputs.jobId, ...jobData };
    if (jobData.status !== 'awaiting_payment') {
      throw new JobIntegrityError('A non-awaiting job cannot provision a missing Payment Link');
    }
    const ownerToken = randomUUID();
    const claim = await claimProvisioning(jobRef, ownerToken);
    if (claim.local) return { jobId: inputs.jobId, ...claim.job };
    jobData = claim.job;

    try {
      const remote = await razorpay.getPaymentLinksByReferenceId(inputs.jobId);
      if (!Array.isArray(remote)) throw new JobIntegrityError('Razorpay recovery did not return an array');
      if (remote.length > 1) {
        throw new JobIntegrityError('Multiple Razorpay Payment Links share this job reference');
      }
      let link;
      if (remote.length === 1) {
        link = validatePaymentLink(remote[0], {
          referenceId: inputs.jobId,
          amount: jobData.bookingFeePaise,
          allowedStatuses: ['created', 'paid'],
        });
        assertShortUrl(link.short_url);
      } else {
        await assertProvisioningOwner(jobRef, ownerToken);
        link = await razorpay.createPaymentLink({
          reference_id: inputs.jobId,
          amount: jobData.bookingFeePaise,
          description: `Towing booking fee - ${inputs.jobId}`,
          customer_phone: inputs.customerPhone,
        });
        validatePaymentLink(link, {
          referenceId: inputs.jobId,
          amount: jobData.bookingFeePaise,
          allowedStatuses: ['created'],
        });
        assertShortUrl(link.short_url);
      }
      const persisted = await persistOwnedLink(jobRef, ownerToken, link);
      return { jobId: inputs.jobId, ...persisted };
    } catch (error) {
      await releaseProvisioning(jobRef, ownerToken);
      throw error;
    }
  }

  async function claimProvisioning(jobRef, ownerToken) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) throw new JobIntegrityError('Job disappeared during Payment Link provisioning');
      const data = snapshot.data();
      if (hasCompleteLocalLink(data)) return { local: true, job: data };
      const nowMs = now().getTime();
      if (
        data.paymentLinkProvisioningOwner &&
        data.paymentLinkProvisioningOwner !== ownerToken &&
        timestampMillis(data.paymentLinkProvisioningLeaseUntil) > nowMs
      ) {
        throw new ProvisioningBusyError();
      }
      transaction.update(jobRef, {
        paymentLinkProvisioningOwner: ownerToken,
        paymentLinkProvisioningLeaseUntil: TimestampClass.fromMillis(nowMs + provisioningLeaseMs),
        updatedAt: TimestampClass.fromMillis(nowMs),
      });
      return { local: false, job: data };
    });
  }

  async function assertProvisioningOwner(jobRef, ownerToken) {
    const snapshot = await jobRef.get();
    const data = snapshot.data();
    if (!snapshot.exists || data.paymentLinkProvisioningOwner !== ownerToken) {
      throw new ProvisioningBusyError();
    }
    if (timestampMillis(data.paymentLinkProvisioningLeaseUntil) <= now().getTime()) {
      throw new ProvisioningBusyError();
    }
  }

  async function persistOwnedLink(jobRef, ownerToken, link) {
    return db.runTransaction(async transaction => {
      const snapshot = await transaction.get(jobRef);
      if (!snapshot.exists) throw new JobIntegrityError('Job disappeared before Payment Link persistence');
      const data = snapshot.data();
      if (hasCompleteLocalLink(data)) {
        if (data.razorpayPaymentLinkId !== link.id || data.razorpayPaymentLinkUrl !== link.short_url) {
          throw new JobIntegrityError('A different Payment Link was already persisted');
        }
        return data;
      }
      if (data.paymentLinkProvisioningOwner !== ownerToken) throw new ProvisioningBusyError();
      const update = {
        razorpayPaymentLinkId: link.id,
        razorpayPaymentLinkUrl: link.short_url,
        paymentLinkProvisioningOwner: null,
        paymentLinkProvisioningLeaseUntil: null,
        updatedAt: TimestampClass.fromMillis(now().getTime()),
      };
      transaction.update(jobRef, update);
      return { ...data, ...update };
    });
  }

  async function releaseProvisioning(jobRef, ownerToken) {
    try {
      await db.runTransaction(async transaction => {
        const snapshot = await transaction.get(jobRef);
        if (!snapshot.exists || snapshot.data().paymentLinkProvisioningOwner !== ownerToken) return;
        transaction.update(jobRef, {
          paymentLinkProvisioningOwner: null,
          paymentLinkProvisioningLeaseUntil: null,
          updatedAt: TimestampClass.fromMillis(now().getTime()),
        });
      });
    } catch (error) {
      console.error('Failed to release Payment Link provisioning claim', error);
    }
  }

  return { createJobAndQuote };
}

function validateInputs(input) {
  if (
    typeof input.jobId !== 'string' ||
    !input.jobId ||
    input.jobId !== input.jobId.trim() ||
    input.jobId.length > 40 ||
    input.jobId.includes('/')
  ) {
    throw new TypeError('Invalid jobId');
  }
  if (!['flatbed', 'pulling'].includes(input.requestedTruckType)) {
    throw new TypeError('Invalid requestedTruckType');
  }
  if (!['whatsapp', 'phone'].includes(input.channel)) throw new TypeError('Invalid channel');
  return {
    ...input,
    jobId: input.jobId,
    customerPhone: normalizePhone(input.customerPhone),
    pickupCoords: normalizeCoordinates(input.pickupCoords, 'pickupCoords'),
    destCoords: normalizeCoordinates(input.destCoords, 'destCoords'),
  };
}

function validateImmutableJob(job, expected) {
  if (
    job.customerPhone !== expected.customerPhone ||
    job.requestedTruckType !== expected.requestedTruckType ||
    job.channel !== expected.channel ||
    !sameCoords(job.pickupCoords, expected.pickupCoords) ||
    !sameCoords(job.destCoords, expected.destCoords)
  ) {
    throw new JobIntegrityError('Existing job does not match immutable retry inputs');
  }
  assertPaise(job.bookingFeePaise, 'existing bookingFeePaise');
  assertPaise(job.driverCommissionPaise, 'existing driverCommissionPaise');
  assertPaise(job.estimatedFarePaise, 'existing estimatedFarePaise');
}

function sameCoords(left, right) {
  return left?.lat === right.lat && left?.lng === right.lng;
}

function hasCompleteLocalLink(job) {
  const idPresent = job.razorpayPaymentLinkId !== null && job.razorpayPaymentLinkId !== undefined;
  const urlPresent = job.razorpayPaymentLinkUrl !== null && job.razorpayPaymentLinkUrl !== undefined;
  if (idPresent !== urlPresent) {
    throw new JobIntegrityError('Job has a partially persisted Payment Link');
  }
  if (!idPresent) return false;
  const validId = typeof job.razorpayPaymentLinkId === 'string' && /^plink_[A-Za-z0-9]+$/.test(job.razorpayPaymentLinkId);
  const validUrl = typeof job.razorpayPaymentLinkUrl === 'string' && /^https:\/\//.test(job.razorpayPaymentLinkUrl);
  if (!validId || !validUrl) throw new JobIntegrityError('Job has malformed Payment Link fields');
  return true;
}

function assertShortUrl(value) {
  if (typeof value !== 'string' || !/^https:\/\//.test(value)) {
    throw new JobIntegrityError('Razorpay Payment Link has no secure short URL');
  }
}

function assertPaise(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new JobIntegrityError(`${field} is invalid`);
}

function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return NaN;
}

let defaultService;
function getDefaultService() {
  if (!defaultService) defaultService = createJobService();
  return defaultService;
}

module.exports = {
  PROVISIONING_LEASE_MS,
  JobIntegrityError,
  ProvisioningBusyError,
  createJobService,
  createJobAndQuote: (...args) => getDefaultService().createJobAndQuote(...args),
};
