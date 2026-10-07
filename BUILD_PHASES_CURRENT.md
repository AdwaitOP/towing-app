# Towing Dispatch — Current Detailed Build Roadmap

**Reconciled:** 28 September 2026. Read [TOWING_DISPATCH_SPEC_V10.md](TOWING_DISPATCH_SPEC_V10.md) for the technical architecture and frozen invariants. `BUILD_PHASES.md`, `BUILD_PHASES_SIMPLE.md`, and V9 preserve historical planning; they do not override current source or verified behavior. This roadmap describes inspected repository state, not a production deployment certificate.

## Status and sequencing

**COMPLETED** means relevant code and local evidence exist, with no claim of full production acceptance. **CLOSED — INDEPENDENTLY VERIFIED** requires a frozen-contract closing verdict. **NEXT** identifies the next contract to freeze/finish. **PLANNED** is accepted direction without completed acceptance. **DEFERRED** is intentionally outside the current gate. **BLOCKED** requires a demonstrated dependency that prevents work; none is asserted merely because verification remains. **DOCUMENTATION AMBIGUITY** marks an unresolved source conflict.

Phases 1→4 remain sequential backend foundations. Phase 5 (driver app) and Phase 6 (admin panel) may progress after that backend base, subject to the Phase 4 live-traffic gate. Phase 7 is the whole-system audit after both client surfaces and release dependencies are complete. The simple roadmap expresses this product order; the detailed historical roadmap adds specific backend gates. Neither historical document describes the current Stage 3 native architecture.

| Phase | Current status | What is present and what remains |
|---|---|---|
| 1 — data model and security | **COMPLETED** (repository baseline) | Firestore/Storage rules, seed/schema references, Functions structure, and rule tests exist. Validate deployed rules/config before real users. |
| 2 — fare calculation | **COMPLETED** (repository baseline) | Isolated `fareCalculator.js` and `scripts/testFare.js` exist. Release pricing values and provider policy still require owner review. |
| 3 — WhatsApp booking, payment, invoice | **COMPLETED** (repository baseline, production gate retained) | Webhook, OTP, job creation, Razorpay, and invoice modules/tests exist. Live paid traffic depends on Phase 4's durable consumer and external provider configuration. |
| 4 — dispatch, cancellation, recovery | **COMPLETED** as repository implementation; live gate **PLANNED** | Dispatch/offer, Cloud Tasks, wallet/refund/outbox, rules, and Phase 4 tests exist. `docs/phase4_decisions.md` controls accepted state transitions and its paid-live-traffic/concurrency/failure-injection gate; this documentation pass did not certify that gate or deployment. |
| 5 — Flutter driver app | **IN PROGRESS** | Auth/profile/KYC, hub, duty, location, native foreground service, and closed Milestones 1–4 exist. Stage 3 Milestone 5 final audit and full offer/job/wallet user journeys remain. |
| 6 — admin panel | **PLANNED** | Backend primitives and admin intent exist; the five-screen protected web frontend and phone-booking attribution are not built in this repository. |
| 7 — final whole-system audit | **PLANNED** | End-to-end payment, dispatch, clients, admin, security, cost, refund, and failure review after release configuration and integration. |

## Phase 5 implementation path

Earlier Phase 5 work established Flutter theming/localization, WhatsApp OTP/custom-token sign-in, profile routing, KYC consent/capture/review states, a dispatch hub shell, duty controller, and location permission/disclosure paths. The current working tree includes substantial unstaged and untracked app/native/backend changes, so this roadmap must be read against that tree before implementation. Presence of a screen or unit test does not mean every V9 product action is wired or that physical backend behavior is verified.

### Stage 3 Milestone 1 — native worker ownership / lifecycle / bootstrap readiness

**Status: CLOSED — INDEPENDENTLY VERIFIED.** Preserve its frozen acceptance assets. The canonical epoch is `(uid, sessionId, generation, lifecycleSeq)`. The closed scope includes strict persisted-owner validation, engine-bound acquisition and cleanup authority, truthful START/STOP and foreground deadline, S1→S2 and same-sessionId replacement isolation, terminal versus restartable lifecycle, exact positive restart-readiness grant, strict nonzero signed 64-bit callback handle, epoch-owned WakeLock/Wi-Fi lock, repository-owned `DutyForegroundTask`, FlutterLoader-before-engine construction, engine/channel teardown, bootstrap readiness, failure/cleanup retry truthfulness, and duplicate STOP joining. The supplied independent closure record reports Checkpoint 1 **15/15 PASS**, Checkpoint 2 **16/16 PASS**, Checkpoint 3 **12/12 PASS**, and final Flutter suite **371/371 PASS**. Exact closing verdict: **MILESTONE 1 CHECKPOINT 3 INDEPENDENTLY VERIFIED**. These historical results are not a new test run in this documentation task.

Milestone 1 certifies executable worker/bootstrap readiness. Native ACTIVE, worker bootstrap ready, and server ready are separate states. No later theoretical hardening expands this closed contract by itself. A reproduced regression violating a frozen invariant must be treated as a real defect.

### Firebase normal-app startup interlude

**Status: VERIFIED ON PHYSICAL PIXEL.** The main isolate now initializes `[DEFAULT]` before Firebase-dependent services and fails closed to a startup error UI. The supplied Pixel 7 Pro verification covers normal debug APK launch, no `[core/no-app]`, AuthScreen rendering, cold start, and process recreation. Background-isolate Firebase startup remains a separate Milestone 1 worker path. Physical Pixel connectivity to local Firebase emulators for interactive OTP, Firestore, Functions, and Storage work is **DEFERRED**; do not record it as tested.

### Stage 3 Milestone 2 — genuine worker-owned server readiness + in-flight retirement

**Status: CLOSED — INDEPENDENTLY VERIFIED.** Exact closing verdict: **MILESTONE 2 INDEPENDENTLY VERIFIED**. Frozen M2-A through M2-I all independently passed. Native ACTIVE does not imply server readiness, and executable/bootstrap readiness remains distinct from server readiness. Only the genuine background worker can establish `workerReady=true`; main-isolate/controller readiness authority is absent.

Active worker authority is exactly `(uid, sessionId, generation, lifecycleSeq)`; pending activation authority is exactly `(uid, sessionId, generation, attemptSeq)`. `attemptSeq` is only a pre-activation attempt/version fence and advances on same-session pending reprepare. `lifecycleSeq` becomes authoritative for the active native worker, is never fabricated or defaulted for authoritative activation, and `startDutySession` fails closed without a valid native value. The server allocates `generation` during preparation; it remains coherent across preparation, `DutySession`, native worker token, `startDutySession`, Firestore `dutyGeneration`, and worker heartbeat.

`workerReady` begins false, and S2 independently earns it through S2's exact worker heartbeat. Stale, epochless, or partial heartbeats cannot mutate current state. Stale S1 end/cancel cannot mutate current S2; stale pending S1 cancellation cannot cancel current S2 intent. Server-side fencing protects late in-flight requests. GPS/callable work that cannot be physically cancelled is logically fenced.

Final independent evidence: focused M2/controller/location/bootstrap/ownership/hub **166/166 PASS**; full Flutter **393/393 PASS**; targeted Phase 5 Node suites **58/58 PASS**; additional independent same-session/first-duty/start/active-epoch assertions **40/40 PASS**; affected Android ownership regressions **22/22 PASS**; fresh debug APK build **successful**. These are Dart unit/model, Flutter widget, Node/FakeFirestore, Android JVM, and local APK build evidence. Affected Milestone 1 regressions passed; Milestone 1 stays closed. Milestone 2 closure did not include Firebase emulator, Android emulator/runtime, physical-device M2 execution, or real-backend evidence. `.emulator.test.js` names do not make the Node suites Firebase emulator tests.

For the independent audit, use the frozen M2-A through M2-I gates and label Dart, JVM, Android runtime, Firebase emulator, and physical evidence separately. Candidate test names or Implementation Agent PASS reports do not replace those gates.

### Stage 3 Milestone 3 — SERVER INTENT TERMINALITY + STRICT VALIDATORS + RECOVERY EPOCH FENCING

**Status: CLOSED — INDEPENDENTLY VERIFIED.** Exact closing verdict: **MILESTONE 3 INDEPENDENTLY VERIFIED**. Frozen M3-A through M3-I all independently passed.

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

Evidence boundary: closure included Node/FakeFirestore, controlled transaction-retry modeling where required, Dart unit/model, Flutter unit/widget, Android JVM, and local debug APK build. Explicitly preserved evidence limitations: no claimed Firebase Emulator Suite evidence, Android runtime/emulator M3 evidence, physical-device M3 evidence, or real-backend M3 evidence. Do not infer those layers from `.emulator.test.js` filenames. Affected regression checks for Milestone 1 and Milestone 2 remained healthy during M3; Milestones 1 and 2 remain **CLOSED — INDEPENDENTLY VERIFIED**.

### Stage 3 Milestone 4 — CONTROLLER RECONCILIATION + DUTY UI + LOGOUT

**Status: CLOSED — INDEPENDENTLY VERIFIED.** Exact closing verdict: **MILESTONE 4 INDEPENDENTLY VERIFIED**. Frozen M4-A through M4-H independently passed.

Accepted Milestone 4 invariants:
- **M4-A — Exact reconciliation / startup authority:** active worker authority is `(uid, sessionId, generation, lifecycleSeq)`. Cached/profile state alone cannot prove current native authority. Server/native disagreement requires exact reconciliation; stale profile authority cannot destructively stop a newer confirmed native worker. Missing or conflicting authority fails closed.
- **M4-B — Readiness truthfulness:** READY requires server on-duty state, literal `workerReady == true`, a currently confirmed exact native worker epoch, and exact agreement on all four epoch fields. Profile updates may advance STARTING → READY only for an already-confirmed exact worker epoch; profile data alone cannot establish native authority.
- **M4-C — Go-on intent fencing:** stale or superseded go-on work cannot start native/server authority after a UID change or a winning go-off/logout. Async continuations are fenced before destructive side effects.
- **M4-D — Truthful go-off / cleanup:** server teardown and native cleanup remain distinct. Residual cleanup retains the full native tuple and retries with the same `lifecycleSeq`; success requires confirmed residue absence, and ineffective cleanup cannot clear cleanup-required state.
- **M4-E — Stale async / cross-UID isolation:** stale profile/results cannot restore superseded controller authority. UID-A completions cannot mutate UID-B duty, health, readiness, error, or cleanup state. Stale operations may compensate only authority they own.
- **M4-F — Engagement guards:** active job or offer blocks unsafe go-off/logout. Fresh authoritative engagement state overrides stale cached OFF assumptions. M4 did not add a full offer/job workflow.
- **M4-G — Logout:** logout establishes fresh/current server authority; cached OFF alone cannot authorize sign-out. Native authority must be proven absent or exactly cleaned; native read failure is UNKNOWN, not ABSENT. Auth `signOut` is final; same-UID concurrent logout is single-flight, different UIDs remain isolated, and active job/offer blocks logout.
- **M4-H — Unknown / failure / UI truthfulness:** native/server authority read failure removes READY. Uncertainty or reconciliation failure disables unsafe duty controls; cached profile updates cannot heal unknown native authority. Cleanup-required state survives transient error dismissal, and UI cannot show green READY without confirmed exact native authority.

Final independent closure directly reproduced server L1/native L2 lifecycle disagreement without destructive L2 stop; a cached L1 callback after mismatch; the actual `DispatchHubScreen` / `didUpdateWidget` callback path; native authority read failure followed by cached profile callback; exact STARTING → READY for a confirmed worker; rejection of wrong lifecycle, generation, session, and UID readiness; and quick C/D/E/F/G/H regression samples. Independent evidence used disposable Dart/model probes, actual Flutter hub/widget probes, and representative M1/M2/M3 regressions: primary model **8/8**, actual hub widget **4/4**, corrected C/D/E/F/G/H regression sample **50/50**, and representative affected M1/M2/M3 checks **11/11**. Two obsolete assertions in an older raw probe expected profile-only ON state to establish native authority; the corrected disposable probe followed the frozen M4 contract and passed. Those obsolete assertions are not an M4 failure.

Candidate evidence before closure was focused M4 acceptance **97 passed**, combined M4/controller/hub **184 passed**, full Flutter suite **497 passed**, representative M1/M2/M3/native ownership **86 passed**, `flutter analyze` with no issues, a passing fresh Android JVM run, and a successful debug APK build. Candidate results are distinct from independent closure. Final independent closure used fakes/model/widget/native-unit evidence; it did not establish physical Android device, physical Android process-death, Firebase Emulator Suite, or live/production-backend evidence. Representative affected M1/M2/M3 regressions remained healthy; Milestones 1–3 stay **CLOSED — INDEPENDENTLY VERIFIED**.

### Stage 3 Milestone 5 — final complete Stage 3 audit

**Status: NEXT.** **FINAL COMPLETE STAGE 3 AUDIT.** Next engineering action: **VERIFY THE COMPLETE STAGE 3 IMPLEMENTATION AGAINST THE FROZEN M1–M4 CONTRACTS.** This is verification and integration closure, not another feature milestone. Report evidence by layer and close Stage 3 only on an independent verdict. This audit does not replace Phase 7's wider booking/payment/admin system audit.

## Remaining product phases and release gates

**Phase 5 after Stage 3 — PLANNED:** finish offer presentation and client-generated idempotent accept/start/complete/cancel actions against the existing sanitized `job_offers` and callables; wallet/commission views and top-up path; penalty preview and ban state; end-to-end permissions and background-location UX; and full localization/accessibility checks. Preserve in-app camera-only ID/RC/selfie capture and consent/disclosure requirements. Verify physical-device behavior separately from widget tests.

**Phase 6 — PLANNED:** protected admin sign-in with `admin: true` server checks; verification queue; live jobs; driver management and audited wallet forgiveness; validated Config Editor Function; and phone booking through shared `createJobAndQuote()` with authenticated `createdByAdmin` and `admin_actions` attribution. The historical five-screen plan is retained as intent, not represented as a shipped panel.

**Phase 7 — PLANNED:** exercise customer WhatsApp booking and payment, dispatch and offer races, driver actions, admin actions, invoice/refund delivery, Firestore/Storage permissions, provider costs, and failure recovery end to end. Close Phase 4's paid-live-traffic gate before routing actual payment traffic. Real backend/provider, Android emulator, Firebase emulator, and physical-device results need separate labels. Release configuration includes Firebase options, Functions URL where used, provider credentials/templates, dispatch/Ola caps and budget recipients, and owner-approved pricing/tax policy. Do not assume any is validated by source inspection.

**DEFERRED:** physical Pixel-to-local-emulator networking for interactive OTP/backend tests; any product expansion beyond the existing WhatsApp/customer and protected admin paths. Add further deferred items only with an explicit owner decision and evidence.

## Acceptance-first execution contract

```text
DEFINE SCOPE → FREEZE ACCEPTANCE CONTRACT → IMPLEMENT
             → CANDIDATE ACCEPTANCE → INDEPENDENT VERIFICATION → CLOSE MILESTONE
```

The Orchestrator / Architectural Review role sets scope and boundaries, freezes acceptance before implementation, reviews implementation and independent findings, resolves disputes, and decides closure. The Implementation Agent inspects code, changes production and candidate acceptance tests, protects previous frozen assets, and reports exact evidence. It cannot rewrite a frozen gate merely to pass. The Independent Verification Agent distrusts implementation-agent PASS claims, inspects the current tree, independently reproduces the same frozen contract, probes adversarial cases, and returns an exact closing or blocking verdict. Candidate tests may evolve before freeze; frozen historical assets may not be weakened afterward. Closed milestones remain closed unless later work directly violates a frozen invariant. Theoretical hardening alone is not a new gate; a reproduced correctness regression against an existing invariant is.

Record evidence as source inspection, Dart unit/widget, JVM/model, Android JVM/unit, Android emulator/runtime, physical device, Firebase emulator, or real backend. Never treat one as proof of another. This process was adopted after Milestone 1 requirements expanded during implementation and caused repeated audit cycles; scope and tests now stabilize first.

### Current AI tooling (September 2026)

| Stable role | Current assignment |
|---|---|
| Implementation Agent | Gemini 3.8 Flash High via Google Antigravity |
| Independent Verification Agent | GPT-6 Codex / GPT-6 Sol |
| Orchestrator / Architectural Review | ChatGPT reasoning workflow |

These assignments can change without changing the engineering contract. Historical model-specific recommendations are superseded.

## Historical reconciliation and closure status

`BUILD_PHASES_SIMPLE.md` supplies the seven-phase product order and broad Phase 5/6 parallelism. `BUILD_PHASES.md` supplies detailed Phase 1–4 gates, including Phase 4's decision record and paid-live-traffic restriction, and more precise Phase 6/7 deliverables. Both predate the current Stage 3 native implementation. V9 supplies broader product architecture but predates Milestone 1 and the Firebase startup repair. This roadmap preserves valid sequencing while adding actual Stage 3 closure and the next gate.

**Milestone 2 closure reconciliation:** the frozen M2-A through M2-I contract independently passed with the exact verdict **MILESTONE 2 INDEPENDENTLY VERIFIED**. `workerReady` is earned only by the genuine background worker's exact heartbeat; the main isolate/controller has no readiness authority. Affected Milestone 1 regressions remained healthy; Milestone 1 remains closed.

**Milestone 3 closure reconciliation:** the frozen M3-A through M3-I contract independently passed with the exact closing verdict **MILESTONE 3 INDEPENDENTLY VERIFIED**. Terminal activation/recovery intents are immutable against stale/unrelated mutation; `startDutySession` consumes only exact current pending authority `(uid, sessionId, generation, attemptSeq)`; activated retry corresponds only to exact current active epoch `(uid, sessionId, generation, lifecycleSeq)`; duplicate/stale end and cancellation paths cannot rewrite unrelated terminal state; server inputs and persisted identity fail closed; generation advancement cannot overflow `Number.MAX_SAFE_INTEGER`; recovery requires exact source authority (`uid`, `activeDutySessionId`, `dutyGeneration`, `lifecycleSeq`, `expected active job`) and cannot rotate newer epochs; recovery request IDs bind exact source epoch and outcome; recovery rotation begins with `lifecycleSeq = null, workerReady = false` and binds new `lifecycleSeq` once before readiness; stale recovery responses check fresh authoritative server state; and cached `DriverProfile` alone is not adoption authority. Evidence boundary covers Node/FakeFirestore, controlled transaction-retry modeling where required, Dart unit/model, Flutter unit/widget, Android JVM, and local debug APK build. No Firebase Emulator Suite, Android runtime/emulator M3, physical-device M3, or real-backend M3 evidence is claimed. Affected Milestone 1 and Milestone 2 regression checks remained healthy during M3; Milestones 1 and 2 remain closed.

**Milestone 4 closure reconciliation:** frozen M4-A through M4-H independently passed with exact verdict **MILESTONE 4 INDEPENDENTLY VERIFIED**. Final independent evidence and candidate evidence are separated in the Milestone 4 section above. Representative M1/M2/M3 checks remained healthy, so all four milestones are **CLOSED — INDEPENDENTLY VERIFIED**. Milestone 5 (**FINAL COMPLETE STAGE 3 AUDIT**) is **NEXT**; verify the complete Stage 3 implementation against frozen M1–M4 contracts.
