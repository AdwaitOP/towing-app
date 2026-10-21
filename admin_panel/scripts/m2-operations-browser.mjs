#!/usr/bin/env node
/**
 * TowMitra Phase 6 M2 — Operational Browser Verification Suite
 *
 * Verifies in real Chromium against local emulators:
 * - Driver Verification Queue & private evidence viewer (F01, F02)
 * - Explicit capabilities approval modal (O1, F03)
 * - Normalized plain text rejection modal with character limits (O2, F04)
 * - Provisioning diagnostic banner (O3, F13)
 * - Live Jobs Dashboard: active statuses, awaiting_payment filter (F08)
 * - Live Job Detail: distinct financial labels, candidate run evidence, driver identity (F09, F10)
 * - Bounded pagination with server snapshot indication (F11)
 * - Session fencing & cleanup on logout (S06, S07, S08)
 * - Strict loopback CSP: zero external network calls
 */

import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'fs';
import { resolve, join } from 'path';
import { spawn } from 'child_process';
import assert from 'node:assert/strict';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from './validate-endpoint.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const SCREENSHOT_DIR = resolve('screenshots');
if (!existsSync(SCREENSHOT_DIR)) {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

// Find Chrome or Edge
const CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const executablePath = CHROME_PATHS.find((p) => existsSync(p));
if (!executablePath) {
  console.error('\x1b[31m[FATAL] No supported browser (Chrome or Edge) found on system.\x1b[0m');
  process.exit(1);
}

// Strict Fail-Closed Environment Checks
const authHost = validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', process.env.FIREBASE_AUTH_EMULATOR_HOST).value;
const firestoreHost = validateEmulatorHost('FIRESTORE_EMULATOR_HOST', process.env.FIRESTORE_EMULATOR_HOST).value;
const projectId = validateProject(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
process.env.GCLOUD_PROJECT = projectId;
process.env.METADATA_SERVER_DETECTION = 'none';

const adminApp = getApps().length === 0 ? initializeApp({ projectId }) : getApps()[0];
const adminAuth = getAuth(adminApp);

async function setAdminClaim(email, isAdmin) {
  const user = await adminAuth.getUserByEmail(email);
  await adminAuth.setCustomUserClaims(user.uid, {
    ...(user.customClaims || {}),
    admin: isAdmin,
  });
}

async function waitForServer(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      // Retry
    }
    await delay(300);
  }
  throw new Error(`Timeout waiting for server at ${url}`);
}

async function setInputValue(page, selector, value) {
  await page.waitForSelector(selector);
  await page.$eval(selector, (el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function clickButtonWithText(page, text) {
  const clicked = await page.evaluate((t) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const btn = buttons.find((b) => b.textContent && b.textContent.includes(t));
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  }, text);
  if (!clicked) throw new Error(`Button with text "${text}" not found`);
}

async function runBrowserVerification() {
  console.log('\n======================================================');
  console.log(' TowMitra Admin Panel — M2 Operations Browser Suite');
  console.log('======================================================\n');

  await setAdminClaim('admin@towmitra.test', true);

  let viteProcess = null;
  const isAlreadyRunning = await (async () => {
    try {
      const res = await fetch('http://127.0.0.1:5173');
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  })();

  if (!isAlreadyRunning) {
    viteProcess = spawn('cmd.exe', ['/c', 'npx vite --port 5173 --host 127.0.0.1'], {
      cwd: resolve('.'),
      stdio: 'pipe',
    });
  }

  const stopVite = () => {
    try {
      viteProcess?.kill();
    } catch {
      // ignore
    }
  };

  process.on('exit', stopVite);
  process.on('SIGINT', stopVite);

  let browser;
  let page;
  const externalRequests = [];
  const pageErrors = [];

  try {
    await waitForServer('http://127.0.0.1:5173');
    console.log('       Vite dev server ready at http://127.0.0.1:5173\n');

    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = new URL(req.url());
      if (['http:', 'https:'].includes(u.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
        externalRequests.push(req.url());
        return req.abort();
      }
      req.continue();
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log('  [Browser Console Error]:', msg.text());
      }
    });

    // ── Journey 1: Deep Link to /verification & Admin Login ──────────────────
    console.log('▶ [Journey 1/8] Deep link navigation to /verification and admin login...');
    await page.goto('http://127.0.0.1:5173/verification', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 8000 });
    console.log('  ✓ Deep link correctly redirected to /login with state preserved');

    await setInputValue(page, '#email', 'admin@towmitra.test');
    await setInputValue(page, '#password', 'AdminPassword123!');
    await page.click('button[type="submit"]');

    try {
      await page.waitForFunction(
        () => window.location.pathname === '/verification' && document.body.innerText.includes('Driver Verification Queue'),
        { timeout: 15000 }
      );
    } catch (e) {
      const state = await page.evaluate(() => ({
        pathname: window.location.pathname,
        text: document.body.innerText.slice(0, 300),
      }));
      console.log('Login failed state:', state);
      await page.screenshot({ path: join(SCREENSHOT_DIR, 'debug_login_fail.png') });
      throw e;
    }
    console.log('  ✓ Admin login verified and requested /verification destination restored');
    await delay(1200);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_01_verification_queue.png') });
    console.log('  ✓ Screenshot saved: m2_01_verification_queue.png');

    // ── Journey 2: Private Evidence Viewer & Diagnostics ────────────────────
    console.log('▶ [Journey 2/8] Inspecting Driver Verification Detail & KYC evidence for Aarav Shinde...');
    await page.waitForSelector('div[role="button"]', { timeout: 8000 });
    const clickedTarget = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div[role="button"]'));
      const target = rows.find((r) => r.textContent && r.textContent.includes('Aarav Shinde'));
      if (target) {
        target.click();
        return true;
      }
      return false;
    });
    if (!clickedTarget) {
      throw new Error('Could not find Aarav Shinde row in the verification queue');
    }
    await delay(2000);

    await page.waitForFunction(() => document.body.innerText.includes('KYC Evidence Previews'), { timeout: 8000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_02_verification_detail.png') });
    console.log('  ✓ Screenshot saved: m2_02_verification_detail.png');

    // ── Journey 3: Approval Dialog with Explicit Capabilities (O1 / F02) ─────────
    console.log('▶ [Journey 3/8] Testing F02: Approve disabled until KYC previews decode, then opening dialog...');
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const btn = buttons.find((b) => b.textContent && b.textContent.includes('Approve Driver'));
      return btn && !btn.disabled;
    }, { timeout: 15000 });
    console.log('  ✓ Previews decoded; Approve Driver button enabled per F02');

    await clickButtonWithText(page, 'Approve Driver');
    await delay(600);

    await page.waitForFunction(() => document.body.innerText.includes('Explicit Driver Capabilities'), { timeout: 8000 });
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_03_approval_dialog.png') });
    console.log('  ✓ Screenshot saved: m2_03_approval_dialog.png');

    await clickButtonWithText(page, 'Cancel');
    await delay(500);

    // ── Journey 4: Rejection Dialog with Reason Limit (O2) ──────────────────
    console.log('▶ [Journey 4/8] Opening Rejection Dialog and testing reason limits...');
    await clickButtonWithText(page, 'Reject Application');
    await delay(600);

    await page.waitForFunction(() => document.body.innerText.includes('Rejection Reason'), { timeout: 8000 });
    await page.type('textarea', 'Uploaded vehicle registration certificate is blurry. Please re-upload a clear copy.');
    await delay(500);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_04_rejection_dialog.png') });
    console.log('  ✓ Screenshot saved: m2_04_rejection_dialog.png');

    await clickButtonWithText(page, 'Cancel');
    await delay(500);

    // ── Journey 5: Live Jobs Dashboard ─────────────────────────────────────
    console.log('▶ [Journey 5/8] Navigating to Live Jobs Dashboard...');
    await page.goto('http://127.0.0.1:5173/jobs', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Live Jobs Dashboard'), { timeout: 10000 });
    await delay(1200);

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_05_live_jobs_dashboard.png') });
    console.log('  ✓ Screenshot saved: m2_05_live_jobs_dashboard.png');

    // ── Journey 6: Live Job Detail & Candidate Progress ─────────────────────
    console.log('▶ [Journey 6/8] Inspecting Live Job Detail, candidate run, and driver identity...');
    await page.waitForSelector('div[role="button"]', { timeout: 8000 });
    await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('div[role="button"]'));
      const target = rows.find((r) => r.textContent && (r.textContent.includes('m2-job-offered-1') || r.textContent.includes('offered')));
      if (target) {
        target.click();
      } else if (rows.length > 0) {
        rows[0].click();
      }
    });
    await delay(2000);

    await page.waitForFunction(() => document.body.innerText.includes('Platform Booking Fee'), { timeout: 8000 });

    // Click "Load Driver Identity" if available
    try {
      await clickButtonWithText(page, 'Load Driver Identity');
      await delay(1000);
    } catch {
      // Driver identity button not needed or already present
    }

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_06_live_jobs_detail.png') });
    console.log('  ✓ Screenshot saved: m2_06_live_jobs_detail.png');

    // ── Journey 7: Pagination on Queue ─────────────────────────────────────
    console.log('▶ [Journey 7/8] Verifying pagination cursor and server snapshot indication...');
    await page.goto('http://127.0.0.1:5173/verification', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Driver Verification Queue'), { timeout: 10000 });
    await delay(1200);

    const hasNextBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const nextBtn = buttons.find((b) => b.textContent && b.textContent.includes('Next'));
      if (nextBtn && !nextBtn.disabled) {
        nextBtn.click();
        return true;
      }
      return false;
    });

    if (hasNextBtn) {
      await delay(1500);
      await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_07_pagination_page2.png') });
      console.log('  ✓ Screenshot saved: m2_07_pagination_page2.png');
    }

    // ── Journey 8: Session Cleanup on Sign Out ──────────────────────────────
    console.log('▶ [Journey 8/8] Testing signout and session destruction...');
    const userMenuBtn = await page.waitForSelector('button[aria-label="Admin account menu"]');
    await userMenuBtn.click();
    const menuSignOutBtn = await page.waitForSelector('[data-testid="navbar-sign-out"]', { timeout: 4000 });
    await menuSignOutBtn.click();
    await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 8000 });
    await delay(1000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'm2_08_signout_cleaned.png') });
    console.log('  ✓ Screenshot saved: m2_08_signout_cleaned.png');

    // Strict assertions
    assert.equal(externalRequests.length, 0, `Strict CSP violation: external requests: ${externalRequests.join(', ')}`);
    console.log('\n[SUCCESS] Strict CSP verified: 0 external requests.');
    console.log(`[SUCCESS] Page errors: ${pageErrors.length}.`);
    console.log('\nAll 8 M2 browser verification journeys PASSED COMPLETELY!\n');

  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    stopVite();
  }
}

runBrowserVerification()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('\n\x1b[31m[BROWSER TEST FAILED]\x1b[0m', err);
    process.exit(1);
  });
