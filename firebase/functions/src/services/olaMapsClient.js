'use strict';

const { randomUUID } = require('node:crypto');
const { validCoords, finiteNonnegative } = require('../dispatch/dispatchValidation');

class OlaProviderError extends Error {
  constructor(code, { status = 500, retryable = false, degradedAllowed = false } = {}) {
    super(code);
    this.name = 'OlaProviderError';
    this.status = status;
    this.retryable = retryable;
    this.degradedAllowed = degradedAllowed;
    this.code = code;
  }
}

function createOlaMapsClient({
  fetchImpl = globalThis.fetch, apiKey = process.env.OLA_MAPS_API_KEY,
  baseUrl = 'https://api.olamaps.io/routing/v1/distanceMatrix',
  timeoutMs = 5000, maxRetries = 2, backoffMs = 250,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  async function getDistanceMatrix({ origins, destinations, authorizeAttempt }) {
    if (!Array.isArray(origins) || !origins.length || !Array.isArray(destinations) || !destinations.length) {
      throw new TypeError('Nonempty origins and destinations are required');
    }
    if (![...origins, ...destinations].every(validCoords)) throw new RangeError('Invalid matrix coordinates');
    if (typeof authorizeAttempt !== 'function') throw new OlaProviderError('OLA_AUTHORIZATION_MISSING');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647 ||
        !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10 ||
        !Number.isSafeInteger(backoffMs) || backoffMs < 0 || backoffMs * 2 ** maxRetries > 2147483647) {
      throw new OlaProviderError('OLA_CONFIG_INVALID');
    }
    const url = new URL(baseUrl);
    url.searchParams.set('origins', origins.map(c => `${c.lat},${c.lng}`).join('|'));
    url.searchParams.set('destinations', destinations.map(c => `${c.lat},${c.lng}`).join('|'));
    if (!apiKey || typeof apiKey !== 'string') throw new OlaProviderError('OLA_API_KEY_MISSING');
    url.searchParams.set('api_key', apiKey);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt) await sleep(backoffMs * 2 ** (attempt - 1));
      // Authorization errors deliberately escape the provider retry/degrade catch.
      const authorization = await authorizeAttempt({ plannedPairs: origins.length * destinations.length });
      if (authorization?.authorized !== true) {
        if (authorization?.authorized === false && ['CAP_EXCEEDED', 'OLA_DISABLED'].includes(authorization.reason)) {
          throw new OlaProviderError(authorization.reason, { degradedAllowed: true });
        }
        throw new OlaProviderError('OLA_AUTHORIZATION_FAILED');
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(url.toString(), {
          method: 'GET', signal: controller.signal, redirect: 'manual',
          headers: { Accept: 'application/json', 'X-Request-Id': randomUUID() },
        });
        if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
          throw new OlaProviderError('OLA_MALFORMED_RESPONSE');
        }
        if (!response.ok) {
          const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
          throw new OlaProviderError(response.status === 429 ? 'OLA_RATE_LIMITED' : 'OLA_HTTP_ERROR', {
            status: response.status, retryable,
          });
        }
        if (response.status !== 200) throw new OlaProviderError('OLA_MALFORMED_RESPONSE');
        let body;
        try { body = await response.json(); }
        catch (error) {
          if (error?.name === 'AbortError' || transientNetwork(error)) throw error;
          throw new OlaProviderError('OLA_MALFORMED_RESPONSE');
        }
        return parseDistanceMatrixResponse(body, origins.length, destinations.length);
      } catch (error) {
        let providerError = error;
        if (error?.name === 'AbortError') providerError = new OlaProviderError('OLA_TIMEOUT', { status: 504, retryable: true });
        else if (transientNetwork(error)) providerError = new OlaProviderError('OLA_NETWORK_ERROR', { retryable: true });
        if (!(providerError instanceof OlaProviderError)) throw new OlaProviderError('OLA_LOCAL_ERROR');
        if (!providerError.retryable) throw providerError;
        if (attempt === maxRetries) {
          providerError.degradedAllowed = true;
          throw providerError;
        }
      } finally { clearTimeout(timer); }
    }
    throw new OlaProviderError('OLA_LOCAL_ERROR');
  }
  return { getDistanceMatrix };
}

function transientNetwork(error) {
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']
    .includes(error?.cause?.code || error?.code);
}

function parseDistanceMatrixResponse(data, expectedOrigins, expectedDestinations) {
  const malformed = () => { throw new OlaProviderError('OLA_MALFORMED_RESPONSE', { status: 502 }); };
  if (!data || Array.isArray(data) || (data.status !== undefined && data.status !== 'OK') ||
      !Array.isArray(data.rows) || data.rows.length !== expectedOrigins) malformed();
  return data.rows.map(row => {
    if (!row || !Array.isArray(row.elements) || row.elements.length !== expectedDestinations) malformed();
    return row.elements.map(element => {
      if (!element || element.status !== 'OK') malformed();
      const durationSeconds = typeof element.duration === 'object' ? element.duration?.value : element.duration;
      const distanceMeters = typeof element.distance === 'object' ? element.distance?.value : element.distance;
      if (!finiteNonnegative(durationSeconds) || !finiteNonnegative(distanceMeters)) malformed();
      return { status: 'OK', durationSeconds, distanceMeters };
    });
  });
}

module.exports = { OlaProviderError, createOlaMapsClient, parseDistanceMatrixResponse };
