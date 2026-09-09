'use strict';

const { requireEnv } = require('../utils/env');

const DEFAULT_TIMEOUT_MS = 10000;

class ProviderResponseError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ProviderResponseError';
    this.status = status;
    this.code = 'PROVIDER_RESPONSE_INVALID';
  }
}

function createRazorpayClient({
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  function assertConfigured() {
    requireEnv('RAZORPAY_KEY_ID', env);
    requireEnv('RAZORPAY_KEY_SECRET', env);
    return true;
  }

  function authHeader() {
    const keyId = requireEnv('RAZORPAY_KEY_ID', env);
    const keySecret = requireEnv('RAZORPAY_KEY_SECRET', env);
    return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
  }

  async function requestJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: { Authorization: authHeader(), ...(options.headers || {}) },
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('Razorpay request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    const raw = await response.text();
    if (!response.ok) {
      const error = new Error(`Razorpay API error: ${response.status} ${raw}`);
      error.status = response.status;
      error.providerBody = parseJson(raw);
      throw error;
    }
    const parsed = parseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new ProviderResponseError('Razorpay returned invalid JSON', response.status);
    }
    return parsed;
  }

  async function createPaymentLink({ reference_id, amount, description, customer_phone }) {
    assertReference(reference_id);
    assertAmount(amount);
    if (typeof description !== 'string' || !description.trim()) throw new TypeError('description is required');
    if (typeof customer_phone !== 'string' || !/^\+[1-9]\d{7,14}$/.test(customer_phone)) {
      throw new TypeError('customer_phone must be normalized E.164');
    }
    const entity = await requestJson('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        currency: 'INR',
        accept_partial: false,
        reference_id,
        description: description.trim(),
        customer: { contact: customer_phone },
        notify: { sms: false, email: false },
        reminder_enable: false,
      }),
    });
    validatePaymentLink(entity, { referenceId: reference_id, amount, allowedStatuses: ['created'] });
    if (typeof entity.short_url !== 'string' || !/^https:\/\//.test(entity.short_url)) {
      throw new ProviderResponseError('Razorpay Payment Link response lacks a secure short_url');
    }
    return entity;
  }

  async function getPaymentLinksByReferenceId(referenceId) {
    assertReference(referenceId);
    const data = await requestJson(
      `https://api.razorpay.com/v1/payment_links?reference_id=${encodeURIComponent(referenceId)}`,
      { method: 'GET' }
    );
    if (!Array.isArray(data.payment_links)) {
      throw new ProviderResponseError('Razorpay list response lacks payment_links array');
    }
    if (data.payment_links.some(link => link?.reference_id !== referenceId)) {
      throw new ProviderResponseError('Razorpay returned a Payment Link for another reference_id');
    }
    return data.payment_links;
  }

  async function getPaymentLink(paymentLinkId) {
    assertPaymentLinkId(paymentLinkId);
    return requestJson(
      `https://api.razorpay.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}`,
      { method: 'GET' }
    );
  }

  async function cancelPaymentLink(paymentLinkId) {
    assertPaymentLinkId(paymentLinkId);
    let entity;
    try {
      entity = await requestJson(
        `https://api.razorpay.com/v1/payment_links/${encodeURIComponent(paymentLinkId)}/cancel`,
        { method: 'POST' }
      );
    } catch (error) {
      const description = error.providerBody?.error?.description;
      if (typeof description === 'string' && description.toLowerCase().includes('paid')) {
        error.code = 'PAYMENT_LINK_ALREADY_PAID';
      }
      throw error;
    }
    if (entity.id !== paymentLinkId || entity.status !== 'cancelled' || entity.amount_paid !== 0) {
      throw new ProviderResponseError('Razorpay did not confirm an unpaid Payment Link cancellation');
    }
    return entity;
  }

  async function createRefund({ paymentId, amount, idempotencyKey }) {
    assertPaymentId(paymentId);
    assertAmount(amount);
    assertIdempotencyKey(idempotencyKey);
    const entity = await requestJson(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Refund-Idempotency': idempotencyKey,
        },
        body: JSON.stringify({ amount }),
      }
    );
    return validateRefundResponse(entity, { paymentId, amount });
  }

  async function getRefund({ paymentId, refundId, amount = null }) {
    assertPaymentId(paymentId);
    assertRefundId(refundId);
    if (amount !== null) assertAmount(amount);
    const entity = await requestJson(
      `https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refunds/${encodeURIComponent(refundId)}`,
      { method: 'GET' }
    );
    return validateRefundResponse(entity, { paymentId, refundId, amount });
  }

  return {
    assertConfigured,
    createPaymentLink,
    getPaymentLinksByReferenceId,
    getPaymentLink,
    cancelPaymentLink,
    createRefund,
    getRefund,
  };
}

function validatePaymentLink(link, { referenceId, amount, allowedStatuses = ['created', 'paid'] }) {
  if (!link || typeof link !== 'object') throw new ProviderResponseError('Invalid Payment Link candidate');
  assertPaymentLinkId(link.id);
  if (link.reference_id !== referenceId) throw new ProviderResponseError('Payment Link reference_id mismatch');
  if (link.currency !== 'INR') throw new ProviderResponseError('Payment Link currency mismatch');
  if (link.amount !== amount) throw new ProviderResponseError('Payment Link amount mismatch');
  if (link.accept_partial !== false) throw new ProviderResponseError('Payment Link allows partial payment');
  if (!allowedStatuses.includes(link.status)) throw new ProviderResponseError('Payment Link status is not reusable');
  if (link.status === 'paid' && link.amount_paid !== amount) {
    throw new ProviderResponseError('Paid Payment Link amount_paid mismatch');
  }
  if (link.status === 'created' && ![0, undefined].includes(link.amount_paid)) {
    throw new ProviderResponseError('Unpaid Payment Link has a paid amount');
  }
  return link;
}

function assertPaymentLinkId(id) {
  if (typeof id !== 'string' || !/^plink_[A-Za-z0-9]+$/.test(id)) {
    throw new TypeError('Invalid Razorpay Payment Link ID');
  }
}

function assertReference(referenceId) {
  if (
    typeof referenceId !== 'string' ||
    !referenceId ||
    referenceId !== referenceId.trim() ||
    referenceId.length > 40
  ) {
    throw new TypeError('reference_id must be a non-empty string of at most 40 characters');
  }
}

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('amount must be positive integer paise');
}

function assertPaymentId(id) {
  if (typeof id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(id)) {
    throw new TypeError('Invalid Razorpay Payment ID');
  }
}

function assertRefundId(id) {
  if (typeof id !== 'string' || !/^rfnd_[A-Za-z0-9]+$/.test(id) || id.length < 10) {
    throw new TypeError('Invalid Razorpay Refund ID');
  }
}

function assertIdempotencyKey(key) {
  if (typeof key !== 'string' || !key.trim() || key.length < 10) {
    throw new TypeError('idempotencyKey must be a non-empty string of at least 10 characters');
  }
}

function validateRefundResponse(refund, { paymentId, amount = null, refundId = null } = {}) {
  if (!refund || typeof refund !== 'object' || Array.isArray(refund)) {
    throw new ProviderResponseError('Invalid refund response shape');
  }
  if (refund.entity !== 'refund') {
    throw new ProviderResponseError('Refund response entity mismatch');
  }
  if (typeof refund.id !== 'string' || !/^rfnd_[A-Za-z0-9]+$/.test(refund.id) || refund.id.length < 10) {
    throw new ProviderResponseError('Refund response id is invalid');
  }
  if (refundId !== null && refund.id !== refundId) {
    throw new ProviderResponseError('Refund response id does not match requested refund ID');
  }
  if (refund.payment_id !== paymentId) {
    throw new ProviderResponseError('Refund response payment_id mismatch');
  }
  if (!Number.isSafeInteger(refund.amount) || refund.amount <= 0) {
    throw new ProviderResponseError('Refund response amount is not a positive safe integer');
  }
  if (amount !== null && refund.amount !== amount) {
    throw new ProviderResponseError('Refund response amount mismatch');
  }
  if (!['pending', 'processed', 'failed'].includes(refund.status)) {
    throw new ProviderResponseError('Refund response status is invalid');
  }
  if ('currency' in refund && typeof refund.currency !== 'string') {
    throw new ProviderResponseError('Refund response currency must be a string if present');
  }
  return refund;
}

function parseJson(raw) {
  try { return JSON.parse(raw); } catch { return null; }
}

let defaultClient;
function getDefaultClient() {
  if (!defaultClient) defaultClient = createRazorpayClient();
  return defaultClient;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  ProviderResponseError,
  createRazorpayClient,
  validatePaymentLink,
  validateRefundResponse,
  assertConfigured: (...args) => getDefaultClient().assertConfigured(...args),
  createPaymentLink: (...args) => getDefaultClient().createPaymentLink(...args),
  getPaymentLinksByReferenceId: (...args) => getDefaultClient().getPaymentLinksByReferenceId(...args),
  getPaymentLink: (...args) => getDefaultClient().getPaymentLink(...args),
  cancelPaymentLink: (...args) => getDefaultClient().cancelPaymentLink(...args),
  createRefund: (...args) => getDefaultClient().createRefund(...args),
  getRefund: (...args) => getDefaultClient().getRefund(...args),
};
