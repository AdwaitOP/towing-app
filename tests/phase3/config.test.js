'use strict';

require('./fakeDeps');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../../');
const functionsRoot = path.join(root, 'firebase/functions');

test('Phase 3 entry point loads and exports all HTTP handlers', () => {
  const exported = require('../../firebase/functions/src/index');
  for (const name of ['whatsappWebhook', 'driverOtpSend', 'driverOtpVerify', 'razorpayWebhook']) {
    assert.equal(typeof exported[name], 'function', `${name} must be exported`);
  }
});

test('Secret Manager bindings and env example use one canonical name per secret', () => {
  const index = fs.readFileSync(path.join(functionsRoot, 'src/index.js'), 'utf8');
  const example = fs.readFileSync(path.join(functionsRoot, '.env.example'), 'utf8');
  for (const name of [
    'WHATSAPP_APP_SECRET', 'WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_ACCESS_TOKEN',
    'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET', 'OTP_PEPPER',
  ]) {
    assert.match(index, new RegExp(`['\"]${name}['\"]`));
    assert.match(example, new RegExp(`^${name}=`, 'm'));
  }
  for (const obsolete of ['META_APP_SECRET', 'META_VERIFY_TOKEN', 'WHATSAPP_TOKEN']) {
    assert.doesNotMatch(index, new RegExp(obsolete));
    assert.doesNotMatch(example, new RegExp(`^${obsolete}=`, 'm'));
  }
});

test('production source contains no known secret fallback literals', () => {
  const sourceRoot = path.join(functionsRoot, 'src');
  const files = walk(sourceRoot).filter(file => file.endsWith('.js'));
  const combined = files.map(file => fs.readFileSync(file, 'utf8')).join('\n');
  assert.doesNotMatch(combined, /test-secret|test-verify-token|default-pepper-for-tests/);
});

test('package lock root dependency contract matches package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(functionsRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(functionsRoot, 'package-lock.json'), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);
  assert.deepEqual(lock.packages[''].engines, packageJson.engines);
});

test('OTP authentication template identity is non-secret Firestore configuration and unconfigured in seed', () => {
  const seed = JSON.parse(fs.readFileSync(path.join(root, 'firebase/seed/business_config.json'), 'utf8'));
  const example = fs.readFileSync(path.join(functionsRoot, '.env.example'), 'utf8');
  assert.deepEqual(seed.whatsappOtpTemplate, { templateName: '', languageCode: '' });
  assert.doesNotMatch(example, /^WHATSAPP_OTP_TEMPLATE/m);
  assert.equal(seed._setup_note.includes('OTP_PEPPER remains a Secret Manager secret'), true);
});

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}
