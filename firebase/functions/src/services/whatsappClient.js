'use strict';

const { requireEnv } = require('../utils/env');

const DEFAULT_TIMEOUT_MS = 10000;

function createWhatsAppClient({
  fetchImpl = globalThis.fetch,
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  function configuration() {
    const token = requireEnv('WHATSAPP_ACCESS_TOKEN', env);
    const phoneNumberId = requireEnv('WHATSAPP_PHONE_NUMBER_ID', env);
    const graphVersion = requireEnv('WHATSAPP_GRAPH_API_VERSION', env);
    if (!/^v\d+\.\d+$/.test(graphVersion)) throw new Error('Invalid WHATSAPP_GRAPH_API_VERSION');
    return { token, phoneNumberId, graphVersion };
  }

  async function request(path, options) {
    const { token, phoneNumberId, graphVersion } = configuration();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(
        `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/${path}`,
        {
          ...options,
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
        }
      );
      const raw = await response.text();
      if (!response.ok) throw new Error(`WhatsApp API error: ${response.status} ${raw}`);
      try { return JSON.parse(raw); } catch { throw new Error('WhatsApp API returned invalid JSON'); }
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('WhatsApp request timed out');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async function sendMessage(to, messagePayload) {
    const recipient = toWhatsAppRecipient(to);
    if (!messagePayload || typeof messagePayload !== 'object' || Array.isArray(messagePayload)) {
      throw new TypeError('Message payload is required');
    }
    const data = await request('messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...messagePayload,
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: recipient,
      }),
    });
    const messageId = data?.messages?.[0]?.id;
    if (typeof messageId !== 'string' || !messageId) {
      throw new Error('WhatsApp API did not accept the outbound message');
    }
    return { messageId, response: data };
  }

  async function sendText(to, body) {
    if (typeof body !== 'string' || !body.trim()) throw new TypeError('Message body is required');
    return sendMessage(to, { type: 'text', text: { body: body.trim() } });
  }

  async function sendAuthenticationTemplate(to, otp, template) {
    if (typeof otp !== 'string' || !/^\d{6}$/.test(otp)) {
      throw new TypeError('Authentication OTP must be a 6-digit string');
    }
    const templateName = template?.templateName;
    const languageCode = template?.languageCode;
    if (
      typeof templateName !== 'string' ||
      templateName.length > 512 ||
      !/^[a-z0-9_]+$/.test(templateName) ||
      typeof languageCode !== 'string' ||
      !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(languageCode)
    ) {
      throw new TypeError('Approved WhatsApp authentication template configuration is required');
    }
    return sendMessage(to, {
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: 'body',
            parameters: [{ type: 'text', text: otp }],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: '0',
            parameters: [{ type: 'text', text: otp }],
          },
        ],
      },
    });
  }

  async function uploadDocument(buffer, filename, mimeType = 'application/pdf') {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new TypeError('Document buffer is required');
    if (typeof filename !== 'string' || !filename.trim()) throw new TypeError('filename is required');
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mimeType);
    form.set('file', new Blob([buffer], { type: mimeType }), filename);
    const data = await request('media', { method: 'POST', body: form });
    if (typeof data?.id !== 'string' || !data.id) throw new Error('WhatsApp media upload was not accepted');
    return data.id;
  }

  async function sendDocumentByMediaId(to, mediaId, filename, caption = '') {
    if (typeof mediaId !== 'string' || !mediaId) throw new TypeError('mediaId is required');
    return sendMessage(to, {
      type: 'document',
      document: { id: mediaId, filename, ...(caption ? { caption } : {}) },
    });
  }

  return { sendMessage, sendText, sendAuthenticationTemplate, uploadDocument, sendDocumentByMediaId };
}

function toWhatsAppRecipient(value) {
  if (typeof value !== 'string' || !/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new TypeError('Recipient must be normalized E.164');
  }
  return value.slice(1);
}

let defaultClient;
function getDefaultClient() {
  if (!defaultClient) defaultClient = createWhatsAppClient();
  return defaultClient;
}

module.exports = {
  createWhatsAppClient,
  sendMessage: (...args) => getDefaultClient().sendMessage(...args),
  sendText: (...args) => getDefaultClient().sendText(...args),
  sendAuthenticationTemplate: (...args) => getDefaultClient().sendAuthenticationTemplate(...args),
  uploadDocument: (...args) => getDefaultClient().uploadDocument(...args),
  sendDocumentByMediaId: (...args) => getDefaultClient().sendDocumentByMediaId(...args),
};
