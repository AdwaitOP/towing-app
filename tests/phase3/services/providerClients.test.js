'use strict';

require('../fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createRazorpayClient,
  ProviderResponseError,
} = require('../../../firebase/functions/src/services/razorpayClient');
const { createWhatsAppClient } = require('../../../firebase/functions/src/services/whatsappClient');

function response(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

const razorEnv = { RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'secret' };
const whatsAppEnv = {
  WHATSAPP_ACCESS_TOKEN: 'meta-token',
  WHATSAPP_PHONE_NUMBER_ID: '123456789',
  WHATSAPP_GRAPH_API_VERSION: 'v99.0',
};

test('Razorpay list client consumes the official payment_links response shape', async () => {
  const fetchImpl = async () => response(200, { payment_links: [{ reference_id: 'job-1', id: 'plink_A1' }] });
  const client = createRazorpayClient({ fetchImpl, env: razorEnv });
  assert.deepEqual(await client.getPaymentLinksByReferenceId('job-1'), [
    { reference_id: 'job-1', id: 'plink_A1' },
  ]);
});

test('Razorpay list client rejects the obsolete items mock shape', async () => {
  const fetchImpl = async () => response(200, { items: [] });
  const client = createRazorpayClient({ fetchImpl, env: razorEnv });
  await assert.rejects(client.getPaymentLinksByReferenceId('job-1'), ProviderResponseError);
});

test('Razorpay list client rejects candidates returned for another reference', async () => {
  const fetchImpl = async () => response(200, {
    payment_links: [{ reference_id: 'different-job', id: 'plink_A1' }],
  });
  const client = createRazorpayClient({ fetchImpl, env: razorEnv });
  await assert.rejects(client.getPaymentLinksByReferenceId('job-1'), /another reference_id/);
});

test('Razorpay Payment Link creation sends booking fee only and validates response', async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return response(200, {
      id: 'plink_A1', reference_id: 'job-1', amount: 50000, amount_paid: 0,
      currency: 'INR', accept_partial: false, status: 'created', short_url: 'https://rzp.io/i/abc',
    });
  };
  const client = createRazorpayClient({ fetchImpl, env: razorEnv });
  await client.createPaymentLink({
    reference_id: 'job-1', amount: 50000, description: 'Booking fee', customer_phone: '+919876543210',
  });
  const body = JSON.parse(request.options.body);
  assert.equal(request.options.method, 'POST');
  assert.equal(body.amount, 50000);
  assert.equal(body.currency, 'INR');
  assert.equal(body.accept_partial, false);
  assert.equal(body.reference_id, 'job-1');
  assert.equal(body.customer.contact, '+919876543210');
  assert.equal('order_id' in body, false);
});

test('Razorpay Payment Link creation rejects malformed customer phones before network I/O', async () => {
  let calls = 0;
  const client = createRazorpayClient({
    env: razorEnv,
    fetchImpl: async () => { calls += 1; return response(200, {}); },
  });
  await assert.rejects(client.createPaymentLink({
    reference_id: 'job-1', amount: 50000, description: 'Booking fee', customer_phone: '+91-not-a-phone',
  }), /normalized E.164/);
  assert.equal(calls, 0);
});

test('Razorpay getPaymentLink uses the official entity path and GET method', async () => {
  let request;
  const client = createRazorpayClient({
    env: razorEnv,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { id: 'plink_A1', status: 'created' });
    },
  });
  const entity = await client.getPaymentLink('plink_A1');
  assert.equal(entity.id, 'plink_A1');
  assert.equal(request.url, 'https://api.razorpay.com/v1/payment_links/plink_A1');
  assert.equal(request.options.method, 'GET');
  assert.match(request.options.headers.Authorization, /^Basic /);
});

test('Razorpay cancelPaymentLink uses the cancel path and requires confirmed unpaid cancellation', async () => {
  let request;
  const client = createRazorpayClient({
    env: razorEnv,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response(200, { id: 'plink_A1', status: 'cancelled', amount_paid: 0 });
    },
  });
  const entity = await client.cancelPaymentLink('plink_A1');
  assert.equal(entity.status, 'cancelled');
  assert.equal(request.url, 'https://api.razorpay.com/v1/payment_links/plink_A1/cancel');
  assert.equal(request.options.method, 'POST');

  const contradictory = createRazorpayClient({
    env: razorEnv,
    fetchImpl: async () => response(200, { id: 'plink_A1', status: 'cancelled', amount_paid: 50000 }),
  });
  await assert.rejects(contradictory.cancelPaymentLink('plink_A1'), ProviderResponseError);
});

test('Razorpay client fails closed on missing credentials and timeout', async () => {
  const missing = createRazorpayClient({ fetchImpl: async () => response(200, {}), env: {} });
  await assert.rejects(missing.getPaymentLinksByReferenceId('job-1'), /RAZORPAY_KEY_ID/);
  const timed = createRazorpayClient({
    env: razorEnv,
    timeoutMs: 5,
    fetchImpl: (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  await assert.rejects(timed.getPaymentLinksByReferenceId('job-1'), /timed out/);
});

test('Razorpay client rejects references outside the provider contract before network I/O', async () => {
  let calls = 0;
  const client = createRazorpayClient({
    env: razorEnv,
    fetchImpl: async () => { calls += 1; return response(200, { payment_links: [] }); },
  });
  await assert.rejects(client.getPaymentLinksByReferenceId('x'.repeat(41)), /at most 40/);
  await assert.rejects(client.getPaymentLinksByReferenceId(' job-1'), /at most 40/);
  assert.equal(calls, 0);
});

test('WhatsApp text send requires configuration and an accepted message ID', async () => {
  const missing = createWhatsAppClient({ fetchImpl: async () => response(200, {}), env: {} });
  await assert.rejects(missing.sendText('+919876543210', 'hello'), /WHATSAPP_ACCESS_TOKEN/);
  const invalid = createWhatsAppClient({ fetchImpl: async () => response(200, {}), env: whatsAppEnv });
  await assert.rejects(invalid.sendText('+919876543210', 'hello'), /did not accept/);
});

test('WhatsApp converts canonical E.164 to Meta international digits at the provider boundary', async () => {
  let outbound;
  const client = createWhatsAppClient({
    env: whatsAppEnv,
    fetchImpl: async (_url, options) => {
      outbound = JSON.parse(options.body);
      return response(200, { messages: [{ id: 'wamid.outbound' }] });
    },
  });
  await client.sendText('+919876543210', 'hello');
  assert.equal(outbound.to, '919876543210');
  await assert.rejects(client.sendText('919876543210', 'hello'), /normalized E.164/);
});

test('WhatsApp authentication OTP uses the official template component payload', async () => {
  let outbound;
  const client = createWhatsAppClient({
    env: whatsAppEnv,
    fetchImpl: async (_url, options) => {
      outbound = JSON.parse(options.body);
      return response(200, { messages: [{ id: 'wamid.auth' }] });
    },
  });
  const accepted = await client.sendAuthenticationTemplate('+919876543210', '123456', {
    templateName: 'driver_login_auth',
    languageCode: 'en_US',
  });
  assert.equal(accepted.messageId, 'wamid.auth');
  assert.deepEqual(outbound, {
    type: 'template',
    template: {
      name: 'driver_login_auth',
      language: { code: 'en_US' },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: '123456' }] },
        {
          type: 'button', sub_type: 'url', index: '0',
          parameters: [{ type: 'text', text: '123456' }],
        },
      ],
    },
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '919876543210',
  });
});

test('WhatsApp authentication OTP rejects invalid template configuration before network I/O', async () => {
  let calls = 0;
  const client = createWhatsAppClient({
    env: whatsAppEnv,
    fetchImpl: async () => { calls += 1; return response(200, {}); },
  });
  await assert.rejects(
    client.sendAuthenticationTemplate('+919876543210', '123456', { templateName: '', languageCode: '' }),
    /template configuration/
  );
  assert.equal(calls, 0);
});

test('WhatsApp invoice delivery uploads private bytes then sends a media ID', async () => {
  const calls = [];
  const responses = [response(200, { id: 'media-1' }), response(200, { messages: [{ id: 'wamid.outbound' }] })];
  const client = createWhatsAppClient({
    env: whatsAppEnv,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); },
  });
  const mediaId = await client.uploadDocument(Buffer.from('%PDF'), 'Invoice_TDS-0001.pdf');
  const accepted = await client.sendDocumentByMediaId(
    '+919876543210', mediaId, 'Invoice_TDS-0001.pdf', 'Invoice'
  );
  assert.equal(mediaId, 'media-1');
  assert.equal(accepted.messageId, 'wamid.outbound');
  assert.match(calls[0].url, /\/media$/);
  const outbound = JSON.parse(calls[1].options.body);
  assert.equal(outbound.to, '919876543210');
  assert.equal(outbound.document.id, 'media-1');
  assert.equal('link' in outbound.document, false);
});
