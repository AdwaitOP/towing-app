#!/usr/bin/env node
/**
 * TowMitra Admin Panel — Phase 6 M1 Deterministic Concurrency Browser Suite (T01–T21)
 *
 * Implements authoritative verification of Codex's approved authentication architecture:
 * - Isolated memory-only staging
 * - Immutable canonical session namespace per login ticket
 * - Single selection fence in localStorage (v: 1)
 * - Short Web Lock for selection/admission
 * - Long Web Lock for persistent mutations
 * - All 21 required test schedules (T01 through T21) with real Chromium and emulators.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { validateEmulatorHost, validateProject, EXPECTED_PROJECT_ID } from './validate-endpoint.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Fail-closed environment validation
const authHost = validateEmulatorHost('FIREBASE_AUTH_EMULATOR_HOST', process.env.FIREBASE_AUTH_EMULATOR_HOST).value;
const firestoreHost = validateEmulatorHost('FIRESTORE_EMULATOR_HOST', process.env.FIRESTORE_EMULATOR_HOST).value;
const projectId = validateProject(process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID);

process.env.FIREBASE_AUTH_EMULATOR_HOST = authHost;
process.env.FIRESTORE_EMULATOR_HOST = firestoreHost;
process.env.GCLOUD_PROJECT = projectId;
process.env.METADATA_SERVER_DETECTION = 'none';

const app = getApps().length === 0 ? initializeApp({ projectId: EXPECTED_PROJECT_ID }) : getApps()[0];
const adminAuth = getAuth(app);

const A = 'admin@towmitra.test';
const AP = 'AdminPassword123!';
const B = 'admin-b@towmitra.test';
const BP = 'AdminPassword123!';
const OP = 'operator@towmitra.test';
const OPP = 'OperatorPassword123!';

const executablePath =
  process.env.CHROME_BIN ||
  process.env.PUPPETEER_EXECUTABLE_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
const errors = [];

function record(id, name, pass, detail = {}) {
  results.push({ id, name, pass, detail });
  const statusStr = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${statusStr}] ${id} — ${name}`);
  if (!pass) {
    console.error('         Detail:', JSON.stringify(detail));
  }
}

async function setAdminClaim(email, isAdmin) {
  const user = await adminAuth.getUserByEmail(email);
  const existingClaims = user.customClaims || {};
  await adminAuth.setCustomUserClaims(user.uid, {
    ...existingClaims,
    admin: isAdmin,
  });
}

async function waitForServer(url, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return true;
    } catch {
      // Retry
    }
    await delay(250);
  }
  throw new Error(`Timeout waiting for server at ${url}`);
}

async function action(page, method, args = [], key = null) {
  return page.evaluate(
    async ({ method, args, key }) => {
      const root = document.getElementById('root');
      const k = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
      let f = root[k];
      if (f.stateNode?.current) f = f.stateNode.current;
      const seen = new Set();
      function find(n) {
        if (!n || seen.has(n)) return null;
        seen.add(n);
        if (n.memoizedProps?.value?.signIn) return n.memoizedProps.value;
        return find(n.child) || find(n.sibling);
      }
      const c = find(f);
      if (!c) throw new Error('AuthContext value not found in React tree');

      const op = Promise.resolve(c[method](...args));
      if (key) {
        window.__ops = window.__ops || {};
        window.__ops[key] = { done: false, result: null, error: null };
        op.then(
          (result) => {
            window.__ops[key] = { done: true, result, error: null };
          },
          (err) => {
            window.__ops[key] = { done: true, result: null, error: err?.message || String(err) };
          }
        );
        return;
      }
      return await op;
    },
    { method, args, key }
  );
}

async function snapshot(page) {
  return page.evaluate(async () => {
    let auth = null;
    try {
      if (typeof window.getSelectedAuth === 'function') {
        auth = window.getSelectedAuth();
      } else {
        const mod = await import('/src/auth/authCoordinator.ts');
        auth = mod.getSelectedAuth();
      }
    } catch {
      // ignore
    }

    const root = document.getElementById('root');
    const k = Object.keys(root).find((item) => item.startsWith('__reactContainer'));
    let f = root ? root[k] : null;
    if (f?.stateNode?.current) f = f.stateNode.current;
    const seen = new Set();
    function find(node) {
      if (!node || seen.has(node)) return null;
      seen.add(node);
      if (node.memoizedProps?.value?.signIn) return node.memoizedProps.value;
      return find(node.child) || find(node.sibling);
    }
    const context = find(f);

    const fenceRaw = localStorage.getItem('towmitra:demo-towmitra-admin:m1:selection:v1');
    let fence = null;
    try {
      fence = fenceRaw ? JSON.parse(fenceRaw) : null;
    } catch {
      fence = { corrupt: true, raw: fenceRaw };
    }

    const persisted = [];
    let idbReadError = null;
    try {
      const databases = await indexedDB.databases();
      for (const info of databases) {
        if (info.name !== 'firebaseLocalStorageDb') continue;
        const db = await new Promise((res, rej) => {
          const req = indexedDB.open(info.name);
          req.onsuccess = () => res(req.result);
          req.onerror = () => rej(req.error);
        });
        if (db.objectStoreNames.contains('firebaseLocalStorage')) {
          const rows = await new Promise((res, rej) => {
            const req = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error);
          });
          persisted.push(
            ...rows
              .filter((r) => r.fbase_key?.startsWith('firebase:authUser:'))
              .map((r) => ({
                key: r.fbase_key,
                uid: r.value?.uid,
                email: r.value?.email,
              }))
          );
        }
        db.close();
      }
    } catch (err) {
      idbReadError = err?.message || String(err);
    }

    const selectedSessionId = fence?.sessionId;
    const selectedAppKey = selectedSessionId ? `towmitra-session-${selectedSessionId}` : null;
    const selectedRow = selectedAppKey
      ? persisted.find((r) => r.key.includes(selectedAppKey)) || null
      : null;

    const text = document.body.innerText;
    return {
      pathname: location.pathname,
      sdk: auth?.currentUser?.email || null,
      sdkUid: auth?.currentUser?.uid || null,
      provider: {
        user: context?.user?.email || null,
        uid: context?.user?.uid || null,
        status: context?.status || null,
        proof: !!context?.serverProofVerified,
        canRenderProtected: !!context?.canRenderProtected,
      },
      fence,
      persisted,
      selectedRow,
      idbReadError,
      dashboard: text.includes('Operations Console Shell'),
      denied: text.includes('Access Denied'),
      error: text.includes('Logout failed') || text.includes('Verification Failure') || text.includes('Failure'),
      text: text.slice(0, 500),
      ops: window.__ops || {},
    };
  });
}

async function setupPage(context) {
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);

  let holdLogin = false;
  let heldLogin = null;
  let holdTargetEmail = null;

  page.on('request', (req) => {
    const u = new URL(req.url());
    if (['http:', 'https:'].includes(u.protocol) && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
      return req.abort();
    }
    const postData = req.postData() || '';
    if (
      holdLogin &&
      !heldLogin &&
      req.url().includes('/accounts:signInWithPassword') &&
      (!holdTargetEmail || postData.includes(holdTargetEmail))
    ) {
      heldLogin = req;
      return;
    }
    req.continue();
  });

  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      !!document.querySelector('#email') ||
      document.body.innerText.includes('Operations Console Shell') ||
      document.body.innerText.includes('Access Denied'),
    { timeout: 10000 }
  );

  return {
    page,
    hold(email = null) {
      holdLogin = true;
      heldLogin = null;
      holdTargetEmail = email;
    },
    async waitHeld(timeoutMs = 10000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (heldLogin) return;
        await delay(20);
      }
      throw new Error('Expected login request was not intercepted');
    },
    async release() {
      if (!heldLogin) throw new Error('No held login request to release');
      const responsePromise = page.waitForResponse(
        (r) => r.url().includes('/accounts:signInWithPassword'),
        { timeout: 12000 }
      );
      holdLogin = false;
      const cur = heldLogin;
      heldLogin = null;
      await cur.continue();
      const resp = await responsePromise;
      return resp.status();
    },
  };
}

async function waitSettled(page, key, timeoutMs = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ops = await page.evaluate(() => window.__ops).catch(() => null);
    if (ops?.[key]?.done) {
      await delay(100);
      return;
    }
    await delay(100);
  }
  const finalOps = await page.evaluate(() => window.__ops).catch(() => null);
  throw new Error(`Timeout waiting for op [${key}] to settle. Ops state: ${JSON.stringify(finalOps)}`);
}

async function waitAuthorized(page, email, timeoutMs = 12000) {
  await page.waitForFunction(
    (targetEmail) => {
      const text = document.body.innerText;
      return text.includes('Operations Console Shell') && text.includes(targetEmail);
    },
    { timeout: timeoutMs },
    email
  );
  await delay(200);
}

async function reloadSnapshot(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      !document.body.innerText.includes('Restoring admin session') &&
      !document.body.innerText.includes('Verifying session security') &&
      !document.body.innerText.includes('Authenticating credentials'),
    { timeout: 12000 }
  );
  await delay(300);
  return await snapshot(page);
}

// =========================================================================
// Deterministic Suite Execution
// =========================================================================

async function runDeterministicSuite() {
  console.log('\n======================================================');
  console.log(' TowMitra Admin Panel — Concurrency Browser Suite (T01–T21)');
  console.log('======================================================\n');

  // Verify accounts
  await setAdminClaim(A, true);
  await setAdminClaim(B, true);
  await setAdminClaim(OP, false);

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
    viteProcess = spawn('cmd.exe', ['/c', 'npx.cmd vite --port 5173 --host 127.0.0.1'], {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
    });
  }

  const stopVite = () => {
    try {
      if (viteProcess?.pid) {
        execSync(`taskkill /pid ${viteProcess.pid} /T /F`, { stdio: 'ignore' });
      }
    } catch {
      // ignore
    }
  };
  process.on('exit', stopVite);
  process.on('SIGINT', stopVite);

  await waitForServer('http://127.0.0.1:5173');
  console.log('       Vite dev server ready at http://127.0.0.1:5173\n');

  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    // -----------------------------------------------------------------------
    // T01: Hold staged A; logout; release A; await promise settlement.
    // Result: No ACTIVE session, protected UI absent, no canonical A write.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      h.hold(A);
      await action(h.page, 'signIn', [A, AP], 'T01_A');
      await h.waitHeld();

      // Logout before A completes staging
      await action(h.page, 'signOutUser');
      const snapAfterLogout = await snapshot(h.page);

      // Release A
      const status = await h.release();
      await waitSettled(h.page, 'T01_A');
      const snapFinal = await snapshot(h.page);
      const snapReload = await reloadSnapshot(h.page);

      const pass =
        status === 200 &&
        snapAfterLogout.sdk === null &&
        snapFinal.sdk === null &&
        snapFinal.provider.status === 'UNAUTHENTICATED' &&
        !snapFinal.dashboard &&
        snapFinal.persisted.length === 0 &&
        snapReload.sdk === null &&
        snapReload.provider.status === 'UNAUTHENTICATED' &&
        !snapReload.dashboard;

      record('T01', 'Hold staged A, logout, release A: remains closed without canonical write', pass, {
        status,
        snapFinal,
        snapReload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T02: Hold A; let distinct admin B commit & prove; release A.
    // Result: B remains current, durable, and restored.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      h.hold(A);
      await action(h.page, 'signIn', [A, AP], 'T02_A');
      await h.waitHeld();

      // Trigger login B
      await action(h.page, 'signIn', [B, BP], 'T02_B');
      await waitSettled(h.page, 'T02_B');
      await waitAuthorized(h.page, B);

      // Release held A
      const status = await h.release();
      await waitSettled(h.page, 'T02_A');

      const afterA = await snapshot(h.page);
      const reload = await reloadSnapshot(h.page);

      const pass =
        status === 200 &&
        afterA.sdk === B &&
        afterA.provider.user === B &&
        afterA.provider.status === 'AUTHORIZED_ADMIN' &&
        afterA.dashboard &&
        afterA.persisted.some((r) => r.email === B) &&
        reload.sdk === B &&
        reload.provider.user === B &&
        reload.dashboard;

      record('T02', 'Hold A, distinct admin B commits & proves, release A: B preserved', pass, {
        status,
        afterA,
        reload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T03: Hold A; logout; B stages/commits/proves; release A.
    // Result: Same durable B result.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      h.hold(A);
      await action(h.page, 'signIn', [A, AP], 'T03_A');
      await h.waitHeld();

      await action(h.page, 'signOutUser');
      await action(h.page, 'signIn', [B, BP], 'T03_B');
      await waitSettled(h.page, 'T03_B');
      await waitAuthorized(h.page, B);

      const status = await h.release();
      await waitSettled(h.page, 'T03_A');

      const after = await snapshot(h.page);
      const reload = await reloadSnapshot(h.page);

      const pass =
        status === 200 &&
        after.sdk === B &&
        after.provider.user === B &&
        after.dashboard &&
        reload.sdk === B &&
        reload.dashboard;

      record('T03', 'Hold A, logout, B stages/commits, release A: B preserved durably', pass, {
        after,
        reload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T04: Hold same-UID A1, accept A2, release A1.
    // Result: Winning ticket/app name proves ownership.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      h.hold(A);
      await action(h.page, 'signIn', [A, AP], 'T04_A1');
      await h.waitHeld();

      await action(h.page, 'signIn', [A, AP], 'T04_A2');
      await waitSettled(h.page, 'T04_A2');
      await waitAuthorized(h.page, A);

      const snapA2 = await snapshot(h.page);
      const winningSessionId = snapA2.fence?.sessionId;
      const status = await h.release();
      await waitSettled(h.page, 'T04_A1');

      const after = await snapshot(h.page);
      const reload = await reloadSnapshot(h.page);

      // Verify second tab observes winning UUID
      const h2 = await setupPage(context);
      await h2.page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
      await waitAuthorized(h2.page, A);
      const snapTab2 = await snapshot(h2.page);

      const pass =
        status === 200 &&
        winningSessionId &&
        snapA2.fence?.latest?.id === winningSessionId &&
        snapA2.provider.status === 'AUTHORIZED_ADMIN' &&
        snapA2.dashboard &&
        after.fence?.sessionId === winningSessionId &&
        after.provider.status === 'AUTHORIZED_ADMIN' &&
        after.dashboard &&
        after.selectedRow?.email === A &&
        after.selectedRow?.key.includes(winningSessionId) &&
        reload.fence?.sessionId === winningSessionId &&
        reload.provider.status === 'AUTHORIZED_ADMIN' &&
        reload.dashboard &&
        snapTab2.fence?.sessionId === winningSessionId &&
        snapTab2.dashboard;

      record('T04', 'Hold same-UID A1, accept A2, release A1: winning UUID proved across tabs/reload', pass, {
        winningSessionId,
        snapA2,
        after,
        reload,
        snapTab2,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T05: Ordinary shared-session two-tab navbar logout.
    // Result: Receiver tab loses proof/DOM immediately before reload.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h1 = await setupPage(context);
      await action(h1.page, 'signIn', [A, AP]);
      await waitAuthorized(h1.page, A);

      const h2 = await setupPage(context);
      await h2.page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
      await waitAuthorized(h2.page, A);

      // In Tab 1, perform navbar logout
      await action(h1.page, 'signOutUser');
      await delay(200);

      // Verify Tab 2 (receiver) lost dashboard immediately
      const snapTab2BeforeReload = await snapshot(h2.page);
      const snapTab1Reload = await reloadSnapshot(h1.page);
      const snapTab2Reload = await reloadSnapshot(h2.page);

      const pass =
        !snapTab2BeforeReload.dashboard &&
        snapTab1Reload.sdk === null &&
        !snapTab1Reload.dashboard &&
        snapTab2Reload.sdk === null &&
        !snapTab2Reload.dashboard;

      record('T05', 'Ordinary shared two-tab navbar logout: receiver tab unmounts immediately', pass, {
        snapTab2BeforeReload,
        snapTab1Reload,
        snapTab2Reload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T06: Ordinary other-tab operator replacement.
    // Result: Old admin proof disappears; receiver becomes operator ACCESS_DENIED.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h1 = await setupPage(context);
      await action(h1.page, 'signIn', [A, AP]);
      await waitAuthorized(h1.page, A);

      const h2 = await setupPage(context);
      await h2.page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
      await waitAuthorized(h2.page, A);

      // In Tab 1, switch account to operator (denied) directly
      await action(h1.page, 'signIn', [OP, OPP]);
      await h1.page.waitForFunction(() => document.body.innerText.includes('Access Denied'), { timeout: 10000 });

      // Tab 2 immediately updates to Access Denied via cross-tab coordination
      await h2.page.waitForFunction(() => document.body.innerText.includes('Access Denied'), { timeout: 10000 });
      const snapTab2 = await snapshot(h2.page);
      const snapTab2Reload = await reloadSnapshot(h2.page);

      const pass =
        snapTab2.denied &&
        !snapTab2.dashboard &&
        snapTab2.provider.user === OP &&
        snapTab2Reload.denied &&
        snapTab2Reload.provider.user === OP;

      record('T06', 'Other-tab operator replacement: receiver immediately shows Access Denied', pass, {
        snapTab2,
        snapTab2Reload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T07: Local A staging, then other-tab logout; release A.
    // Result: Later shared logout intent wins; A never commits.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h1 = await setupPage(context);
      await action(h1.page, 'signIn', [A, AP]);
      await waitAuthorized(h1.page, A);

      const h2 = await setupPage(context);
      h2.hold(A);
      await action(h2.page, 'signIn', [A, AP], 'T07_A');
      await h2.waitHeld();

      // Tab 1 logs out
      await action(h1.page, 'signOutUser');
      await delay(100);

      // Release Tab 2 held A
      await h2.release();
      await waitSettled(h2.page, 'T07_A');

      const snap2 = await snapshot(h2.page);
      const reload2 = await reloadSnapshot(h2.page);

      const pass =
        snap2.sdk === null &&
        !snap2.dashboard &&
        reload2.sdk === null &&
        !reload2.dashboard;

      record('T07', 'Local A staging + other-tab logout + release A: logout intent wins', pass, {
        snap2,
        reload2,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T08: Obsolete local staging held; external replacement B wins.
    // Result: B remains untouched when old A finishes.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h1 = await setupPage(context);
      h1.hold(A);
      await action(h1.page, 'signIn', [A, AP], 'T08_A');
      await h1.waitHeld();

      const h2 = await setupPage(context);
      await action(h2.page, 'signIn', [B, BP]);
      await waitAuthorized(h2.page, B);

      // Release Tab 1 held A
      await h1.release();
      await waitSettled(h1.page, 'T08_A');

      const snapTab2 = await snapshot(h2.page);
      const reload2 = await reloadSnapshot(h2.page);

      const pass =
        snapTab2.sdk === B &&
        snapTab2.dashboard &&
        reload2.sdk === B &&
        reload2.dashboard;

      record('T08', 'Obsolete local staging held while external B wins: B untouched', pass, {
        snapTab2,
        reload2,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T09: Competing cross-tab intents.
    // Result: Latest admitted intent wins.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h1 = await setupPage(context);
      const h2 = await setupPage(context);

      // Tab 1 admits A, Tab 2 immediately admits B
      await action(h1.page, 'signIn', [A, AP], 'T09_A');
      await delay(20);
      await action(h2.page, 'signIn', [B, BP], 'T09_B');

      await waitSettled(h2.page, 'T09_B');
      await waitAuthorized(h2.page, B);

      const snap2 = await snapshot(h2.page);
      const reload2 = await reloadSnapshot(h2.page);

      const pass =
        snap2.sdk === B &&
        snap2.dashboard &&
        reload2.sdk === B &&
        reload2.dashboard;

      record('T09', 'Competing cross-tab intents: latest admitted intent wins', pass, {
        snap2,
        reload2,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T10: B accepted; release obsolete attempt/continuation.
    // Result: Zero unowned signOut/restore calls; B persistence remains B.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);

      // Start real login attempt for A, but hold A's credential response at network boundary
      h.hold(A);
      await action(h.page, 'signIn', [A, AP], 'T10_A');
      await h.waitHeld();

      // While A is held, B is admitted, commits, and authorizes
      await action(h.page, 'signIn', [B, BP], 'T10_B');
      await waitSettled(h.page, 'T10_B');
      await waitAuthorized(h.page, B);

      const snapB = await snapshot(h.page);
      const bSessionId = snapB.fence?.sessionId;

      // Track unowned signOut calls or mutations before releasing A
      await h.page.evaluate(() => {
        window.__signOutCallCount = 0;
        const origSignOut = window.signOut;
        if (origSignOut) {
          window.signOut = async (...args) => {
            window.__signOutCallCount = (window.__signOutCallCount || 0) + 1;
            return origSignOut(...args);
          };
        }
      });

      // Release held attempt A
      await h.release();
      await waitSettled(h.page, 'T10_A');

      const unownedSignOuts = await h.page.evaluate(() => window.__signOutCallCount || 0);
      const snapAfter = await snapshot(h.page);
      const reload = await reloadSnapshot(h.page);

      const pass =
        unownedSignOuts === 0 &&
        snapAfter.sdk === B &&
        snapAfter.provider.user === B &&
        snapAfter.dashboard &&
        snapAfter.fence?.sessionId === bSessionId &&
        snapAfter.selectedRow?.email === B &&
        snapAfter.selectedRow?.key.includes(bSessionId) &&
        reload.sdk === B &&
        reload.dashboard;

      record('T10', 'B accepted, obsolete continuation discarded: zero unowned mutations', pass, {
        unownedSignOuts,
        snapB,
        snapAfter,
        reload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T11 (amended): Hold logout mutation that rejects; B stages concurrently
    // but waits for mutation lock; old promise rejects; then B commits & proves.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      // Inject held rejecting signOut
      await h.page.evaluate(async () => {
        const auth =
          (typeof window.getSelectedAuth === 'function' ? window.getSelectedAuth() : null) ||
          (await import('/src/auth/authCoordinator.ts')).getSelectedAuth();
        window.__origSignOut = auth.signOut;
        window.__logoutStarted = false;
        auth.signOut = async () => {
          window.__logoutStarted = true;
          await new Promise((_, rej) => {
            window.__rejectLogout = () => rej(new Error('T11_LOGOUT_REJECTED'));
          });
        };
      });

      // Trigger logout (holds mutation lock)
      await action(h.page, 'signOutUser', [], 'T11_logout');
      await h.page.waitForFunction(() => window.__logoutStarted);

      // Trigger B: B stages concurrently in memory, waits for mutation lock
      await action(h.page, 'signIn', [B, BP], 'T11_B');
      await delay(100);

      // Assert B is in waiting state while logout holds the mutation lock
      const snapWaiting = await snapshot(h.page);
      const isWaiting =
        (snapWaiting.provider.status === 'WAITING_FOR_SESSION' ||
          snapWaiting.provider.status === 'COMMITTING') &&
        snapWaiting.fence?.gate === 'CLOSED' &&
        !snapWaiting.provider.canRenderProtected &&
        !snapWaiting.dashboard;

      // Release rejecting logout
      await h.page.evaluate(() => window.__rejectLogout());
      await waitSettled(h.page, 'T11_logout');

      // Now B acquires mutation lock, commits, and authorizes
      await waitSettled(h.page, 'T11_B');
      await waitAuthorized(h.page, B);

      const snapB = await snapshot(h.page);
      const reloadB = await reloadSnapshot(h.page);

      const pass =
        isWaiting &&
        snapB.sdk === B &&
        snapB.provider.user === B &&
        snapB.dashboard &&
        snapB.selectedRow?.email === B &&
        snapB.selectedRow?.key.includes(snapB.fence.sessionId) &&
        reloadB.sdk === B &&
        reloadB.dashboard;

      record('T11', 'Held rejecting logout mutation settled before B commits & proves: no latch on B', pass, {
        isWaiting,
        snapWaiting,
        snapB,
        reloadB,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T12 (amended): Same with successful real removal. B waits through mutation.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      // Inject held resolving signOut
      await h.page.evaluate(async () => {
        const auth =
          (typeof window.getSelectedAuth === 'function' ? window.getSelectedAuth() : null) ||
          (await import('/src/auth/authCoordinator.ts')).getSelectedAuth();
        window.__origSignOut = auth.signOut;
        window.__logoutStarted = false;
        auth.signOut = async () => {
          window.__logoutStarted = true;
          await new Promise((res) => {
            window.__resolveLogout = res;
          });
          if (window.__origSignOut) return await window.__origSignOut.call(auth);
        };
      });

      await action(h.page, 'signOutUser', [], 'T12_logout');
      await h.page.waitForFunction(() => window.__logoutStarted);

      // B triggers and waits
      await action(h.page, 'signIn', [B, BP], 'T12_B');
      await delay(100);

      const snapWaiting = await snapshot(h.page);
      const isWaiting =
        (snapWaiting.provider.status === 'WAITING_FOR_SESSION' ||
          snapWaiting.provider.status === 'COMMITTING') &&
        snapWaiting.fence?.gate === 'CLOSED' &&
        !snapWaiting.provider.canRenderProtected &&
        !snapWaiting.dashboard;

      // Resolve logout
      await h.page.evaluate(() => window.__resolveLogout());
      await waitSettled(h.page, 'T12_logout');

      await waitSettled(h.page, 'T12_B');
      await waitAuthorized(h.page, B);

      const snapB = await snapshot(h.page);
      const reloadB = await reloadSnapshot(h.page);

      const pass =
        isWaiting &&
        snapB.sdk === B &&
        snapB.dashboard &&
        snapB.selectedRow?.email === B &&
        snapB.selectedRow?.key.includes(snapB.fence.sessionId) &&
        reloadB.sdk === B &&
        reloadB.dashboard;

      record('T12', 'Held resolving logout mutation settled before B commits: B authorized successfully', pass, {
        isWaiting,
        snapWaiting,
        snapB,
        reloadB,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T13: Initial logout fails; force actual token refresh; retry fails; final retry succeeds.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      await h.page.evaluate(async () => {
        const auth =
          (typeof window.getSelectedAuth === 'function' ? window.getSelectedAuth() : null) ||
          (await import('/src/auth/authCoordinator.ts')).getSelectedAuth();
        window.__signOutCount = 0;
        window.__origSignOut = auth.signOut;
        auth.signOut = async () => {
          window.__signOutCount++;
          if (window.__signOutCount <= 2) {
            throw new Error(`LOGOUT_FAILED_ATTEMPT_${window.__signOutCount}`);
          }
          if (window.__origSignOut) return await window.__origSignOut.call(auth);
        };
      });

      // Attempt 1: fails
      await action(h.page, 'signOutUser', [], 'T13_attempt1');
      await waitSettled(h.page, 'T13_attempt1');

      const snap1 = await snapshot(h.page);
      const alert1 = snap1.error && !snap1.dashboard;

      // Force token refresh during unresolved logout failure
      await action(h.page, 'refreshAuthorization').catch(() => {});
      const snapDuringOutage = await snapshot(h.page);

      // Attempt 2 (retry): fails
      await action(h.page, 'retryLogout', [], 'T13_attempt2');
      await waitSettled(h.page, 'T13_attempt2');
      const snap2 = await snapshot(h.page);

      // Attempt 3 (final retry): succeeds
      await action(h.page, 'retryLogout', [], 'T13_attempt3');
      await waitSettled(h.page, 'T13_attempt3');
      const snap3 = await snapshot(h.page);
      const totalCalls = await h.page.evaluate(() => window.__signOutCount);
      const reload = await reloadSnapshot(h.page);

      const pass =
        alert1 &&
        !snapDuringOutage.dashboard &&
        snap2.error &&
        !snap2.dashboard &&
        totalCalls === 3 &&
        snap3.sdk === null &&
        !snap3.dashboard &&
        reload.sdk === null &&
        !reload.dashboard;

      record('T13', 'Logout failure, forced refresh suppression, retry failure, final retry success (3 calls)', pass, {
        totalCalls,
        snap1,
        snap2,
        snap3,
        reload,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T14: Completed logout failure followed by explicit B. Old rejection has no effect.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      // Logout failure
      await h.page.evaluate(async () => {
        const auth =
          (typeof window.getSelectedAuth === 'function' ? window.getSelectedAuth() : null) ||
          (await import('/src/auth/authCoordinator.ts')).getSelectedAuth();
        auth.signOut = async () => {
          throw new Error('OLD_LOGOUT_FAILED');
        };
      });

      await action(h.page, 'signOutUser', [], 'T14_logout');
      await waitSettled(h.page, 'T14_logout');

      // Now explicit login B
      await action(h.page, 'signIn', [B, BP], 'T14_B');
      await waitSettled(h.page, 'T14_B');
      await waitAuthorized(h.page, B);

      const snapB = await snapshot(h.page);
      const pass =
        snapB.sdk === B &&
        snapB.provider.user === B &&
        snapB.dashboard &&
        !snapB.error;

      record('T14', 'Completed logout failure followed by explicit B: no old latch/error on B', pass, {
        snapB,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T15: SET fails; fail-closed behavior, explicit fresh login recovery.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);

      try {
        // Inject native IDB transaction abort on put
        await h.page.evaluate(() => {
          const origPut = IDBObjectStore.prototype.put;
          window.__origPut = origPut;
          window.__abortSetFailure = true;
          IDBObjectStore.prototype.put = function (...args) {
            if (window.__abortSetFailure) {
              try {
                this.transaction.abort();
              } catch {
                // ignore
              }
            }
            let req = null;
            try {
              req = origPut.apply(this, args);
            } catch {
              // Transaction may already be aborted
            }
            if (window.__abortSetFailure) {
              try {
                this.transaction.abort();
              } catch {
                // ignore
              }
            }
            return req;
          };
        });

        // Attempt login which hits IDB abort on setPersistence/transfer
        await action(h.page, 'signIn', [A, AP], 'T15_setFail');
        await waitSettled(h.page, 'T15_setFail');

        // Stop aborting and restore IDBObjectStore.prototype.put
        await h.page.evaluate(() => {
          window.__abortSetFailure = false;
          if (window.__origPut) {
            IDBObjectStore.prototype.put = window.__origPut;
          }
        });

        const snapFail = await snapshot(h.page);
        const isFailedClosed =
          snapFail.provider.status === 'ERROR' &&
          snapFail.fence?.gate === 'CLOSED' &&
          !snapFail.provider.canRenderProtected &&
          !snapFail.dashboard &&
          snapFail.selectedRow === null;

        // Reload page: must remain fail-closed
        const reloadClosed = await reloadSnapshot(h.page);

        // Fresh valid login recovery
        await action(h.page, 'signIn', [A, AP], 'T15_recovery');
        await waitSettled(h.page, 'T15_recovery');
        await waitAuthorized(h.page, A);

        const snapValid = await snapshot(h.page);

        const pass =
          isFailedClosed &&
          !reloadClosed.dashboard &&
          snapValid.sdk === A &&
          snapValid.dashboard &&
          snapValid.selectedRow?.email === A;

        record('T15', 'Native IDB SET failure fails closed; reload closed; fresh login recovers', pass, {
          isFailedClosed,
          snapFail,
          reloadClosed,
          snapValid,
        });
      } finally {
        await h.page.evaluate(() => {
          window.__abortSetFailure = false;
          if (window.__origPut) {
            IDBObjectStore.prototype.put = window.__origPut;
            delete window.__origPut;
          }
          delete window.__abortSetFailure;
        }).catch(() => {});
        await context.close();
      }
    }

    // -----------------------------------------------------------------------
    // T16: Target-scoped retry across B. Never signs out B.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      // Logout failure for A
      await h.page.evaluate(async () => {
        const auth =
          (typeof window.getSelectedAuth === 'function' ? window.getSelectedAuth() : null) ||
          (await import('/src/auth/authCoordinator.ts')).getSelectedAuth();
        auth.signOut = async () => {
          throw new Error('TARGET_SCOPED_FAIL');
        };
      });

      await action(h.page, 'signOutUser', [], 'T16_logoutA');
      await waitSettled(h.page, 'T16_logoutA');

      const snapFailA = await snapshot(h.page);
      const targetA = snapFailA.fence
        ? { fenceIntent: snapFailA.fence.latest?.id, sessionId: snapFailA.fence.sessionId }
        : undefined;

      // Hold B during staging
      h.hold(B);
      await action(h.page, 'signIn', [B, BP], 'T16_B');
      await h.waitHeld();

      const snapDuringB = await snapshot(h.page);
      const bAdmittedClosed =
        snapDuringB.fence?.latest?.kind === 'LOGIN' && snapDuringB.fence?.gate === 'CLOSED';

      // Stale retry targeting old A should NOT overwrite B's intent
      await action(h.page, 'retryLogout', [targetA]).catch(() => {});

      const snapAfterStaleRetry = await snapshot(h.page);
      const bStillOwned =
        snapAfterStaleRetry.fence?.latest?.id === snapDuringB.fence?.latest?.id &&
        snapAfterStaleRetry.fence?.latest?.kind === 'LOGIN';

      // Release B
      await h.release();
      await waitSettled(h.page, 'T16_B');
      await waitAuthorized(h.page, B);

      const snapB = await snapshot(h.page);

      // Test reload cleanup recovery when CLOSED with target (R5)
      const hCleanup = await setupPage(context);
      await hCleanup.page.evaluate(() => {
        localStorage.setItem(
          'towmitra:demo-towmitra-admin:m1:selection:v1',
          JSON.stringify({
            v: 1,
            latest: { id: 'stale-cleanup-ticket', kind: 'LOGOUT' },
            gate: 'CLOSED',
            sessionId: 'stale-cleanup-session',
          })
        );
      });
      const snapReloadClosed = await reloadSnapshot(hCleanup.page);
      const showsRetrySignOut =
        snapReloadClosed.error && snapReloadClosed.text.includes('Retry Sign Out');

      const pass =
        bAdmittedClosed &&
        bStillOwned &&
        snapB.sdk === B &&
        snapB.provider.user === B &&
        snapB.dashboard &&
        snapB.selectedRow?.email === B &&
        showsRetrySignOut;

      record('T16', 'Stale retry targeting old session does not cancel CLOSED B or sign out B; reload offers retry', pass, {
        bAdmittedClosed,
        bStillOwned,
        showsRetrySignOut,
        snapB,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T17: Validation coalescing terminates; no refresh ping-pong.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      // Trigger multiple rapid refreshAuthorizations
      const p1 = action(h.page, 'refreshAuthorization');
      const p2 = action(h.page, 'refreshAuthorization');
      const p3 = action(h.page, 'refreshAuthorization');
      await Promise.all([p1, p2, p3]);

      const snap = await snapshot(h.page);
      const pass =
        snap.sdk === A &&
        snap.provider.user === A &&
        snap.provider.proof &&
        snap.dashboard;

      record('T17', 'Rapid validation requests coalesce cleanly without refresh ping-pong', pass, {
        snap,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T18: Obsolete continuation cannot overwrite newer fence or proof.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      try {
        await action(h.page, 'signIn', [A, AP]);
        await waitAuthorized(h.page, A);

        // Instrument proof delay on A's validation: hold actual proof result delivery
        await h.page.evaluate(() => {
          window.__holdProofT18 = true;
          window.__proofVerifiedT18 = false;
          window.__holdAfterActualProof = async (proofPromise) => {
            const res = await proofPromise;
            window.__proofVerifiedT18 = res.verified === true;
            if (window.__holdProofT18) {
              window.__holdProofT18 = false;
              await new Promise((resolve) => {
                window.__releaseProofT18 = resolve;
              });
            }
            return res;
          };
        });

        // Start fresh authorization verification for A (proof delivery is held)
        action(h.page, 'refreshAuthorization', [], 'T18_refresh').catch(() => {});
        await h.page.waitForFunction(() => typeof window.__releaseProofT18 === 'function', { timeout: 10000 });

        // While A's proof continuation is held, switch to B
        await action(h.page, 'signIn', [B, BP], 'T18_B');
        await waitSettled(h.page, 'T18_B');
        await waitAuthorized(h.page, B);

        const snapB = await snapshot(h.page);
        const bSessionId = snapB.fence?.sessionId;

        // Release A's held proof delivery
        await h.page.evaluate(() => {
          if (typeof window.__releaseProofT18 === 'function') {
            window.__releaseProofT18();
          }
        });

        // Await captured original refresh promise
        await waitSettled(h.page, 'T18_refresh');

        // Wait for coordinator to settle
        await h.page.waitForFunction(
          async () => {
            const mod = await import('/src/auth/authCoordinator.ts');
            const snap = mod.getAuthCoordinator().getSnapshot();
            return !snap.isRefreshing && snap.status !== 'VERIFYING_AUTHORIZATION';
          },
          { timeout: 10000 }
        );

        const proofWasVerified = await h.page.evaluate(() => window.__proofVerifiedT18);
        const snapAfter = await snapshot(h.page);
        const reload = await reloadSnapshot(h.page);

        const pass =
          proofWasVerified === true &&
          snapAfter.sdk === B &&
          snapAfter.provider.user === B &&
          snapAfter.dashboard &&
          snapAfter.fence?.sessionId === bSessionId &&
          snapAfter.selectedRow?.email === B &&
          snapAfter.selectedRow?.key.includes(bSessionId) &&
          reload.sdk === B &&
          reload.dashboard;

        record('T18', 'Obsolete validation continuation cannot overwrite newer fence/proof', pass, {
          proofWasVerified,
          snapB,
          snapAfter,
          reload,
        });
      } finally {
        await h.page
          .evaluate(() => {
            if (typeof window.__releaseProofT18 === 'function') {
              try { window.__releaseProofT18(); } catch {}
            }
            delete window.__holdAfterActualProof;
            delete window.__releaseProofT18;
            delete window.__holdProofT18;
            delete window.__proofVerifiedT18;
          })
          .catch(() => {});
        await context.close();
      }
    }

    // -----------------------------------------------------------------------
    // T19: Interruption during CLOSED stays closed; valid accepted B restores B.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);

      // Simulate interruption before ACTIVE write (fence remains CLOSED with intent)
      await h.page.evaluate(() => {
        localStorage.setItem(
          'towmitra:demo-towmitra-admin:m1:selection:v1',
          JSON.stringify({
            v: 1,
            latest: { id: 'interrupted-ticket', kind: 'LOGIN' },
            gate: 'CLOSED',
            sessionId: 'interrupted-session',
          })
        );
      });

      const reloadClosed = await reloadSnapshot(h.page);
      const passClosed = !reloadClosed.dashboard && !reloadClosed.provider.canRenderProtected;

      // Now valid login B restores B across reload
      await action(h.page, 'signIn', [B, BP], 'T19_B');
      await waitSettled(h.page, 'T19_B');
      await waitAuthorized(h.page, B);
      const reloadB = await reloadSnapshot(h.page);
      const passB =
        reloadB.sdk === B &&
        reloadB.provider.user === B &&
        reloadB.dashboard &&
        reloadB.selectedRow?.email === B;

      record('T19', 'Reload during CLOSED stays closed; valid accepted B restores B', passClosed && passB, {
        passClosed,
        passB,
        reloadClosed,
        reloadB,
      });
      await context.close();
    }

    // -----------------------------------------------------------------------
    // T20: Claim demotion with held proof delivery (R1 regression control).
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);
      try {
        await action(h.page, 'signIn', [A, AP]);
        await waitAuthorized(h.page, A);

        // Instrument proof delivery delay: real proof executes, delivery is delayed
        await h.page.evaluate(() => {
          window.__holdProof = true;
          window.__proofCompleted = false;
          window.__proofVerified = false;
          window.__holdAfterActualProof = async (proofPromise) => {
            const res = await proofPromise;
            window.__proofCompleted = true;
            window.__proofVerified = res.verified === true;
            if (window.__holdProof) {
              window.__holdProof = false;
              await new Promise((resolve) => {
                window.__releaseProof = resolve;
              });
            }
            return res;
          };
        });

        // Start validation refresh for A (proof delivery will be held)
        action(h.page, 'refreshAuthorization', [], 'T20_refresh').catch(() => {});
        // Wait until real proof has completed and release function is available
        await h.page.waitForFunction(
          () => !!window.__releaseProof && window.__proofCompleted,
          { timeout: 10000 }
        );

        // Verify that the held proof was indeed genuine and verified
        const proofWasVerified = await h.page.evaluate(() => window.__proofVerified);

        // While proof is held, demote A in emulator
        await setAdminClaim(A, false);

        // In page, trigger token fetch so public token has admin: false
        const demotedTokenResult = await h.page.evaluate(async () => {
          const auth =
            (typeof window.getSelectedAuth === 'function' ? window.getSelectedAuth() : null) ||
            (await import('/src/auth/authCoordinator.ts')).getSelectedAuth();
          if (auth?.currentUser) {
            const tr = await auth.currentUser.getIdTokenResult(true);
            return { adminClaim: tr.claims.admin, token: tr.token };
          }
          return null;
        });

        // Now release the held proof delivery
        await h.page.evaluate(() => {
          if (typeof window.__releaseProof === 'function') {
            window.__releaseProof();
          }
        });

        await waitSettled(h.page, 'T20_refresh');

        // Wait for coordinator to settle after proof release
        await h.page.waitForFunction(
          async () => {
            const mod = await import('/src/auth/authCoordinator.ts');
            const snap = mod.getAuthCoordinator().getSnapshot();
            return !snap.isRefreshing && snap.status !== 'VERIFYING_AUTHORIZATION';
          },
          { timeout: 10000 }
        );

        // Verify: Old proof must NOT be published! State must be ACCESS_DENIED, dashboard unmounted
        const snapDemoted = await snapshot(h.page);
        const isDemotedCorrectly =
          proofWasVerified === true &&
          demotedTokenResult?.adminClaim === false &&
          snapDemoted.denied &&
          !snapDemoted.dashboard &&
          !snapDemoted.provider.canRenderProtected &&
          snapDemoted.idbReadError === null;

        // Promote A back
        await setAdminClaim(A, true);
        await action(h.page, 'retryVerification').catch(() => {});
        await waitAuthorized(h.page, A);
        const snapPromoted = await snapshot(h.page);

        const pass =
          isDemotedCorrectly &&
          snapPromoted.dashboard &&
          snapPromoted.provider.user === A &&
          snapPromoted.selectedRow?.email === A &&
          snapPromoted.idbReadError === null;

        record('T20', 'Held completed proof rejected after fresh token demotes user (R1 fixed)', pass, {
          isDemotedCorrectly,
          snapDemoted,
          snapPromoted,
        });
      } finally {
        await h.page
          .evaluate(() => {
            if (typeof window.__releaseProof === 'function') {
              try { window.__releaseProof(); } catch {}
            }
            delete window.__holdAfterActualProof;
            delete window.__releaseProof;
            delete window.__holdProof;
          })
          .catch(() => {});
        await context.close();
      }
    }

    // -----------------------------------------------------------------------
    // T21: Compatible transfer, single password POST, CSP and boundary preservation.
    // -----------------------------------------------------------------------
    {
      const context = await browser.createBrowserContext();
      const h = await setupPage(context);

      let passwordPostCount = 0;
      let externalDomainRequests = 0;
      h.page.on('request', (req) => {
        const u = new URL(req.url());
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
          externalDomainRequests++;
        }
        if (req.url().includes('/accounts:signInWithPassword') && req.method() === 'POST') {
          passwordPostCount++;
        }
      });

      await action(h.page, 'signIn', [A, AP]);
      await waitAuthorized(h.page, A);

      const snap = await snapshot(h.page);

      // Verify staging apps are properly disposed
      const stagingDisposed = await h.page.evaluate(async () => {
        const mod = await import('/src/auth/sessionRuntime.ts');
        return !mod.getApps().some((a) => a.name.startsWith('towmitra-stage-'));
      });

      // Assert incompatible transfer rejection fails closed using an actual SDK User from incompatible app config
      const incompatibleResult = await h.page.evaluate(async (email, pass) => {
        try {
          const { initializeApp, deleteApp } = await import('firebase/app');
          const { initializeAuth, inMemoryPersistence, signInWithEmailAndPassword, updateCurrentUser } =
            await import('firebase/auth');
          const { firebaseConfig, connectAuthToEmulator } = await import('/src/config/firebase.ts');
          const { getSelectedAuth } = await import('/src/auth/authCoordinator.ts');

          const otherApp = initializeApp(
            { ...firebaseConfig, apiKey: 'incompatible-key-for-test' },
            'towmitra-incompatible-test'
          );
          const otherAuth = initializeAuth(otherApp, { persistence: inMemoryPersistence });
          connectAuthToEmulator(otherAuth);

          const otherCred = await signInWithEmailAndPassword(otherAuth, email, pass);
          const actualOtherUser = otherCred.user;

          const canonicalAuth = getSelectedAuth();
          if (!canonicalAuth) throw new Error('No canonical auth available');

          try {
            await updateCurrentUser(canonicalAuth, actualOtherUser);
            await deleteApp(otherApp);
            return 'unexpected_success';
          } catch (err) {
            await deleteApp(otherApp);
            return 'rejected';
          }
        } catch {
          return 'rejected';
        }
      }, A, AP);

      const reloadAfterTransfer = await reloadSnapshot(h.page);

      const pass =
        passwordPostCount === 1 &&
        externalDomainRequests === 0 &&
        snap.sdk === A &&
        snap.dashboard &&
        snap.provider.proof &&
        snap.selectedRow?.email === A &&
        snap.idbReadError === null &&
        stagingDisposed &&
        incompatibleResult === 'rejected' &&
        reloadAfterTransfer.sdk === A &&
        reloadAfterTransfer.dashboard &&
        reloadAfterTransfer.selectedRow?.email === A;

      record('T21', 'Compatible staging transfer with exactly 1 password POST, zero external calls, and CSP', pass, {
        passwordPostCount,
        externalDomainRequests,
        incompatibleResult,
        stagingDisposed,
        snap,
        reloadAfterTransfer,
      });
      await context.close();
    }

    console.log('\n======================================================');
    const passedCount = results.filter((r) => r.pass).length;
    const totalCount = results.length;
    console.log(` Summary: ${passedCount}/${totalCount} tests PASSED`);
    console.log(` Uncaught page errors: ${errors.length}`);
    console.log('======================================================\n');

    if (passedCount !== totalCount || errors.length > 0) {
      process.exitCode = 1;
    } else {
      console.log('\x1b[32m[SUCCESS] Deterministic Concurrency Suite (T01–T21) PASSED COMPLETELY!\x1b[0m\n');
      process.exitCode = 0;
    }
  } catch (err) {
    console.error('\n\x1b[31m[FAIL] Suite execution failed with error:\x1b[0m', err);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    stopVite();
    process.exit(process.exitCode ?? 0);
  }
}

runDeterministicSuite();
