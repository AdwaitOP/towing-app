# Build Phases — Towing Dispatch System

Companion to `towing_dispatch_spec_v9.md`. One phase = one Antigravity mission. Don't start phase N+1 until phase N's diff is reviewed and committed — each phase's prompt should tell the agent to read the full spec for context but build **only** that phase's scope.

Order matters — phases 1–4 are strictly sequential (each depends on the last). Phases 5 and 6 can run in either order (or in parallel, if you're comfortable running two missions at once) once 1–4 are done. Phase 7 is always last.

---

## Phase 1 — Data Model & Security Rules

**Depends on:** nothing (starting point)
**Model:** Claude Sonnet 4.6 (Thinking) — **Mode:** Planning

**Scope:**
- Every collection under "Firestore Collections": `drivers`, `jobs`, `whatsapp_sessions`, `processed_requests`, `pricing_config` (with its `booking_tiers`, `fare_formula`, `cancellation_policy` sub-objects), `usage_counters`, `admin_actions`, `business_config`
- `firestore.rules` enforcing the access boundaries described across Parts 2 and 3 (drivers can't touch their own `walletBalance`/`verificationStatus`/`bannedUntil`/`strictMode`; sensitive/config/audit writes are Cloud Function-only, with admin actions routed through audited backend callables)
- `storage.rules` for `driver_verification/{driverId}/{id|rc|selfie}.jpg` and `invoices/{jobId}.pdf` per the access rules in Part 2/3
- A scheduled Cloud Function stub for the DPDP retention/deletion policy on verification photos (logic can be minimal for now — the point is the schema and trigger exist)
- `functions/` directory structure — no business logic yet

**Explicitly excluded:** any Cloud Function logic beyond the retention-job stub, any UI, `fareCalculator.js`

**Definition of done:**
- [ ] Rules reject an unauthenticated client write to any collection
- [ ] Rules reject a driver writing their own `walletBalance` / `verificationStatus` / `bannedUntil` / `strictMode`
- [ ] Verification photos are stored with Storage rules restricted to the uploading driver + admin-claim users only — never publicly readable
- [ ] Config docs match the exact field names/starter values in the spec (this is what phases 2–4 read from — a typo here breaks everything downstream)

---

## Phase 2 — Fare Calculation Module

**Depends on:** Phase 1 (`fare_formula` / `booking_tiers` schema must exist)
**Model:** Claude Sonnet 4.6 (Thinking) — **Mode:** Planning

**Scope:**
- `functions/src/fareCalculator.js` — isolated, no dependency on webhook/dispatch code
- Reads `fare_formula` / `booking_tiers` from Firestore with the ~5 min cache described in the spec
- `scripts/testFare.js` local test script

**Explicitly excluded:** anything that calls this module — no webhooks, no dispatch logic yet

**Definition of done:**
- [ ] `fareCalculator.js` is a standalone, unit-testable module reading tunable constants from Firestore
- [ ] `testFare.js` runs standalone and produces correct output for a few hand-checked distance/vehicle/time combinations

---

## Phase 3 — Messaging, Payments & Invoicing

**Depends on:** Phases 1–2
**Model:** Claude Sonnet 4.6 (Thinking) — **Mode:** Planning

**Scope:**
- The shared `createJobAndQuote(jobId, customerPhone, pickupCoords, destCoords, requestedTruckType, channel)` function — built here, called from here by the WhatsApp flow, and reused (not rebuilt) by Phase 6's phone-booking screen
- WhatsApp webhook: signature verification, idempotency via `processed_requests`, State 1 (pickup) through State 5, the cancel command
- Driver OTP send/verify Cloud Functions delivered through an approved Meta authentication template configured in `business_config/main.whatsappOtpTemplate`
- Razorpay webhook: signature verification, booking-fee success → triggers Dispatch Logic (Phase 4) + GST Invoicing, refund-success handling
- GST Invoicing: PDF generation scoped to the booking fee only, sequential numbering via atomic transaction on `business_config.invoiceNumberCounter`, delivered as a WhatsApp document

**Explicitly excluded:** the two-stage driver-selection / offer-cascade logic itself (Phase 4 owns everything past "payment succeeded, hand off to dispatch")

**Production traffic gate:** do not route live payment traffic to Phase 3 until
Phase 4 provides a durable consumer or backlog reconciler for every
`pending_offer` job. `triggerDispatch(jobId)` remains a boundary, not a Phase 3
dispatch implementation.

**Definition of done:**
- [ ] WhatsApp and Razorpay webhook signatures verified on every request
- [ ] Webhook idempotency: duplicate message IDs / retried requests never cause duplicate side effects
- [ ] Reclaimable per-session processing lease implemented (owner + expiry)
- [ ] Preallocated `jobId` persisted in session before external Razorpay work
- [ ] Retries reuse the same `jobId` to prevent duplicate logical bookings
- [ ] Driver OTP delivered via an approved WhatsApp authentication template, not free-form text or Firebase Phone Auth SMS; missing template configuration fails closed
- [ ] Driver OTP expiry, resend cooldown, send-window blocking, and per-challenge verification attempts read `business_config/main.otpPolicy`; the OTP pepper remains in Secret Manager
- [ ] The platform's Razorpay integration only ever collects the booking fee and driver commission — the full towing fare never flows through the platform
- [ ] GST invoice PDFs are generated only for the booking fee amount — never for the full tow fare
- [ ] Each logical paid job receives one immutable invoice number via an atomic Firestore transaction; retries cannot increment the counter twice (external failures can still leave operational numbering gaps)
- [ ] (partial — fully verified only after Phase 6) WhatsApp-originated and phone-originated bookings both call the same `createJobAndQuote()` function

---

## Phase 4 — Dispatch, Cancellation & Ban Logic

**Depends on:** Phases 1–3 (triggered by Phase 3's Razorpay webhook)
**Model:** Claude Sonnet 4.6 (Thinking) — **Mode:** Planning
*(This is the highest-risk phase in the whole build — race conditions and money math. Don't rush the plan review here.)*

**Owner-approved Phase 4 contract:** `docs/phase4_decisions.md`. That ADR is
authoritative for Phase 4 state transitions, schema/rules/index additions, and
the production gate. Stage 0 is documentation only; Phase 4 implementation
starts with the schema/rules/index work defined there.

**Scope:**
- Durable, lease-based consumer/reconciler for every paid `pending_offer`; the
  Phase 3 callback is only an accelerator and may occur zero, one, or many times
- Driver eligibility requires approved verification, `isOnDuty === true`, no
  current ban, fresh location, sufficient wallet, no active job/offer, and the
  backend-owned `canFlatbed`/`canPulling` capability required by the request
- Configurable Haversine rounds `[10, 20, 35]` km, maximum 30 unique candidates
  per generation, and maximum 10 Matrix candidates per round
- Ola ranking by routed ETA, routed distance, then driver UID; bounded provider
  retry followed by explicit Haversine degraded mode
- Top-level sanitized `job_offers` feed, one active offer per driver, 45-second
  Cloud Tasks expiry, explicit penalty-free decline, and sequential cascade
- Atomic/idempotent accept with one-active-job enforcement and wallet debit plus
  permanent ledger entry in the same transaction
- Authenticated/idempotent `accepted -> in_progress -> completed` callables
- Full cancellation/refund policy: customer-cancel (non-refundable booking fee
  plus unconditional driver wallet credit), genuine no-driver exhaustion
  (Razorpay refund), accepted-driver self-cancel ramp and redispatch, strict-mode
  reban, and Asia/Kolkata calendar-month reset
- Shared transactional usage counters for Ola Matrix requests and pairs; the
  production pair/cost cap and GCP budget recipients remain deployment config
- Durable refund requests and WhatsApp notification outbox; external side
  effects always follow committed database state and are reconciled by leases
- Dispatch-run `assigned` is nonterminal: accepted-driver cancellation returns
  the same generation to `active`, preserves/excludes all attempted candidates,
  preserves authoritative `dispatch_runs.nextCandidateIndex` exactly, and never
  writes `finalizedAt`; worker lease fields exist only on the job
- Customer cancellation marker has deterministic precedence over driver cancel:
  driver cancel requires cancellation request/resolution/terminal timestamps
  all null, resolution state `none`, and no customer provenance; otherwise it
  is a stable non-penalizing no-op
- No-driver refund calls lock provider key
  `refund_no_driver_found_{jobId}` and hash the exact canonical payment/amount
  identity before the first provider request; every attempt binds that stored
  key to request header `X-Refund-Idempotency`
- Submitted refunds remain durably scheduled for reclaimable provider-status
  reconciliation so missed webhooks cannot strand them; webhook/fetch races
  converge transactionally and `confirmed` is absorbing
- Current `dispatch_config.olaMonthlyPairCap` and current usage are revalidated
  before every Matrix pair reservation; the cap is not snapshotted as run authority

**Explicitly excluded:** any UI — this phase is pure backend logic, testable via Cloud Function invocations/emulator, not through the apps

**Definition of done:** *(this phase carries most of the checklist — go through each individually rather than skimming)*
- [ ] Stage 1 schema, sanitized projections, rules, indexes, and rules-emulator tests match `docs/phase4_decisions.md`
- [ ] A durable consumer/reconciler recovers every paid `pending_offer` job and every missed/delayed timeout or external-effect marker
- [ ] Job acceptance is a single atomic transaction guarding against double-assignment
- [ ] ACCEPT JOB calls are idempotent via a client-generated `requestId`
- [ ] One active job and one active offer per driver are enforced transactionally through backend-owned fields
- [ ] 45s offer timeout implemented via Cloud Tasks, not an in-function sleep
- [ ] Ola Maps Matrix API is only called against a pre-filtered shortlist, never the full on-duty fleet
- [ ] Matching uses server-owned towing capabilities and the approved finite search/ranking policy
- [ ] Ola provider failure enters bounded retry/Haversine degraded mode or operational hold, never `no_driver_found`
- [ ] Matrix request and origin×destination pair usage are both counted transactionally; no historical 4.5M cap is treated as authoritative
- [ ] GCP budget alert + deployment-configured `usage_counters` circuit breaker in place
- [ ] Customer-paid booking fees are always non-refundable on customer cancellation
- [ ] Driver commission refund on customer-initiated cancellation is unconditional (not subject to the ramp)
- [ ] Driver self-cancellation ramp reads `cancellation_policy` from Firestore, not hardcoded percentages
- [ ] Driver cancellation policy is snapshotted/versioned at acceptance and HALF-UP paise arithmetic preserves the original commission exactly
- [ ] Accepted-driver cancellation applies the policy, releases/excludes that driver, and redispatches the same customer job without terminally cancelling it
- [ ] The accepted-driver reset transaction requires `cancellationRequestedAt`, `cancellationResolvedAt`, and `cancelledAt` all null, `cancellationResolutionState=none`, and no customer provenance; it exactly clears current assignment/offer/job-lease fields, preserves immutable job/run evidence and `dispatch_runs.nextCandidateIndex` exactly, returns job `assigned -> ready` and run `assigned -> active` in the same generation, and atomically stores its receipt and deterministic ledger entry
- [ ] Normal driver self-cancellation from `in_progress` is rejected pending an approved support policy
- [ ] `monthlyCancelCount` correctly resets on calendar-month rollover
- [ ] Once `strictMode` is `true`, every subsequent driver-initiated cancellation within that same calendar month forfeits 100% and issues a fresh 7-day ban
- [ ] `strictMode` resets to `false` on calendar-month rollover
- [ ] Dispatch's driver-selection step excludes any driver with `bannedUntil` in the future
- [ ] Dispatch's driver-selection step also excludes any driver whose `verificationStatus` isn't `approved`
- [ ] Missing/malformed/stale driver, wallet, policy, or location data fails closed with an operational reason
- [ ] `no_driver_found` is written only after the persisted finite generation is genuinely exhausted
- [ ] Wallet ledger operation IDs and signed integer-paise equations match the Stage 0 ADR; driver-cancel entries retain complete policy/evaluation evidence, including zero-credit 100% forfeitures
- [ ] A no-driver refund stores immutable provider inputs and request hash before the call; every attempt sends `X-Refund-Idempotency` with the exact stored key; uncertain initiation retries reconcile first; submitted requests have reclaimable due provider-fetch reconciliation; and signed webhook/provider-fetch races converge to absorbing `confirmed`
- [ ] Legacy `pending_offer` bootstrap uses a status-only discovery query before materializing safe operational defaults, so missing ordered fields cannot hide paid work
- [ ] Wallet top-up is implemented and validated before live driver acceptance is enabled
- [ ] Paid live traffic remains disabled until the durable workflow passes real Firestore Emulator concurrency and failure-injection tests

---

## Phase 5 — Flutter Driver App

**Depends on:** Phases 1–4 (needs real backend to call)
**Model:** Gemini 3.7 Flash (Medium) for UI — escalate to Sonnet only if it stalls on the camera-capture or background-location pieces specifically
**Mode:** Planning for the first pass, Fast is fine for iteration afterward

**Scope:** everything in Part 1 — theming, localization, WhatsApp-OTP login, profile creation, KYC capture flow, wallet, dispatch hub, job card, accept/complete/cancel actions, OS location constraints

**Definition of done:**
- [ ] Onboarding includes a background-location disclosure screen ahead of OS permission prompts
- [ ] ID/RC/selfie capture uses in-app camera only — gallery/file picker disabled for all three
- [ ] A consent screen is shown before document capture
- [ ] Driver app shows a ban-status banner and previews the current cancellation penalty before confirming a cancel

---

## Phase 6 — Admin Panel

**Depends on:** Phases 1–4
**Model:** Gemini 3.7 Flash (Medium) for the 5 screen shells — **Sonnet 4.6 (Thinking)** specifically for the Config Editor's validation/write Cloud Function
**Mode:** Planning for the first pass

**Scope:** all 5 screens (Verification Queue, Live Jobs, Driver Management, Config Editor, Phone Booking), Firebase Auth + `admin: true` custom-claim gating, the one-time claim-bootstrap script

**Definition of done:**
- [ ] Admin Panel auth checks the `admin: true` custom claim on every write, not just at login
- [ ] "Forgive this cancellation" calls the existing audited wallet-credit function — no direct Firestore balance edits
- [ ] Every admin approval, rejection, forgiveness, and config change is written to `admin_actions` with who/what/why/when
- [ ] Config Editor writes go through a Cloud Function with type validation, not a raw client write
- [ ] Phone bookings are logged to `admin_actions` and tagged `channel: 'phone'` / `createdByAdmin`
- [ ] WhatsApp-originated and phone-originated bookings both call the same `createJobAndQuote()` function *(closes out the Phase 3 partial item)*

---

## Phase 7 — Final Audit

**Depends on:** everything
**Model:** Claude Opus 4.6 (Thinking) — one deliberate pass, not iterative back-and-forth

**Scope:** go through every remaining unchecked box in v9's full Verification Checklist against the actual built system, end to end. Fix anything that fails before considering this done.
