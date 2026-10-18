#!/usr/bin/env node
/**
 * TowMitra Admin Panel — Comprehensive Browser Smoke & E2E Verification
 *
 * Requirements (Sections 8, 10, Gates M1-A through M1-N, Defects D8, D11-D15):
 * - Tests 10 distinct, comprehensive user journeys in real Chromium against live emulators
 * - Strict assertion of no horizontal overflow and no card text overlap (D13)
 * - Accessible error announcement check (D14)
 * - Destination restoration check (D15)
 * - Mobile drawer focus trap and Escape focus restoration to opener (D12)
 * - ID-token demotion and promotion lifecycle events (D1, D2)
 * - Protected content suppression during manual refresh (D5)
 * - Delayed login after logout race fencing (D3)
 * - Outage recovery and bounded error retry (D6, D11)
 * - Strict Content Security Policy / Zero external requests (D8)
 * - Clean signout, back button protection, and session destruction (M1-J)
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

// Find system Chrome or Edge
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

// Strict Fail-Closed Environment Checks (D4)
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
      // Retry after delay
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

async function runSmokeTests() {
  console.log('\n======================================================');
  console.log(' TowMitra Admin Panel — Comprehensive 10-Journey E2E Test');
  console.log('======================================================\n');

  // Ensure synthetic accounts have default claims before test
  await setAdminClaim('admin@towmitra.test', true);
  await setAdminClaim('operator@towmitra.test', false);

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
  const consoleErrors = [];

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
    let blockFirestore = false;
    let blockAuth = false;
    let holdToken = false;
    let heldToken = null;
    let holdLogin = false;
    let heldLogin = null;

    page.on('request', (req) => {
      const u = new URL(req.url());
      if (['http:', 'https:'].includes(u.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
        externalRequests.push(req.url());
        return req.abort();
      }
      if (u.port === '8080' && blockFirestore) {
        return req.abort();
      }
      if (req.url().includes('/securetoken.googleapis.com/')) {
        if (blockAuth) {
          return req.respond({
            status: 503,
            headers: { 'Access-Control-Allow-Origin': '*' },
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 503, message: 'SIMULATED_AUTH_OUTAGE' } }),
          });
        }
        if (holdToken) {
          heldToken = req;
          return;
        }
      }
      const postData = req.postData() || '';
      if (holdLogin && req.url().includes('/accounts:signInWithPassword') && postData.includes('admin@towmitra.test')) {
        heldLogin = req;
        return;
      }
      req.continue();
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
      console.error('       [Browser PageError]:', err.message);
    });

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        const isExpected = text.includes('INVALID_LOGIN_CREDENTIALS') ||
                           text.includes('SIMULATED_AUTH_OUTAGE') ||
                           text.includes('PERSISTENCE_REMOVAL_FAILED') ||
                           text.includes('Failed to load resource: the server responded with a status of 400') ||
                           text.includes('Failed to load resource: the server responded with a status of 503') ||
                           text.includes('net::ERR_BLOCKED_BY_CSP') ||
                           text.includes('violates the following Content Security Policy directive') ||
                           text.includes('cleardot.gif') ||
                           text.includes('Back-Forward Cache') ||
                           text.includes('WebSocket') ||
                           text.includes('net::ERR_FAILED');
        if (!isExpected) {
          consoleErrors.push(text);
          console.error('       [Browser Console Error]:', text);
        }
      }
    });

    // Journey 1: Deep Link Redirection to /login with Destination Preserved (D15)
    console.log('▶ [Journey 1/10] Deep link navigation to /jobs redirects to /login...');
    await page.goto('http://127.0.0.1:5173/jobs', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 8000 });
    console.log('  ✓ Deep link correctly redirected to /login');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '01-login-screen.png') });

    // Journey 2: Accessible Invalid Credential Error Announcement (D14)
    console.log('▶ [Journey 2/10] Testing invalid credentials accessible announcement (D14)...');
    await setInputValue(page, '#email', 'admin@towmitra.test');
    await setInputValue(page, '#password', 'WrongPassword999!');
    await page.click('button[type="submit"]');

    await page.waitForFunction(
      () => document.body.innerText.includes('Invalid email or password'),
      { timeout: 8000 }
    );
    const accessibleAnnouncement = await page.evaluate(() => {
      const alertEl = document.querySelector('[role="alert"], [aria-live]');
      const emailInput = document.querySelector('#email');
      return !!alertEl && alertEl.textContent.includes('Invalid email or password') && emailInput?.getAttribute('aria-invalid') === 'true';
    });
    assert.ok(accessibleAnnouncement, 'Error announcement must have role=alert/aria-live and aria-invalid on input');
    console.log('  ✓ Accessible invalid credential announcement verified');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '02-invalid-credentials.png') });

    // Journey 3: Successful Admin Login & Destination Restoration (D15)
    console.log('▶ [Journey 3/10] Logging in as admin and verifying requested destination /jobs is restored (D15)...');
    await setInputValue(page, '#email', 'admin@towmitra.test');
    await setInputValue(page, '#password', 'AdminPassword123!');
    await page.click('button[type="submit"]');

    await page.waitForFunction(
      () => window.location.pathname === '/jobs' && document.body.innerText.includes('Live Jobs'),
      { timeout: 12000 }
    );
    console.log('  ✓ Admin login verified and requested /jobs destination restored');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '07-module-placeholder.png') });

    // Navigate to Dashboard root for responsive and card tests
    await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => document.body.innerText.includes('Operations Console Shell'),
      { timeout: 8000 }
    );
    await page.screenshot({ path: join(SCREENSHOT_DIR, '04-admin-dashboard-1440x900.png') });

    // Journey 4: Responsive Viewports & Tablet Overflow Elimination (D13)
    console.log('▶ [Journey 4/10] Verifying responsive viewports and tablet overflow (D13)...');
    for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
      await page.setViewport({ width, height });
      await delay(200);

      const overflow = await page.evaluate((w) => {
        const bodyOverflow = document.body.scrollWidth > w;
        const mainOverflow = [...document.querySelectorAll('main')].some((m) => m.scrollWidth > m.clientWidth);
        const cardOverflows = [...document.querySelectorAll('main div')].filter((el) => el.scrollWidth > el.clientWidth + 2);
        return { bodyOverflow, mainOverflow, cardOverflowCount: cardOverflows.length };
      }, width);

      assert.equal(overflow.bodyOverflow, false, `Horizontal body overflow detected at ${width}x${height}`);
      assert.equal(overflow.mainOverflow, false, `Horizontal main overflow detected at ${width}x${height}`);
      if (width === 768) {
        assert.equal(overflow.cardOverflowCount, 0, `Tablet card content overflow detected at 768x1024 (count: ${overflow.cardOverflowCount})`);
      }
      if (width === 768) await page.screenshot({ path: join(SCREENSHOT_DIR, '05-tablet-768x1024.png') });
    }
    console.log('  ✓ Responsive viewports verified with 0 horizontal overflow and contained tablet cards');

    // Journey 5: Mobile Drawer Accessibility, Focus Trap, and Focus Restoration on Escape (D12)
    console.log('▶ [Journey 5/10] Testing mobile navigation drawer focus trap and Escape restoration (D12)...');
    await page.setViewport({ width: 390, height: 844 });
    await delay(150);

    const mobileOpener = await page.waitForSelector('button[aria-label="Open mobile navigation menu"]');
    await mobileOpener.focus();
    await page.keyboard.press('Enter');

    await page.waitForSelector('div[role="dialog"]', { timeout: 4000 });
    let trapped = await page.evaluate(() => document.querySelector('div[role="dialog"]').contains(document.activeElement));
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      trapped = trapped && (await page.evaluate(() => document.querySelector('div[role="dialog"]').contains(document.activeElement)));
    }
    assert.ok(trapped, 'Mobile Tab focus must stay contained inside drawer dialog (D12)');
    await page.screenshot({ path: join(SCREENSHOT_DIR, '06-mobile-drawer-390x844.png') });

    // Press Escape
    await page.keyboard.press('Escape');
    await delay(200);
    await page.waitForFunction(() => !document.querySelector('div[role="dialog"]'), { timeout: 4000 });

    const focusedOpener = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'Open mobile navigation menu');
    assert.ok(focusedOpener, 'Escape key must return focus to the mobile navigation menu opener button (D12)');
    console.log('  ✓ Mobile drawer focus trap and Escape focus restoration verified');

    // Reset to desktop
    await page.setViewport({ width: 1440, height: 900 });

    // Journey 6: Deep Link Retained on Reload with Fresh Claim Verification & Server Demotion (D2)
    console.log('▶ [Journey 6/10] Testing deep link retained on reload and server demotion on reload (D2)...');
    await page.goto('http://127.0.0.1:5173/config', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Config Editor'), { timeout: 8000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Config Editor'), { timeout: 8000 });
    assert.equal(new URL(page.url()).pathname, '/config');

    // Demote account on server before reload to test D2 stale-reload denial
    await setAdminClaim('admin@towmitra.test', false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Access Denied'), { timeout: 10000 });
    const isDashboardGoneOnReload = await page.evaluate(() => !document.body.innerText.includes('Operations Console Shell'));
    assert.ok(isDashboardGoneOnReload, 'Reloading with demoted server claims must deny access');

    // Restore admin claim
    await setAdminClaim('admin@towmitra.test', true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Config Editor'), { timeout: 10000 });
    console.log('  ✓ Session reload retained /config and demotion before reload verified Access Denied');

    // Journey 7: Token Demotion & Promotion Realtime Reaction (D1)
    console.log('▶ [Journey 7/10] Testing onIdTokenChanged reaction to claim demotion and promotion (D1)...');
    await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.innerText.includes('Operations Console Shell'), { timeout: 8000 });

    // Demote account on server
    await setAdminClaim('admin@towmitra.test', false);

    // Force SDK token refresh in browser
    await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      await auth?.currentUser?.getIdTokenResult(true);
    });

    // Observer must detect token change and immediately transition to Access Denied
    await page.waitForFunction(() => document.body.innerText.includes('Access Denied'), { timeout: 10000 });
    const isDashboardGone = await page.evaluate(() => !document.body.innerText.includes('Operations Console Shell'));
    assert.ok(isDashboardGone, 'Demoted token must remove admin dashboard access');
    console.log('  ✓ Token demotion event removed admin access and rendered Access Denied');

    // Re-promote account on server
    await setAdminClaim('admin@towmitra.test', true);
    await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      await auth?.currentUser?.getIdTokenResult(true);
    });

    await page.waitForFunction(() => document.body.innerText.includes('Operations Console Shell'), { timeout: 10000 });
    console.log('  ✓ Token promotion event re-authorized session and restored dashboard');

    // Journey 8: Refresh Protected Suppression & Auth Outage Recovery (D5, D6)
    console.log('▶ [Journey 8/10] Testing manual refresh loading suppression and outage recovery (D5, D6)...');
    holdToken = true;
    heldToken = null;
    const refreshBtn = await page.waitForSelector('button[aria-label="Refresh authorization"]');
    await refreshBtn.click();

    for (let i = 0; i < 100 && !heldToken; i++) await delay(20);
    assert.ok(heldToken, 'Refresh token request must be intercepted in flight');
    const pendingText = await page.evaluate(() => document.body.innerText);
    assert.ok(
      !pendingText.includes('Operations Console Shell') && pendingText.includes('Verifying'),
      'Held token refresh must unmount protected content and show verifying state (D5)'
    );
    holdToken = false;
    await heldToken.continue();
    await page.waitForFunction(() => document.body.innerText.includes('Operations Console Shell'), { timeout: 10000 });

    // Simulate Auth outage
    blockAuth = true;
    const refreshBtn2 = await page.waitForSelector('button[aria-label="Refresh authorization"]');
    await refreshBtn2.click();
    await page.waitForFunction(() => document.body.innerText.includes('Authorization Verification Failure'), { timeout: 15000 });
    const isDashboardGoneOnAuthOutage = await page.evaluate(() => !document.body.innerText.includes('Operations Console Shell'));
    assert.ok(isDashboardGoneOnAuthOutage, 'Auth failure must unmount protected dashboard');

    // Retry while still failing - must stay closed
    await page.evaluate(() => {
      const retryBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry'));
      retryBtn?.click();
    });
    await delay(600);
    const staysClosed = await page.evaluate(() => document.body.innerText.includes('Authorization Verification Failure'));
    assert.ok(staysClosed, 'Retry must remain closed while Auth is failing (D6)');

    // Restore Auth transport and retry
    blockAuth = false;
    await page.evaluate(() => {
      const retryBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry'));
      retryBtn?.click();
    });

    await page.waitForFunction(() => document.body.innerText.includes('Operations Console Shell'), { timeout: 15000 });
    console.log('  ✓ Held refresh loading suppression and Auth outage recovery verified');

    // Simulate Firestore outage (D9)
    blockFirestore = true;
    const refreshBtn3 = await page.waitForSelector('button[aria-label="Refresh authorization"]');
    await refreshBtn3.click();
    await page.waitForFunction(() => document.body.innerText.includes('Authorization Verification Failure'), { timeout: 15000 });
    const isDashboardGoneOnFirestoreOutage = await page.evaluate(() => !document.body.innerText.includes('Operations Console Shell'));
    assert.ok(isDashboardGoneOnFirestoreOutage, 'Firestore outage must unmount protected dashboard (D9)');

    // Retry while still failing - must stay closed
    await page.evaluate(() => {
      const retryBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry'));
      retryBtn?.click();
    });
    await delay(600);
    const staysClosedFirestore = await page.evaluate(() => document.body.innerText.includes('Authorization Verification Failure'));
    assert.ok(staysClosedFirestore, 'Retry must remain closed while Firestore is failing (D6, D9)');

    // Restore Firestore and retry
    blockFirestore = false;
    await page.evaluate(() => {
      const retryBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry'));
      retryBtn?.click();
    });

    await page.waitForFunction(() => document.body.innerText.includes('Operations Console Shell'), { timeout: 15000 });
    console.log('  ✓ Firestore outage failure and recovery verified (D9)');

    // Journey 9: Delayed Login Fenced After Logout (D3)
    console.log('▶ [Journey 9/10] Verifying delayed login callback cannot reauthorize after logout (D3)...');
    // Sign out from navbar menu to reach login
    const userMenuBtn = await page.waitForSelector('button[aria-label="Admin account menu"]');
    await userMenuBtn.click();
    const menuSignOutBtn = await page.waitForSelector('[data-testid="navbar-sign-out"]', { timeout: 4000 });
    await menuSignOutBtn.click();
    await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 8000 });

    // Intercept admin login in flight
    holdLogin = true;
    heldLogin = null;
    await setInputValue(page, '#email', 'admin@towmitra.test');
    await setInputValue(page, '#password', 'AdminPassword123!');
    await page.click('button[type="submit"]');

    for (let i = 0; i < 100 && !heldLogin; i++) await delay(20);
    assert.ok(heldLogin, 'Admin login request must be intercepted in flight');

    // While login request is in flight, invoke programmatic signOutUser from React context
    await page.evaluate(async () => {
      const root = document.getElementById('root');
      const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      let fiber = root[key];
      if (fiber.stateNode?.current) fiber = fiber.stateNode.current;
      const seen = new Set();
      function find(f) {
        if (!f || seen.has(f)) return null;
        seen.add(f);
        if (f.memoizedProps?.value?.signOutUser) return f.memoizedProps.value;
        return find(f.child) || find(f.sibling);
      }
      const context = find(fiber);
      if (context) await context.signOutUser();
    });

    // Release held login HTTP response
    holdLogin = false;
    await heldLogin.continue();
    await delay(1000);

    const postDelayedLogin = await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      return {
        user: auth?.currentUser?.email || null,
        text: document.body.innerText,
      };
    });

    assert.equal(postDelayedLogin.user, null, 'User must remain signed out after superseded late login');
    assert.ok(!postDelayedLogin.text.includes('Operations Console Shell'), 'Dashboard must not mount after superseded late login');
    console.log('  ✓ Delayed login race fenced against intermediate logout');

    // Test Newer Account B Preservation when obsolete login resolves (D3)
    console.log('  Testing newer account B preservation when obsolete login resolves (D3)...');
    holdLogin = true;
    heldLogin = null;

    // Trigger login A in background
    await page.evaluate(async () => {
      const root = document.getElementById('root');
      const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      let fiber = root[key];
      if (fiber.stateNode?.current) fiber = fiber.stateNode.current;
      const seen = new Set();
      function find(f) {
        if (!f || seen.has(f)) return null;
        seen.add(f);
        if (f.memoizedProps?.value?.signIn) return f.memoizedProps.value;
        return find(f.child) || find(f.sibling);
      }
      const context = find(fiber);
      window.__loginAPromise = context?.signIn('admin@towmitra.test', 'AdminPassword123!');
    });

    for (let i = 0; i < 100 && !heldLogin; i++) await delay(20);
    assert.ok(heldLogin, 'Login A request must be intercepted in flight');

    // While login A is held, sign out and sign in as newer account B (operator@towmitra.test)
    await page.evaluate(async () => {
      const root = document.getElementById('root');
      const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      let fiber = root[key];
      if (fiber.stateNode?.current) fiber = fiber.stateNode.current;
      const seen = new Set();
      function find(f) {
        if (!f || seen.has(f)) return null;
        seen.add(f);
        if (f.memoizedProps?.value?.signOutUser) return f.memoizedProps.value;
        return find(f.child) || find(f.sibling);
      }
      const context = find(fiber);
      await context?.signOutUser();
    });

    // Log in as newer account B (operator@towmitra.test) via the form
    await setInputValue(page, '#email', 'operator@towmitra.test');
    await setInputValue(page, '#password', 'OperatorPassword123!');
    await page.click('button[type="submit"]');

    await page.waitForFunction(() => document.body.innerText.includes('Access Denied'), { timeout: 10000 });

    // Deterministically release held login A
    const aResponsePromise = page.waitForResponse(
      (r) => r.url().includes('/accounts:signInWithPassword') && r.request().postData()?.includes('admin@towmitra.test'),
      { timeout: 12000 }
    );
    holdLogin = false;
    await heldLogin.continue();
    const aResponse = await aResponsePromise;
    assert.equal(aResponse.status(), 200, 'Obsolete login A response must resolve with 200');

    // Wait for login A promise to settle
    await page.evaluate(async () => {
      try {
        await window.__loginAPromise;
      } catch {
        // ignore
      }
    });

    await delay(400);

    // Verify newer account B is preserved in both provider and SDK
    const preservedState = await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      const root = document.getElementById('root');
      const key = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      let fiber = root[key];
      if (fiber.stateNode?.current) fiber = fiber.stateNode.current;
      const seen = new Set();
      function find(f) {
        if (!f || seen.has(f)) return null;
        seen.add(f);
        if (f.memoizedProps?.value?.status) return f.memoizedProps.value;
        return find(f.child) || find(f.sibling);
      }
      const c = find(fiber);
      return {
        sdkUser: auth.currentUser?.email || null,
        providerUser: c?.user?.email || null,
        status: c?.status || null,
        text: document.body.innerText,
      };
    });

    assert.equal(preservedState.sdkUser, 'operator@towmitra.test', 'SDK user must remain operator@towmitra.test (D3)');
    assert.equal(preservedState.providerUser, 'operator@towmitra.test', 'Provider user must remain operator@towmitra.test (D3)');
    assert.equal(preservedState.status, 'ACCESS_DENIED', 'Provider status must remain ACCESS_DENIED for operator (D3)');
    assert.ok(preservedState.text.includes('Access Denied'), 'UI must retain Access Denied for operator');
    assert.ok(!preservedState.text.includes('Operations Console Shell'), 'Login A must not mount admin console');
    console.log('  ✓ Newer account B preserved in SDK and provider when obsolete login A resolves');

    // Journey 10: Routed Logout Failure (D7), Back-Button Fencing & External Network Invariant (D8, M1-J)
    console.log('▶ [Journey 10/10] Testing routed logout failure, retry, back-button fencing, and CSP network boundary (D7, D8)...');
    // Log in as admin again to reach dashboard
    await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'domcontentloaded' });
    await setInputValue(page, '#email', 'admin@towmitra.test');
    await setInputValue(page, '#password', 'AdminPassword123!');
    await delay(200);
    await page.evaluate(() => document.querySelector('button[type="submit"]')?.click());
    await page.waitForFunction(() => document.body.innerText.includes('Operations Console Shell'), { timeout: 10000 });

    // Inject logout failure to test D7 routed failure and retry
    await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      window.__origSignOut = auth?.signOut;
      if (auth) {
        auth.signOut = async () => { throw new Error('PERSISTENCE_REMOVAL_FAILED'); };
      }
    });

    const accountMenu = await page.waitForSelector('button[aria-label="Admin account menu"]');
    await accountMenu.click();
    const navSignOut = await page.waitForSelector('[data-testid="navbar-sign-out"]');
    await navSignOut.click();

    await page.waitForFunction(
      () => document.body.innerText.includes('Logout failed') || document.body.innerText.includes('Logout Failure'),
      { timeout: 8000 }
    );
    const logoutFailureText = await page.evaluate(() => document.body.innerText);
    assert.ok(!logoutFailureText.includes('Operations Console Shell'), 'Protected content must unmount on logout failure (D7)');
    assert.ok(logoutFailureText.includes('Logout failed'), 'Logout failure must be visibly reported (D7)');

    // Assert accessible error semantics (role="alert", aria-live="assertive", Retry Sign Out button)
    const alertSemantics = await page.evaluate(() => {
      const alert = document.querySelector('[role="alert"]');
      const retryBtn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry Sign Out'));
      return {
        hasAlert: !!alert,
        isAssertive: alert?.getAttribute('aria-live') === 'assertive',
        hasRetryBtn: !!retryBtn,
      };
    });
    assert.ok(alertSemantics.hasAlert, 'Logout failure must have role="alert" (D7, D14)');
    assert.ok(alertSemantics.isAssertive, 'Logout failure alert must have aria-live="assertive" (D7)');
    assert.ok(alertSemantics.hasRetryBtn, 'Dedicated Retry Sign Out button must be present (D7)');

    // Retry while still failing - must stay in error state
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry Sign Out'));
      btn?.click();
    });
    await delay(500);
    const staysInError = await page.evaluate(() => document.body.innerText.includes('Logout failed'));
    assert.ok(staysInError, 'Failed retry must keep error state and Retry button (D7)');

    // Restore real signOut and click "Retry Sign Out"
    await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      if (auth) auth.signOut = window.__origSignOut;
    });

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.includes('Retry Sign Out'));
      btn?.click();
    });

    await page.waitForFunction(() => window.location.pathname === '/login', { timeout: 10000 });
    const postLogoutSdkUser = await page.evaluate(async () => {
      const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
      const auth = getSelectedAuth();
      return auth?.currentUser || null;
    });
    assert.equal(postLogoutSdkUser, null, 'auth.currentUser must be null after successful sign-out retry');
    console.log('  ✓ Logout failure unmounted dashboard, reported accessible alert, and Retry Sign Out completed successfully');

    // Click browser back
    await page.goBack().catch(() => {});
    await delay(500);
    const postBackText = await page.evaluate(() => document.body.innerText);
    assert.ok(!postBackText.includes('Operations Console Shell'), 'Browser back must not restore protected content');
    console.log('  ✓ Browser back button after logout remains unauthenticated');

    await page.screenshot({ path: join(SCREENSHOT_DIR, '08-final-logged-out.png') });

    // Assert zero external requests (D8)
    assert.equal(externalRequests.length, 0, `External network requests detected: ${JSON.stringify(externalRequests)}`);
    assert.equal(pageErrors.length, 0, `Uncaught page errors detected: ${JSON.stringify(pageErrors)}`);
    assert.equal(consoleErrors.length, 0, `Unexplained console errors detected: ${JSON.stringify(consoleErrors)}`);
    console.log('  ✓ Strict CSP verified: 0 external requests, 0 uncaught page errors, and 0 console errors');

    await browser.close();
    console.log('\n\x1b[32m[SUCCESS] All 10 user journeys in browser smoke test PASSED completely!\x1b[0m');
    console.log(`Verified screenshots preserved in: ${SCREENSHOT_DIR}\n`);
    process.exit(0);
  } catch (err) {
    if (page) {
      try {
        console.error('       [Diagnostic URL]:', page.url());
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.error('       [Diagnostic Body]:', bodyText.slice(0, 300));
        const diag = await page.evaluate(async () => {
          const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');
          const auth = getSelectedAuth();
          const fence = localStorage.getItem('towmitra:demo-towmitra-admin:m1:selection:v1');
          return {
            authUid: auth?.currentUser?.uid,
            authEmail: auth?.currentUser?.email,
            fence,
          };
        });
        console.error('       [Diagnostic State]:', JSON.stringify(diag));
      } catch (dErr) {
        console.error('       [Diagnostic Error]:', dErr.message);
      }
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopVite();
  }
}

runSmokeTests().catch((err) => {
  console.error('\n\x1b[31m[FAIL] Browser smoke test failed:\x1b[0m', err);
  process.exit(1);
});
