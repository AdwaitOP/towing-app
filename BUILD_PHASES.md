# Build Phases — Towing Dispatch System

Companion to `towing_dispatch_spec_v9.md`. One phase = one Antigravity mission. Don't start phase N+1 until phase N's diff is reviewed and committed — each phase's prompt should tell the agent to read the full spec for context but build **only** that phase's scope.

Order matters — phases 1–4 are strictly sequential (each depends on the last). Phases 5 and 6 can run in either order (or in parallel, if you're comfortable running two missions at once) once 1–4 are done. Phase 7 is always last.

---

## Phase 1 — Data Model & Security Rules

**Depends on:** nothing (starting point)
**Model:** Claude Sonnet 4.6 (Thinking) — **Mode:** Planning

**Scope:**
- Every collection under "Firestore Collections": `drivers`, `jobs`, `whatsapp_sessions`, `processed_requests`, `pricing_config` (with its `booking_tiers`, `fare_formula`, `cancellation_policy` sub-objects), `usage_counters`, `admin_actions`, `business_config`
- `firestore.rules` enforcing the access boundaries described across Parts 2 and 3 (drivers can't touch their own `walletBalance`/`verificationStatus`/`bannedUntil`/`strictMode`; only Cloud Functions and admin-claim users can write `pricing_config`, `business_config`, `usage_counters`, `admin_actions`)
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
- The shared `createJobAndQuote(customerPhone, pickupCoords, destCoords, vehicleType, channel)` function — built here, called from here by the WhatsApp flow, and reused (not rebuilt) by Phase 6's phone-booking screen
- WhatsApp webhook: signature verification, idempotency via `processed_requests`, State 0 (tow/mechanic intent) through State 5, the mechanic-lookup sub-flow via Ola Places, the cancel command
- Driver OTP send/verify Cloud Functions (WhatsApp-delivered)
- Razorpay webhook: signature verification, booking-fee success → triggers Dispatch Logic (Phase 4) + GST Invoicing, refund-success handling
- GST Invoicing: PDF generation scoped to the booking fee only, sequential numbering via atomic transaction on `business_config.invoiceNumberCounter`, delivered as a WhatsApp document

**Explicitly excluded:** the two-stage driver-selection / offer-cascade logic itself (Phase 4 owns everything past "payment succeeded, hand off to dispatch")

**Definition of done:**
- [ ] WhatsApp and Razorpay webhook signatures verified on every request
- [ ] Webhook idempotency: duplicate message IDs / retried requests never cause duplicate side effects
- [ ] Driver OTP delivered via WhatsApp, not Firebase Phone Auth SMS
- [ ] The platform's Razorpay integration only ever collects the booking fee and driver commission — the full towing fare never flows through the platform
- [ ] GST invoice PDFs are generated only for the booking fee amount — never for the full tow fare
- [ ] Invoice numbers are assigned via an atomic Firestore transaction — sequential, no gaps or duplicates
- [ ] The mechanic-lookup WhatsApp flow uses Ola Places only and never creates a job or payment link
- [ ] (partial — fully verified only after Phase 6) WhatsApp-originated and phone-originated bookings both call the same `createJobAndQuote()` function

---

## Phase 4 — Dispatch, Cancellation & Ban Logic

**Depends on:** Phases 1–3 (triggered by Phase 3's Razorpay webhook)
**Model:** Claude Sonnet 4.6 (Thinking) — **Mode:** Planning
*(This is the highest-risk phase in the whole build — race conditions and money math. Don't rush the plan review here.)*

**Scope:**
- Two-stage driver selection: Haversine pre-filter → Ola Maps Matrix API on shortlist, excluding banned/unapproved drivers
- Job state machine and the atomic accept-transaction (status + `offeredTo` check, wallet balance check, deduction)
- 45s offer timeout via Cloud Tasks + cascade to next candidate
- Full cancellation & refund policy: customer-cancel (non-refundable + unconditional driver refund), no-driver-found (Razorpay refund), driver self-cancel ramp (1 free → 20/30/40/50% → ban), strict-mode reban, calendar-month resets for both `monthlyCancelCount` and `strictMode`
- `usage_counters` circuit breaker + GCP budget alert setup

**Explicitly excluded:** any UI — this phase is pure backend logic, testable via Cloud Function invocations/emulator, not through the apps

**Definition of done:** *(this phase carries most of the checklist — go through each individually rather than skimming)*
- [ ] Job acceptance is a single atomic transaction guarding against double-assignment
- [ ] ACCEPT JOB calls are idempotent via a client-generated `requestId`
- [ ] 45s offer timeout implemented via Cloud Tasks, not an in-function sleep
- [ ] Ola Maps Matrix API is only called against a pre-filtered shortlist, never the full on-duty fleet
- [ ] GCP budget alert + `usage_counters` circuit breaker in place
- [ ] Customer booking-fee cancellations are always non-refundable
- [ ] Driver commission refund on customer-initiated cancellation is unconditional (not subject to the ramp)
- [ ] Driver self-cancellation ramp reads `cancellation_policy` from Firestore, not hardcoded percentages
- [ ] `monthlyCancelCount` correctly resets on calendar-month rollover
- [ ] Once `strictMode` is `true`, every subsequent driver-initiated cancellation within that same calendar month forfeits 100% and issues a fresh 7-day ban
- [ ] `strictMode` resets to `false` on calendar-month rollover
- [ ] Dispatch's driver-selection step excludes any driver with `bannedUntil` in the future
- [ ] Dispatch's driver-selection step also excludes any driver whose `verificationStatus` isn't `approved`

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
