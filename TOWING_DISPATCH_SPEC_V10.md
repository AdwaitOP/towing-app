# Towing Dispatch System — Current Technical Specification (V10)

**As inspected:** 28 September 2026. **Status:** current engineering source of truth for the inspected working tree. [BUILD_PHASES_CURRENT.md](BUILD_PHASES_CURRENT.md) carries execution status and next gates. Historical intent remains in `TOWING_DISPATCH_SPEC_V9.md`, `BUILD_PHASES.md`, and `BUILD_PHASES_SIMPLE.md`; none is a current lifecycle authority. Where a feature is present only as unclosed working-tree code, this document says so explicitly.

## 1. System and authority boundaries

The localized Navi Mumbai platform connects customers to tow-truck drivers. Customers book through the Meta WhatsApp flow; a protected phone-booking path is planned for the admin panel. The platform charges a booking fee and deducts commission from a driver wallet at job acceptance. The quoted tow fare is informational and is paid directly to the driver. There is no standalone customer app.

The repository contains a Flutter Android driver app, Node.js Firebase Functions, Firestore and Storage rules, seed schemas, and backend tests. WhatsApp and Razorpay webhooks handle booking and payment. Backend dispatch owns offer sequencing, assignment, cancellation, refund, and durable recovery. The web admin panel described in V9 is **PLANNED**; its five screens, claim-gated writes, and phone-booking flow are not present as a built frontend. Do not infer a deployed system from repository code.

The central driver-duty distinction is:

```text
Android service/native ACTIVE
    ≠ executable background worker/bootstrap ready
    ≠ worker-owned server readiness
```

Milestone 1 established the middle boundary. Milestone 2 is **CLOSED — INDEPENDENTLY VERIFIED** for genuine worker-owned server readiness and in-flight operation retirement (exact closing verdict: **MILESTONE 2 INDEPENDENTLY VERIFIED**). Milestone 3 is **CLOSED — INDEPENDENTLY VERIFIED** for server intent terminality, strict validators, and recovery epoch fencing (exact closing verdict: **MILESTONE 3 INDEPENDENTLY VERIFIED**). Milestone 4 is **CLOSED — INDEPENDENTLY VERIFIED** for controller reconciliation, duty UI, and logout (exact closing verdict: **MILESTONE 4 INDEPENDENTLY VERIFIED**). Milestone 5 is **NEXT**: **FINAL COMPLETE STAGE 3 AUDIT**.

## 2. Driver app layers and user flow

`lib/main.dart` initializes the Flutter binding and Firebase before constructing Firebase-dependent services or `DriverApp`. `SessionResolver` observes Firebase Auth, then `drivers/{uid}`: unauthenticated users see phone login; incomplete profiles see setup; unsubmitted, pending, and rejected verification route through KYC; approved drivers reach `DispatchHubScreen`. Profile load errors and malformed records fail closed rather than overwriting backend data. `AuthService` uses WhatsApp OTP Functions and a Firebase custom token, not Firebase Phone Auth SMS.

The hub uses `DutyController` for requested duty transitions, compensation, cleanup retry, and reconciliation. `DriverLocationService` handles permission checks, coordinates, native foreground-service calls, and duty Functions. `DriverLocationTaskHandler` runs in a separate background Dart isolate. `NativeOwnershipCoordinator` (Dart bridge and Kotlin authority) owns the cross-engine boundary; `DutyForegroundService` owns Android foreground execution. `DutySession` carries `uid`, `sessionId`, and `generation` in Dart; the **canonical native worker epoch also includes `lifecycleSeq`** in the durable owner and acquisition token. Never use the smaller Dart object as the complete destructive-operation identity.

The current hub, disclosure, ban banner, map view, and KYC screens are present. V9's complete offer/job card, wallet top-up, accepted-job actions, and admin UI remain product scope rather than a claim of complete driver-app delivery. Mapbox display depends on `MAPBOX_ACCESS_TOKEN`; the view has a placeholder path when unset.

## 3. Firebase and startup boundaries

The app uses Firebase Auth for driver custom-token sessions, Firestore for profiles/duty/location and dispatch data, Functions in `asia-south1` for OTP and duty operations, and Storage for verification photos and invoices. The backend uses the Admin SDK. Auth, Firestore, Functions, and Storage emulator connectors exist in `FirebaseBootstrap`.

**Main isolate — IMPLEMENTED; physical startup VERIFIED.** `main()` calls `WidgetsFlutterBinding.ensureInitialized()`, awaits `FirebaseBootstrap.initialize()`, checks that `[DEFAULT]` exists, and only then creates `AuthService` and `ProfileService`. Failure shows a standalone initialization error app, avoiding a Firebase-dependent UI path. Debug builds default to emulator mode unless `USE_FIREBASE_EMULATOR` overrides it. Emulator host defaults to `10.0.2.2`, which is suitable for Android emulator routing; a physical Pixel needs separate host/network setup. Release mode defaults to production and `buildProductionOptions()` rejects missing required `FIREBASE_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_PROJECT_ID`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_STORAGE_BUCKET`, including a fabricated sender ID of `0`. `FUNCTIONS_BASE_URL` is also required when its production URL resolver is used. The supplied physical Pixel 7 Pro verification covers normal debug APK launch, `[DEFAULT]` initialization, AuthScreen rendering, cold start, and process recreation without `[core/no-app]` or an immediate red screen. It does **not** cover physical-device OTP or backend emulator interaction.

**Background isolate — IMPLEMENTED bootstrap boundary.** `DriverLocationTaskHandler.onStart()` obtains the engine-bound immutable acquisition token before failure-prone work, initializes its own Flutter binding and Firebase path, loads the worker payload and canonical durable owner, checks exact identity and authenticated UID, then requests native bootstrap-readiness confirmation. Main-isolate Firebase initialization does not initialize this isolate. Failed token delivery or bootstrap is fail closed; cleanup uses the captured token or native creator authority, never a mutable current-owner fallback. Successful native confirmation grants restart readiness and allows `_isInitialized`; it does not establish server readiness.

## 4. Canonical epoch and native authority — Milestone 1 CLOSED

The immutable worker epoch is **`(uid, sessionId, generation, lifecycleSeq)`**. `uid` fences account changes, `sessionId` identifies a duty attempt, `generation` distinguishes reused sessions and backend duty revisions, and monotonic `lifecycleSeq` distinguishes native starts, including same-sessionId reuse. Exact-epoch comparisons govern persisted owner validation, start authorization, engine-bound MethodChannel calls, stop/removal, locks, restart grants, and stale-worker teardown. `NativeOwnershipCoordinator.kt` validates persisted owner and payload records strictly; malformed or contradictory records fail closed. Global channel calls cannot borrow the current owner to perform worker bootstrap cleanup.

Terminology mapping: canonical worker epoch `generation` corresponds to Firestore `dutyGeneration`. They represent the same epoch dimension at different system boundaries.

`NativeOwnershipCoordinator.atomicStartService` validates arguments, callback handle, payload epoch, and sequence, persists owner/payload and callback data, and launches the repository-owned `DutyForegroundService` with an immutable token. A `PENDING_START` result is not success: Dart waits for native `ACTIVE` plus a running service and revokes a timed-out start. Android promotion uses a location foreground service and notification, including Android's foreground-start deadline path. Failure is reported as failure rather than a fabricated ACTIVE state. The service can return sticky restart behavior only through its restart validation path; explicit terminal stop uses non-sticky behavior.

`atomicStopService` requires all four epoch fields. A stale S1 stop may clean S1's retained binding, but cannot remove S2's durable owner, notification, locks, or running worker. S1 completion after S2 replacement is fenced by exact comparisons; same `sessionId` with different generation/sequence remains distinct. Durable owner removal follows effective asynchronous task/engine teardown. Duplicate STOP callers join pending teardown and receive a single completion result. A native stop, foreground removal, or persistence failure retains retry authority (`FAILED_CLEANUP`/pending state) and cannot be reported as successful cleanup. The Dart service likewise retains a captured cleanup token rather than falling back to a mutable current owner.

The native service owns partial WakeLock and Wi-Fi lock acquisition for its epoch when enabled by start options. Lock transfer/release compares the token; stale teardown cannot release a replacement epoch's locks. These locks support continued background execution and network access; they do not prove GPS, Firebase, or server health.

The worker callback handle is a **nonzero signed 64-bit integer**, including valid negative values. Native parsing rejects null, zero, strings, booleans, floating-point values, decimal/big-integer objects, and invalid persisted representations. The handle is stored for authorized process reconstruction; a handle alone is not restart authority.

The persisted/native state names include `PENDING_START`, `ACTIVE`, `PENDING_STOP`, `STOPPED`, and `FAILED_CLEANUP`; they are not interchangeable with Dart `TrackingHealth` or Firestore `isOnDuty`. Start and stop may remain pending while engine work completes. `FAILED_CLEANUP` preserves a truthful retry path.

For system restart, the service validates an ACTIVE durable owner, matching payload, callback handle, and monotonic sequence. When restart lifecycle/readiness keys are present, it also requires `LIFECYCLE_PERMIT_RESTART` and an exact positive restart-readiness grant. Terminal stop/revocation invalidates that grant and records terminal lifecycle, while a permitted interruption can reconstruct the exact worker. **Source-level compatibility exception:** `handleSystemRestart()` currently enters a legacy path when neither restart-contract key is present, so the universal claim “every persisted ACTIVE restart requires the positive grant” is not supported by current code. The frozen Milestone 1 contract and that legacy branch should be reconciled if later work demonstrates a concrete violation. Malformed, contradictory, superseded, or expressly revoked restart state fails closed. This separates **restartable interruption** from **terminal teardown**.

`DutyForegroundService.startBackgroundTask()` completes FlutterLoader initialization before allocating `FlutterEngine`. It immediately places the engine in a cleanup scope, registers an engine-bound native channel, constructs the repository-owned `DutyForegroundTask`, calls its second-phase `initialize()` to register the background channel and execute Dart, then publishes the binding. Failure at engine, plugin/channel, task, or binding boundaries destroys constructed resources and unregisters the engine channel. Teardown may remain asynchronous; STOP completion waits for effective destruction. The checked source and Android JVM tests support these boundaries, but do not imply every device-specific failure was physically exercised.

## 5. Server duty and location pipeline — current code versus next gate

Current duty Functions include `prepareDutyActivation`, `startDutySession`, `cancelDutyActivation`, `endDutySession`, `reportLocationHeartbeat`, and `recoverActiveJobSession`. The controller prepares an activation intent, starts native tracking, activates server duty with an initial position, compensates failed starts, and ends server duty before native off-duty teardown. It exposes reconciliation and cleanup retry. The server allocates generation during preparation; `startDutySession` activates that coherent generation with `isOnDuty=true`, an active session, initial location, and `workerReady=false`. The worker task repeats every 5 seconds at the foreground-task event layer; actual heartbeat operations are single-flight and subject to auth, owner, GPS, and server checks. App configuration defines a 45-second default heartbeat interval, but the inspected task path uses the 5-second repeat event and does not consume that interval. Neither value guarantees a successful server write at that cadence.

The worker independently checks Auth UID and Firestore duty/approval, obtains a position with a 10-second location timeout, rechecks ownership after awaited GPS, calls `reportLocationHeartbeat`, and performs a post-network owner check. Milestones 2 and 3 closed the worker-owned readiness, in-flight retirement, intent terminality, strict validators, and recovery epoch fencing contracts. Native ACTIVE and executable/bootstrap readiness remain distinct from server readiness. The main isolate and controller have no readiness authority.

**Milestone 2 — CLOSED — INDEPENDENTLY VERIFIED:** Frozen M2-A through M2-I all independently passed. Exact closing verdict: **MILESTONE 2 INDEPENDENTLY VERIFIED**. The active worker authority is exactly `(uid, sessionId, generation, lifecycleSeq)`; pending activation authority is exactly `(uid, sessionId, generation, attemptSeq)`. `attemptSeq` fences pre-activation attempts only, including same-session pending reprepare; `lifecycleSeq` becomes authoritative for the active native worker and is never fabricated or defaulted for authoritative activation. `startDutySession` fails closed without a valid native `lifecycleSeq`. The server allocates `generation` during preparation, and it remains coherent across preparation, `DutySession`, the native worker token, `startDutySession`, Firestore `dutyGeneration`, and worker heartbeat.

`workerReady` begins false. Only the genuine background worker can establish it through its own exact heartbeat; S2 independently earns readiness rather than inheriting S1 readiness. Stale, epochless, or partial heartbeats cannot mutate current state. Stale S1 end/cancel cannot mutate current S2; stale pending S1 cancellation cannot cancel current S2 intent. Server-side fencing protects late in-flight requests, while GPS/callable work that cannot be physically cancelled is logically fenced.

**Milestone 3 — CLOSED — INDEPENDENTLY VERIFIED:** Frozen M3-A through M3-I all independently passed. Exact closing verdict: **MILESTONE 3 INDEPENDENTLY VERIFIED**.

Accepted Milestone 3 invariants:
- terminal activation/recovery intents are immutable against stale/unrelated mutation;
- `startDutySession` consumes only exact current pending authority: `(uid, sessionId, generation, attemptSeq)`;
- activated retry corresponds only to the exact current active epoch: `(uid, sessionId, generation, lifecycleSeq)`;
- duplicate/stale end and cancellation paths cannot rewrite unrelated terminal state;
- authoritative server inputs and persisted identity fail closed when missing, malformed, noncanonical, unsafe, or stale;
- explicitly supplied malformed optional identity selectors do not silently fall back to generated identities;
- generation advancement cannot overflow `Number.MAX_SAFE_INTEGER`;
- recovery requires exact source authority:
  - `uid`
  - `activeDutySessionId`
  - `dutyGeneration`
  - `lifecycleSeq`
  - `expected active job`
- delayed S1 recovery cannot rotate S2, including same-session reuse with a newer generation/lifecycle sequence;
- a recovery request ID binds one exact source epoch and one exact resulting recovery outcome;
- recovery rotation begins with:
  - `lifecycleSeq = null`
  - `workerReady = false`
- the new recovered worker binds its new native `lifecycleSeq` exactly once before readiness becomes true;
- stale recovery responses are checked against fresh server-authoritative state before native foreground adoption;
- cached `DriverProfile` state alone is not recovery-adoption authority.

**Milestone 4 — CLOSED — INDEPENDENTLY VERIFIED:** CONTROLLER RECONCILIATION + DUTY UI + LOGOUT. Frozen M4-A through M4-H independently passed. Exact closing verdict: **MILESTONE 4 INDEPENDENTLY VERIFIED**.

Accepted M4 invariants: **M4-A**, exact reconciliation and startup authority require the full `(uid, sessionId, generation, lifecycleSeq)` tuple; cached/profile state cannot prove native authority, disagreement requires reconciliation, stale profile authority cannot stop a newer confirmed worker, and missing/conflicting authority fails closed. **M4-B**, READY requires server on-duty, literal `workerReady == true`, confirmed exact native epoch, and agreement on all four fields; a profile update advances STARTING → READY only for that already-confirmed worker. **M4-C**, UID change or winning go-off/logout fences stale go-on continuations before native/server start or destructive effects. **M4-D**, server teardown and native cleanup stay distinct; residual cleanup retains the full tuple and same `lifecycleSeq`, and only confirmed residue absence clears cleanup-required state. **M4-E**, stale profile/results cannot restore superseded controller authority; UID-A completion cannot mutate UID-B duty, health, readiness, error, or cleanup state, and stale operations compensate only authority they own. **M4-F**, active job or offer blocks unsafe go-off/logout, with fresh authoritative engagement overriding stale cached OFF; no full offer/job workflow was added. **M4-G**, logout requires fresh/current server authority and proven native absence or exact cleanup; cached OFF does not authorize sign-out, native read failure is UNKNOWN, Auth `signOut` is final, same-UID concurrent logout is single-flight, different UIDs remain isolated, and active job/offer blocks logout. **M4-H**, native/server read failure removes READY, uncertainty/reconciliation failure disables unsafe duty controls, cached profile cannot heal unknown native authority, cleanup-required survives transient error dismissal, and green READY needs confirmed exact native authority.

Independent final closure directly reproduced server L1/native L2 lifecycle disagreement with no destructive L2 stop, a cached L1 callback after mismatch, the actual `DispatchHubScreen` / `didUpdateWidget` callback path, native authority read failure followed by a cached profile callback, exact STARTING → READY for a confirmed worker, wrong lifecycle/generation/session/UID readiness rejection, and quick C/D/E/F/G/H regression samples. Disposable Dart/model probes, actual Flutter hub/widget probes, and representative M1/M2/M3 regressions yielded primary model **8/8**, hub widget **4/4**, corrected C/D/E/F/G/H sample **50/50**, and affected M1/M2/M3 checks **11/11**. An older raw probe had two obsolete assertions assuming profile-only ON established native authority; the corrected disposable probe aligned with the frozen M4 contract and passed.

Separate candidate evidence before closure: focused M4 acceptance **97 passed**; combined M4/controller/hub **184 passed**; full Flutter suite **497 passed**; representative M1/M2/M3/native ownership **86 passed**; `flutter analyze` no issues; fresh Android JVM run passed; debug APK built successfully. Final independent closure used fakes/model/widget/native-unit evidence, with no claimed physical Android device, physical Android process-death, Firebase Emulator Suite, or live/production-backend evidence. Affected M1/M2/M3 regressions stayed healthy, and those milestones remain closed.

**Milestone 5 — NEXT:** **FINAL COMPLETE STAGE 3 AUDIT.** Next engineering action: **VERIFY THE COMPLETE STAGE 3 IMPLEMENTATION AGAINST THE FROZEN M1–M4 CONTRACTS.** M5 is verification and integration closure, not another feature milestone.

## 6. Backend booking and dispatch

V9 and `docs/phase4_decisions.md` define the accepted backend intent. Current Functions contain WhatsApp and Razorpay webhooks, the isolated fare calculator, OTP handlers, invoicing, dispatch/offer/cancellation/refund modules, and recovery workers. Firestore rules, Storage rules, schema references, and Phase 3–5 tests are present. The detailed Phase 4 decision record supersedes older V9 assumptions where they differ. Repository presence and tests are source/automated-test evidence; this inspection does not establish live deployment or provider behavior.

The WhatsApp flow collects pickup, destination, and towing category; quotes the booking fee and informational fare. `createJobAndQuote(jobId, …)` is the shared creation path intended for later phone booking. Webhook signatures, processing leases, stable job IDs, payment-link recovery, and request idempotency prevent duplicate logical work. Razorpay payment success hands a paid `pending_offer` job to durable dispatch and booking-fee-only invoicing. Phase 4 matches approved/on-duty/eligible drivers, limits candidate search and Ola Matrix spend, creates sanitized top-level offers, uses Cloud Tasks for expiry, and accepts through an atomic wallet/assignment transaction. Customer cancellation, driver cancellation, finite exhaustion, refund requests, outbox delivery, and lease-based reconciliation have separate backend paths. Provider/configuration gates in `BUILD_PHASES.md` and `docs/phase4_decisions.md` still require release-specific proof before live paid traffic.

The app's driver-duty server path must not be confused with complete job-offer UI delivery. The admin panel remains planned, including custom `admin: true` claim checks, audited approvals/config writes, wallet forgiveness, and phone-booking attribution. V9's legal, pricing, and provider-rate assertions are historical product assumptions requiring release review, not statements revalidated by this documentation task.

## 7. Authentication, foreground behavior, and release configuration

Driver OTP originates in backend WhatsApp handlers and is exchanged for a Firebase custom token. The app resolves the authenticated driver profile and KYC status before duty UI. Backend duty calls use authenticated UID, and server activation requires approved verification. Physical Pixel connectivity to local Auth/Firestore/Functions/Storage emulators for interactive OTP/backend tests is **DEFERRED**. Emulator tests are separate evidence from physical-device tests and production backend tests.

Android manifest/configuration declares the repository-owned location foreground service; notification and foreground promotion are part of START truthfulness. Startup timeout or lost authorization revokes the exact start. For restart-contract-aware records, restart requires the positive persisted readiness grant together with valid callback, payload, owner, and lifecycle state. The narrowly scoped legacy compatibility path for records containing neither restart-contract key remains as documented in the native lifecycle section. Terminal STOP removes notification and locks for the matching epoch after effective teardown. A foreground notification or ACTIVE owner does not certify server readiness.

Release builds need real Firebase options and all provider secrets/configuration; missing options fail closed. This specification does not claim a deployed admin site, live payment traffic, production OTP delivery, production emulator connectivity, or a completed whole-system launch audit. Follow the Phase 4 production gate, verify pricing/provider policy with actual accounts, and complete Phases 5–7 before launch.

## 8. Evidence, acceptance, and AI workflow

Evidence labels are distinct: **source inspection**, **Dart unit/widget**, **JVM/model**, **Android JVM/unit**, **Android emulator/runtime**, **physical device**, **Firebase emulator**, and **real backend**. A pass in one layer is not proof of another. The supplied frozen Milestone 1 closure record states Checkpoint 1 **15/15**, Checkpoint 2 **16/16**, Checkpoint 3 **12/12**, and final Flutter suite **371/371**, with exact verdict **MILESTONE 1 CHECKPOINT 3 INDEPENDENTLY VERIFIED**. Current source and maintained tests were inspected here; the full original independent run artifacts were not found as a separate local report, so these counts are attributed to the supplied closure record and are not a new rerun.

The final independent Milestone 2 evidence reports focused M2/controller/location/bootstrap/ownership/hub **166/166 PASS**, full Flutter **393/393 PASS**, targeted Phase 5 Node suites **58/58 PASS**, additional independent same-session/first-duty/start/active-epoch assertions **40/40 PASS**, affected Android ownership regressions **22/22 PASS**, and a successfully built fresh debug APK. Milestone 3 closure independently verified frozen M3-A through M3-I with exact verdict **MILESTONE 3 INDEPENDENTLY VERIFIED**. Evidence layers for Milestone 3 closure included Node/FakeFirestore, controlled transaction-retry modeling where required, Dart unit/model, Flutter unit/widget, Android JVM, and local debug APK build. Explicitly preserved evidence limitations: no claimed Firebase Emulator Suite evidence, Android runtime/emulator M3 evidence, physical-device M3 evidence, or real-backend M3 evidence. Files named `.emulator.test.js` in these Node test suites are not Firebase Emulator Suite evidence and must not be inferred as such. Affected Milestone 1 and Milestone 2 regression checks remained healthy during M3; Milestones 1 and 2 remain **CLOSED — INDEPENDENTLY VERIFIED**.

Permanent process:

```text
DEFINE SCOPE → FREEZE ACCEPTANCE CONTRACT → IMPLEMENT
             → CANDIDATE ACCEPTANCE → INDEPENDENT VERIFICATION → CLOSE MILESTONE
```

The Orchestrator / Architectural Review role defines boundaries, freezes the contract before implementation, reviews reports, resolves scope disputes, and decides closure. The Implementation Agent changes production and candidate tests, preserves prior frozen assets, and reports exact evidence; it cannot weaken frozen gates to obtain a PASS. The Independent Verification Agent inspects the current working-tree code, reproduces the same frozen contract, runs adversarial probes, and returns a closure or blocking verdict without trusting implementation-agent PASS claims. Closed milestones stay closed unless later work directly violates a frozen invariant. Hypothetical hardening alone does not reopen them; a concrete reproduced correctness regression against an established invariant can block closure. Historical frozen acceptance assets remain immutable. The process arose because Milestone 1's acceptance requirements expanded during implementation, causing repeated implementation/audit cycles; future scope is fixed before implementation.

### Current AI tooling (September 2026)

| Stable role | Current tool mapping |
|---|---|
| Implementation Agent | Gemini 3.8 Flash High via Google Antigravity |
| Independent Verification Agent | GPT-6 Codex / GPT-6 Sol |
| Orchestrator / Architectural Review | ChatGPT reasoning workflow |

These names are replaceable tooling assignments, not architectural dependencies. Older model-specific instructions in V9 and the historical roadmaps are superseded.

## 9. Phase 5 Stage 3 status and deferred work

| Item | Status | Evidence boundary |
|---|---|---|
| Milestone 1 — native worker ownership, lifecycle, bootstrap readiness | **CLOSED — INDEPENDENTLY VERIFIED** | Supplied frozen closure record plus inspected code/tests |
| Normal-app Firebase startup interlude | **VERIFIED ON PHYSICAL PIXEL** | Debug launch, `[DEFAULT]`, AuthScreen, cold start, process recreation |
| Milestone 2 — genuine worker-owned server readiness + in-flight retirement | **CLOSED — INDEPENDENTLY VERIFIED** | Frozen M2-A through M2-I independently passed; exact verdict **MILESTONE 2 INDEPENDENTLY VERIFIED** |
| Milestone 3 — server intent terminality + strict validators + recovery epoch fencing | **CLOSED — INDEPENDENTLY VERIFIED** | Frozen M3-A through M3-I independently passed; exact verdict **MILESTONE 3 INDEPENDENTLY VERIFIED**; Node/FakeFirestore, controlled transaction retry, Dart unit/model, Flutter unit/widget, Android JVM, local debug APK build (no Firebase emulator, Android runtime/emulator, physical device, or real backend claimed) |
| Milestone 4 — CONTROLLER RECONCILIATION + DUTY UI + LOGOUT | **CLOSED — INDEPENDENTLY VERIFIED** | Frozen M4-A through M4-H passed; exact verdict **MILESTONE 4 INDEPENDENTLY VERIFIED**; final independent model/widget/native-unit evidence remains distinct from candidate suite/JVM/APK evidence |
| Milestone 5 — FINAL COMPLETE STAGE 3 AUDIT | **NEXT** | Verify complete Stage 3 implementation against frozen M1–M4 contracts |
| Physical Pixel OTP/backend access to local emulators | **DEFERRED** | Network setup and interactive verification outstanding |

## 10. V9 → V10 change record

V10 incorporates the inspected immutable four-field native epoch; engine-bound authority; exact-epoch START/STOP, replacement, restart, terminal revocation, lock, callback, engine/task, partial-construction, and cleanup-retry semantics; executable bootstrap-readiness boundary; separate main/worker Firebase initialization; fail-closed normal startup; the server-readiness distinction; and the closed Milestone 2, Milestone 3, and Milestone 4 contracts. It replaces model-dependent engineering instructions with frozen acceptance contracts and stable roles, isolates current tools in one section, and updates Stage 3 status. Historical V9 backend product intent remains traceable, while unsupported deployment/completion claims are not promoted to current fact.
