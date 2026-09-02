# Localized Towing Dispatch System — Technical Specification (v9)

> **Phase 4 decision lock (2026-08-28):** `docs/phase4_decisions.md` is the
> authoritative Phase 4 addendum. Its accepted state transitions,
> schema/rules/index contract, provider-failure classification, and production
> gate supersede older Phase 4 assumptions in this v9 narrative. Trusted Phase
> 1–3 behavior is unchanged.

## Context

I am building a tech stack for a localized towing dispatch system in Navi Mumbai, India. The system consists of a Flutter app for tow truck drivers and a Node.js Firebase backend that interacts directly with the Meta WhatsApp Cloud API and Razorpay.

## Goal

Create a structured project containing the Flutter Driver App and Firebase Cloud Functions. The architecture must explicitly minimize cost and stay within free-tier limits wherever a service genuinely offers one. Where a service does not offer a meaningful free tier for something that matters (Firebase Phone Auth SMS billing, Mapbox Matrix API element pricing), the spec routes around it rather than assuming it's free.

**Revenue model — commission only, not pass-through.** The platform only ever collects two things into its own account: a customer booking fee, and a driver commission (deducted from the driver's prepaid wallet on job acceptance). **The full towing fare is never collected by the platform** — it's paid by the customer directly to the driver on completion. The platform is never holding a third party's money mid-transaction, which keeps it out of RBI's Payment Aggregator/escrow-account regulatory scope.

**Cost guardrails carried through this document:** no service in this stack (Firebase Blaze, Mapbox, Razorpay) auto-stops billing at a free-tier line, so the system includes its own budget alerts and usage counters.

**Mapping is split across two vendors, deliberately.** Mapbox handles the in-app map display in Part 1. Backend routing/distance-matrix calls used for driver dispatch in Part 2 go through **Ola Maps**. Production cost control does not assume the historical 5M-call allowance: Phase 4 tracks HTTP requests and origin×destination pairs separately and reads a deployment-confirmed pair/cost cap for the actual Ola account/tier. This is backend-only REST usage, so there is no mobile-SDK integration risk to weigh against it.

**No standalone customer app.** Customers are served entirely through WhatsApp (invoice, all booking/payment interaction) plus a phone-in booking path handled by the two co-owners through the Admin Panel — see Part 3. A one-time emergency user is unlikely to install and reopen a dedicated app; this keeps the zero-install-friction advantage that made WhatsApp the right first channel in the first place. Revisit only if a repeat-customer/loyalty angle emerges later.

---

## Part 1: The Driver App (Flutter)

- **Design & UI:** High contrast (Yellow/Black safety theme), massive buttons, minimal reading, accessibility-first.
- **Localization:** Language switcher for English, Hindi, and Marathi (Flutter `intl` + `.arb` files).
- **Auth & Onboarding:**
  - Driver login via **WhatsApp OTP**, not Firebase Phone Authentication (Firebase Phone Auth bills $0.01/SMS in India with no meaningful free quota; WhatsApp OTP reuses infra already in place at no extra cost).
  - Profile creation: Name, Truck Type (dropdown with icons: Flatbed, Tochan, Hydraulic, Crane), Vehicle Number Plate (e.g., MH-46-XXXX).
  - **Manual identity/vehicle verification** *(new)*: immediately after profile creation, the driver must capture three photos, **in-app camera capture only — gallery/file picker disabled** for all three, so a driver can't upload a pre-existing or edited image:
    1. ID proof (Aadhaar / Driving License)
    2. Vehicle RC (Registration Certificate)
    3. A live selfie, taken at the same moment, for the reviewer to visually match against the ID
    Driver status is set to the canonical value `pending` on submission; the ON DUTY toggle is disabled and replaced with "Your documents are under review" until an admin approves them in the Admin Panel (Part 3). Rejection sends the driver a WhatsApp message with the stated reason and re-opens the upload step.
  - Consent screen shown before capture, stating what the documents are used for and that they're reviewed by a human — see the DPDP note under Part 2.
  - Dedicated background-location disclosure screen shown before the OS permission prompts (Play Store policy requirement).
- **Prepaid Wallet System:** Drivers top up their in-app wallet via Razorpay (UPI Intent preferred — deep-links straight into the driver's UPI app). This wallet is what commission is deducted from on acceptance, and credited back to on an eligible cancellation refund.
- **Home Screen (Dispatch Hub):**
  - Mapbox SDK map showing live location (stay within the free mobile map-load allowance).
  - Giant "ON DUTY / OFF DUTY" toggle.
  - **Status banner** *(new)*: if the driver is currently temp-banned, show "You're temporarily paused until [date] due to cancellations" — visible whenever `bannedUntil` is in the future, even though the driver isn't blocked from toggling ON DUTY (dispatch simply won't offer them jobs during this window).
  - Incoming Job Card pop-up: Pickup distance (km), Destination coordinates, **Estimated Fare** (labeled as collected directly by the driver, not processed by the platform), giant "ACCEPT JOB" button.
  - Tapping "ACCEPT JOB" sends a client-generated `requestId` UUID as an idempotency key.
  - An accepted job exposes an authenticated **"START TOW"** action. An in-progress job exposes **"MARK JOB COMPLETE"**. Both send a client-generated `requestId`. **"CANCEL JOB"** is available for normal driver self-cancellation only while the job is `accepted`; in-progress failures require admin/support handling until a separate policy is approved. The pre-start confirmation shows the current monthly count and snapshotted policy consequence so the driver is not surprised.
- **OS Constraints:** Android 14/15 `FOREGROUND_SERVICE_LOCATION` best practices; prompt to disable Battery Optimization for background sync via `live_location_tracker_plus` (verify current maintenance status before locking in).

---

## Part 2: The Backend (Firebase Cloud Functions, Firestore, Node.js)

### Billing & Cost Guardrails
- Functions on Blaze plan, coded to stay within the 2,000,000 free invocations/month.
- GCP budget threshold and recipients are deployment configuration. The historical `$5` example is not production policy.
- A shared transactional service updates `usage_counters/{month}` fields `olaMapsMatrixRequests`, `olaMapsMatrixPairs`, and `whatsappTemplateSends`. The historical 4.5M soft cap is not authoritative. Ola calls require a deployment-confirmed pair/cost cap; an absent cap selects explicit Haversine degraded mode rather than inventing a free allowance or creating `no_driver_found`.

### Firestore Collections
- `drivers` — now includes:
  - `monthlyCancelCount: { month: "2026-08", count: N }` — resets whenever the current calendar month doesn't match the stored month
  - `strictMode: boolean` (default `false`) — set `true` the moment a driver hits their 6th cancellation in a calendar month; **resets to `false` automatically at the start of each new calendar month**, using the same lazy-reset check already used for `monthlyCancelCount` (evaluated the next time the driver cancels something — no separate scheduled job needed)
  - `bannedUntil: timestamp | null`
  - `verificationStatus: 'pending' | 'approved' | 'rejected'` *(new)* — dispatch excludes any driver whose status isn't `approved`, same mechanism already used to exclude banned drivers
  - `verificationDocs: { idPhotoUrl, rcPhotoUrl, selfiePhotoUrl, submittedAt }` *(new)* — Storage URLs, not the images themselves
  - `rejectionReason: string | null` *(new)*
  - backend-owned towing capabilities `canFlatbed` / `canPulling`, engagement fields `activeJobId` / `activeOfferId`, and `locationUpdatedAt`; dispatch requires exact approved capability, `isOnDuty === true`, no active engagement conflict, sufficient wallet, and a valid location no older than the configured 120-second initial policy
- `jobs` — carries the Phase 3 booking/payment/invoice fields plus Phase 4 state-version, dispatch-generation/lease/due-time/current-offer, lifecycle timestamps, cancellation-resolution, and refund-request projections defined in `docs/phase4_decisions.md`. Phase 3 may hand off a legacy-shaped `pending_offer`; the durable consumer materializes missing Phase 4 workflow fields.
- `jobs/{jobId}/dispatch_runs/{generationId}` — backend-only finite policy snapshot, maximum-30 unique candidate list, cursor, outcomes, and audit evidence used to prove genuine exhaustion; `active` and `assigned` are nonterminal, while only `exhausted`, `cancelled_customer`, `completed`, and `superseded` finalize a run
- `job_offers/{offerId}` — top-level sanitized driver-facing offer/assignment projection; drivers never receive whole-job access merely because they were offered/assigned
- `wallet_entries/{operationId}` — permanent immutable wallet audit records committed with the balance mutation, with exact semantic IDs and signed integer-paise arithmetic
- `refund_requests/{jobId}` — deterministic, lease-recoverable no-driver refund initiation with immutable provider inputs/idempotency identity and monotonic signed-webhook convergence
- `notification_outbox/{eventId}` — durable important customer lifecycle delivery through the existing WhatsApp infrastructure
- `dispatch_config/main` — approved search/freshness/ranking policy and deployment-confirmed Ola pair cap
- `whatsapp_sessions/{phoneNumber}` — stores the customer's current WhatsApp towing-booking conversation state and accumulated booking inputs.
- `processed_requests/{requestId}` — Phase 4 client mutations additionally bind actor, operation, resource, payload hash, and stored result
- `pricing_config`
- `usage_counters/{month}`
- `admin_actions/{actionId}` *(new)* — audit log: every approval, rejection, cancellation-forgiveness, config edit, or phone-booking creation made from the Admin Panel writes a record here (`adminUid`, `action`, `target`, `reason`, `timestamp`). With two of you able to act on the same data, this is what answers "who changed this and why" later.
- `business_config` *(new)* — a single document holding invoicing details (`businessName`, `gstin`, `registeredAddress`, `invoiceNumberCounter`), tunable driver-OTP policy under `otpPolicy` (`otpExpirySeconds: 300`, `resendCooldownSeconds: 60`, `maxSendsPerWindow: 5`, `sendWindowSeconds: 900`, `blockDurationSeconds: 3600`, `maxVerificationAttempts: 5`), and the non-secret approved Meta authentication-template identity under `whatsappOtpTemplate` (`templateName`, `languageCode`). OTP send windows reset on expiry, an expired block begins a fresh window on the next permitted send, resends replace the prior challenge and clear prior `verifiedUid` without erasing abuse counters, and the attempt after the configured maximum is rejected before scrypt. OTP sends fail closed while the approved template identity is empty or invalid. Successful verification consumes the unchanged challenge before Firebase Auth lookup/creation and custom-token minting; if Auth or token creation then fails, that challenge remains consumed and recovery requires a new OTP without resetting abuse counters. The OTP pepper is a Secret Manager secret and is never stored in Firestore. See GST Invoicing below for invoice-number handling. ⚠️ This presumes GST registration — worth a short conversation with a CA before this ships, since GST registration usually isn't mandatory below a turnover threshold unless registered voluntarily; not tax advice, just flagging the dependency.

**Firebase Storage** *(new)*: verification photos go to `driver_verification/{driverId}/{id|rc|selfie}.jpg`, with security rules restricting write access to that driver's own authenticated UID and read access to that driver plus authenticated `admin: true` custom-claim users only — never public. Generated invoices go to `invoices/{jobId}.pdf`, readable only by admin-claim users (the WhatsApp copy sent to the customer is the delivery mechanism — there's no customer-facing account to log into and re-download from later). Storage usage at this driver-pool scale stays well within Firebase's free allowance, covered by the same budget-alert guardrail as everything else.

⚠️ **DPDP Act note:** government ID documents are sensitive personal data under India's Digital Personal Data Protection Act, which is already in force (Rules notified Nov 2025) even though penalty enforcement is phasing in through May 2027. Worth building the consent screen mentioned in Part 1 now rather than retrofitting it, along with a defined retention policy (e.g., delete verification photos automatically N months after a driver is approved, rather than storing them indefinitely) — not a legal opinion, just flagging that this is a live obligation, not a future one.

### `pricing_config`

**`booking_tiers`**
```
short_distance_limit_km: 10
long_distance_limit_km: 15
tier1_booking_fee: 100   tier1_driver_commission: 200   // distance ≤ 10km
tier2_booking_fee: 200   tier2_driver_commission: 300   // 10km < distance ≤ 15km
tier3_booking_fee: 300   tier3_driver_commission: 300 + (per_km_overage_rate × (distance − 15))  // distance > 15km
per_km_overage_rate: 50
```
⚠️ Tier 3 values are still an extrapolation, not confirmed.

**`fare_formula`** — informational estimate only, never platform-collected:
```
base_fare_standard: 1500
base_fare_flatbed: 2000
per_km_rate: 75
road_curvature_factor: 1.3
night_surge_multiplier: 1.25
night_surge_start_hour: 22
night_surge_end_hour: 6
highway_surge_multiplier: 1.2
highway_distance_threshold_km: 20
round_to_nearest: 10
```

**`cancellation_policy`** *(new — kept in Firestore alongside the other pricing config so the ramp itself is editable without a redeploy, same rationale as the fare formula)*:
```
version: 1
timezone: Asia/Kolkata
roundingMode: HALF_UP
free_cancellations_per_month: 1
forfeit_pct_by_count: { "2": 20, "3": 30, "4": 40, "5": 50 }   // count → % of that job's commission forfeited
ban_threshold_count: 6         // 6th+ cancellation in a month
ban_duration_days: 7
```

Acceptance snapshots the complete versioned cancellation policy on the
accepted `job_offers` record. Later config changes cannot alter that accepted
assignment's financial terms. `creditPaise` is always the original commission
minus HALF-UP-rounded `forfeiturePaise`.

### Fare Calculation Module

Unchanged — isolated pure function `functions/src/fareCalculator.js`, reads `fare_formula` / `booking_tiers` from Firestore with a ~5 min cache, ships with a local test script for iterating on the formula independently of the full app flow.

### WhatsApp Webhook Endpoint

Express webhook, `x-hub-signature-256` verified, idempotent via `processed_requests`.

- State 1: on first contact, ask for PICKUP location pin. State 2: DESTINATION pin. State 3: asks for Flatbed vs Pulling/Tochan/Crane-style towing (stores requestedTruckType as flatbed or pulling, which maps to pricing serviceType flatbed or standard). State 4: Haversine distance + `calculateFare()`. State 5: reply with booking fee (Razorpay Payment Link) and estimated fare (collected directly by driver).
- CANCEL is accepted while the booking is awaiting payment and, after payment, until the job is completed. Pre-payment and post-payment cancellation follow the separate rules below.

### Session Concurrency & Job Creation Invariants

For a WhatsApp message that causes job creation, the following sequence is mandatory:

1. Generate/preallocate the Firestore job document ID locally.
2. In the `whatsapp_sessions/{phone}` transaction, BEFORE any Razorpay/network side effect, persist:
   - `processingMessageId` = current Meta message ID (owner of the current session-processing claim)
   - `processingLeaseUntil` = lease expiry
   - `jobId` = the preallocated job ID
3. Commit that transaction.
4. Only AFTER the transaction commits call: `createJobAndQuote(jobId, customerPhone, pickupCoords, destCoords, requestedTruckType, channel)`
5. `createJobAndQuote` must always operate on exactly `jobs/{jobId}`.
6. On retry of the same Meta message:
   - reuse `session.jobId`
   - never generate a new logical job ID
   - reuse `jobs/{jobId}` if it already exists
   - reuse the stored Razorpay Payment Link if present
   - if local Razorpay link fields are missing, recover by `reference_id = jobId` before creating another Payment Link

**Crash Case Example:**
If `session.jobId` is persisted → job created → Razorpay link created → process crashes.
A retry MUST resume the same `jobId` from the session and must not create a duplicate logical booking.

**Session Lease Semantics:**
- No active claim → current message may claim
- Same `processingMessageId` → same-message retry may resume
- Different message + unexpired lease → do not process concurrently; return retryable handling
- Different message + expired lease → claim may be transactionally reclaimed
*(Note: the lease protects local transaction concurrency; it does not make external side effects exactly-once).*

### GST Invoicing *(new)*

Triggered automatically the moment a booking-fee payment succeeds (see Razorpay Webhook Endpoint below) — not a separate customer-facing feature to build, just a step in the existing payment flow.

- **Invoice covers the booking fee only, never the full tow fare.** The full fare is settled directly between customer and driver and never touches the platform's account, so invoicing it would misstate what the platform actually sold — and would undercut the exact separation that keeps this system outside RBI's Payment Aggregator scope (see the Revenue Model note above). This is the one rule this feature must not violate.
- Generated server-side as a PDF (a lightweight Node.js PDF library — no need for a full accounting/invoicing service), pulling `businessName` / `gstin` / `registeredAddress` from `business_config`, the booking fee amount, and the job's date/tier.
- **Sequential invoice numbering** via an atomic Firestore transaction incrementing `business_config.invoiceNumberCounter`. A retry reuses the logical job's assigned number and cannot increment twice; provider/crash failures can still create operational gaps, so universal gaplessness is not claimed.
- Saved to `invoices/{jobId}.pdf` in Storage, and sent to the customer as a WhatsApp document attachment in the same conversation, immediately after the booking-fee confirmation message. `invoiceSentAt` records Meta's acceptance of the outbound message, not confirmed recipient delivery; external delivery is at-least-once.

### Razorpay Webhook Endpoint

`x-razorpay-signature` verified. Handles booking-fee payment success (triggers Dispatch Logic **and** GST Invoicing above) and booking-fee refund success (only for the "no driver found" case).

### Dispatch Logic & Secure Transactions

- **Job creation is a single shared function**, `createJobAndQuote(jobId, customerPhone, pickupCoords, destCoords, requestedTruckType, channel)`, called by the WhatsApp webhook (`channel: 'whatsapp'`) and intended for reuse by the Admin Panel's phone-booking screen (`channel: 'phone'`, see Part 3). The current six-argument function initializes `createdByAdmin` to `null`; Phase 6 must define and test authenticated admin attribution without duplicating the shared validation, `fareCalculator`, tier lookup, or idempotency path.
- The Phase 3 `triggerDispatch(jobId)` boundary may run zero, one, or multiple times. It only accelerates a durable database-owned consumer/reconciler; no paid job may depend on callback exactly-once behavior.
- Matching requires `verificationStatus == 'approved'`, `isOnDuty === true`, no future `bannedUntil`, backend-owned request capability, null `activeJobId`/`activeOfferId`, sufficient wallet, and valid location no older than `dispatch_config.locationFreshnessSeconds` (initially 120). Missing/malformed fields fail closed with an operational reason.
- Two-stage selection uses Haversine rounds `[10,20,35]`, at most 10 Ola Matrix candidates per round, and at most 30 unique candidates per dispatch generation. A driver is never considered or offered twice in that generation.
- Ola candidates rank by routed ETA, routed distance, then driver UID. Timeout/429/5xx receives bounded retry followed by explicit Haversine degraded ranking; provider/infrastructure failure enters retry/operational hold and is never `no_driver_found`.
- The current mutable `dispatch_config.olaMonthlyPairCap` and usage counter are revalidated transactionally before every Matrix pair reservation/provider attempt. The immutable run snapshot never grants continuing authority from an older cap.
- The authoritative driver feed is top-level `job_offers`. Only one active offer exists per driver. Explicit DECLINE is penalty-free and immediately advances the persisted cursor.
- Job state machine: `awaiting_payment → pending_offer → offered → accepted → in_progress → completed`, plus the cancellation/redispatch states below. Internal retry/operational-hold state is carried by `dispatchState` while the customer-facing job remains `pending_offer`.
- Accepting a job is one Firestore transaction checking current job/offer/generation/expiry, authenticated target driver, cancellation fence, capability/eligibility, null active engagement, and wallet balance ≥ the fixed `driverCommissionPaise`; it writes the winner, wallet debit, permanent ledger entry, policy snapshot, and bound request receipt atomically.
- ACCEPT JOB, START TOW, MARK COMPLETE, DECLINE, and driver cancellation are authenticated callables idempotent via client `requestId` identities scoped to actor and operation.
- A Cloud Task is scheduled for exactly `offerExpiresAt = offeredAt + 45 seconds`, never an in-function sleep. Deterministic task identity plus current-offer/generation checks handles duplicate and stale delivery; the reconciler handles missed/delayed tasks.
- All critical transitions and external effects follow `transaction -> effect after commit -> durable marker -> lease-based reconciliation`.

### Cancellation & Refund Policy

- **Customer Cancels Before Payment:** Booking fee has NOT been collected. `cancellationRequestedAt` is persisted first, and cancellation of the unpaid Razorpay Payment Link (`POST /v1/payment_links/{job.razorpayPaymentLinkId}/cancel`) is attempted. Status becomes `cancelled_customer` ONLY after Razorpay confirms the unpaid Payment Link was cancelled, and the booking session is cleared/reset. If Razorpay indicates payment already succeeded, the system does NOT finalize it as an unpaid cancellation; it follows the documented paid-cancellation reconciliation path instead. No refund is required because no payment was made.
- **Customer Cancels After Booking-Fee Payment:** Booking fee is NON-REFUNDABLE. Payment remains recorded, GST invoice remains valid/generated, and no refund occurs. Status eventually becomes `cancelled_customer`. Phase 4 handles any driver/wallet consequences. (If payment succeeds while customer cancellation is being processed: payment is persisted, invoice generated, booking fee remains non-refundable, dispatch is skipped, and it routes into paid-customer-cancellation).
- **System/Platform Refund:** If the platform cannot provide a driver and the specification requires a refund, the booking fee may be refunded. Phase 4 initiates the Razorpay Refund API, and Phase 3 handles `refund.processed` reconciliation.

| Scenario | Booking fee (customer) | Driver commission |
|---|---|---|
| Customer cancels at any point after paying | **Non-refundable**, no exceptions | Fully refunded to driver's wallet if a driver had accepted — not the driver's fault |
| Platform genuinely exhausts the finite offer/redispatch generation with no driver available to complete the tow | **Refunded** via Razorpay Refunds API | No new debit; any earlier accepted-driver cancellation was already settled by its snapshotted wallet policy |
| Driver cancels after accepting, before towing begins — see ramp below | Non-refundable | Governed by the snapshotted escalating penalty; driver is released/excluded and the same job is redispatched |

**Driver self-cancellation ramp** (normal self-cancellation is supported only while the job is `accepted`; calendar month is evaluated in `Asia/Kolkata`):

| Cancellation # this month | Forfeited | Refunded to driver |
|---|---|---|
| 1st | 0% | 100% |
| 2nd | 20% | 80% |
| 3rd | 30% | 70% |
| 4th | 40% | 60% |
| 5th | 50% | 50% |
| 6th+ | 100% | 0% — **and `bannedUntil = now + 7 days`, `strictMode = true`** |

**Strict mode (post-ban rule):** once `strictMode` is `true` on a driver, the monthly ramp above is bypassed for the rest of that calendar month — **every** driver-initiated cancellation for the remainder of the month forfeits 100% of the commission and immediately sets a fresh `bannedUntil = now + 7 days`, regardless of what the monthly count would otherwise say. Each reban is a flat 7 days, every time — the ban length itself never grows with repeat offenses, only the fact that it keeps re-triggering does.

`strictMode` resets to `false` at the start of the next calendar month, at the same time `monthlyCancelCount` resets — so every driver gets a clean slate (1 free cancellation, then the normal ramp) each new month, even if they were in strict mode the month before. The 7-day ban duration itself is unaffected by this — if a ban is triggered near month-end and runs past the 1st, it still runs its full 7 days; only the driver's *next* cancellation after that is judged under the new month's fresh rules rather than carrying strict mode forward. In practice this rarely matters, since a driver can't be offered (or cancel) a job while `bannedUntil` is still in the future.

Implementation notes:
- Driver commission refunds/forfeitures are pure internal wallet ledger operations (Firestore transaction) — no Razorpay call, since that money never left the platform's ledger.
- Customer booking-fee refunds (the "no driver found" case only) require an actual Razorpay Refunds API call against the original payment ID stored on the job doc.
- Every driver-initiated cancellation increments `monthlyCancelCount` (even the 1st, penalty-free one) so the count is accurate for the next cancellation in the same month.
- The reset check is a single piece of logic run at the top of the cancellation handler: if the driver's stored `monthlyCancelCount.month` doesn't match the current calendar month, reset the count to 0 **and** `strictMode` to `false` in the same write, before evaluating the penalty for this cancellation.
- The accepted assignment uses the cancellation-policy version snapshotted at acceptance. HALF-UP rounding calculates `forfeiturePaise`; `creditPaise = commissionPaise - forfeiturePaise`. Permanent ledger IDs are exactly `commission_debit:{jobId}:{offerId}`, `customer_cancel_credit:{jobId}:{offerId}`, and `driver_cancel_credit:{jobId}:{offerId}`; using `offerId` (the immutable accepted-offer document ID) rather than `driverId` ensures that the same driver accepting in two separate dispatch generations for the same job produces distinct ledger IDs, while a retry of the same acceptance produces the same ID; even a 100% forfeiture writes a zero-delta entry with full policy/evaluation evidence.
- Accepted-driver cancellation is one transaction guarded by `cancellationRequestedAt == null`, `cancellationResolutionState == none`, `cancellationResolvedAt == null`, `cancelledAt == null`, `cancelledBy == null`, and `cancellationReason == null` — all provenance fields must be null, not merely different from specific values: clear the job's current assignment/offer/acceptance/debit/job-lease fields, increment its version, return it to `pending_offer`/`ready`; mark the offer `cancelled_driver`; clear driver engagement and apply only the snapshotted policy; move the same run `assigned -> active`, preserve/exclude all prior candidates, preserve authoritative `dispatch_runs.nextCandidateIndex` exactly unchanged, and keep `finalizedAt=null`; write the bound receipt and ledger entry. Worker ownership/lease fields exist only on the job, never on the dispatch run. Immutable booking/payment/invoice/fare, offer snapshot/metrics, run generation/policy/candidate history, identity/verification/capability fields, and prior ledger entries are preserved. The normal path does not emit terminal `cancelled_driver` on the customer job.
- CUSTOMER CANCELLATION MARKER WINS. If its marker/provenance commits first, driver cancel returns a stable non-penalizing result with no ledger, count, strict-mode/ban, forfeiture, redispatch, or provenance mutation, and the customer resolver completes the approved cancellation with full commission credit. If the driver transaction commits first, its snapshotted policy applies and the job returns to `pending_offer`; a later customer cancellation observes that state and follows the approved customer-cancellation path.
- Normal self-cancellation from `in_progress` is rejected. Exceptional in-progress failures require admin/support handling until a separate operational policy is accepted.
- Customer cancellation after acceptance or start remains terminal `cancelled_customer` and credits the driver's full original commission unconditionally.
- `no_driver_found` is legal only when the persisted finite candidate policy is genuinely exhausted. Provider/infrastructure failure is not exhaustion and may only enter retry/operational hold.
- A no-driver refund request is created atomically with `cancelled_system`, `cancelledBy=system`, and `cancellationReason=no_driver_found`. Its ID/operation ID is the job ID and it stores immutable payment ID, exact booking-fee paise, reason, provider-valid `refund_no_driver_found_{jobId}`, and canonical request hash before any provider call. The full key must match `^refund_no_driver_found_[A-Za-z0-9_-]+$`; a nonconforming job ID fails closed. The future operation is `POST payments/{razorpayPaymentId}/refund` with exact body `{ amount: bookingFeePaise }`, and every attempt sends request header `X-Refund-Idempotency` whose value is exactly the stored `providerIdempotencyKey`. The canonical identity is UTF-8 `JSON.stringify({ paymentId: razorpayPaymentId, amount: bookingFeePaise })` with that construction/key order and no optional fields; `providerRequestHash` is its lowercase SHA-256 hex. Header binding, payment, amount, key, canonical string, and hash are invariant across retries and independent of attempt/worker. Workers reconcile uncertain submissions before retry. After initiation success, `submitted` remains durably scheduled through `reconciliationNextAttemptAt`; a reclaimable owner/lease-fenced reconciler fetches the stored payment/refund identity. Matching `processed` confirms request/job transactionally; matching `pending` or unavailable/uncertain fetch stays submitted with bounded retry metadata and never resubmits; mismatches fail closed. This provider-fetch path and valid signed Phase 3 `refund.processed` race transactionally to the same absorbing `confirmed` state, with the losing matching path a no-op.
- A legacy Phase 1-3 `pending_offer` may lack every new workflow field. Discovery first queries `status == pending_offer` without ordering on new fields, then transactionally creates only safe operational defaults; malformed financial/assignment data fails closed and no destructive migration or value reinterpretation is allowed.
- Job doc fields: `cancelledBy` (`customer` | `driver` | `system`), `cancellationReason`, `refundedAmountPaise`, `forfeitedAmount`.

---

## Part 3: Admin Panel / Dashboard *(new)*

A protected web dashboard for the two co-owners, built on the same Firebase project (Firestore, Functions, Hosting) — this doesn't introduce a new cost category, just a second frontend against infrastructure you're already running.

- **Access:** deployed as a normal web app on Firebase Hosting (its own URL, e.g. `https://your-project.web.app`, or a custom domain later) — no native app, opens in any browser including a phone's.
- **Auth:** Firebase Auth with email/password or Google sign-in for just the two of you (not the WhatsApp OTP drivers use), gated by a custom `admin: true` claim. Custom claims **cannot** be set from the Firebase Console UI — there's no button for it — they require the Admin SDK. Bootstrap sequence: both co-owners create an account on the login screen, then one of you runs a one-time local script (or a temporary Cloud Function, deleted right after) using the project's service account credentials to call `admin.auth().setCustomUserClaims(uid, { admin: true })` for both accounts. From then on every sign-in carries the claim, and every admin-panel Cloud Function and Firestore/Storage rule checks it server-side before allowing a write — so the panel's URL itself doesn't need to stay secret; without the claim, nothing writable is reachable through it.
- **Screen 1 — Driver Verification Queue:** lists drivers with `verificationStatus == 'pending'`, showing the ID photo, RC photo, and selfie side by side against the profile info the driver entered (name, plate number, truck type) for cross-checking. Approve or Reject; rejecting requires a reason, which triggers the WhatsApp rejection notice back to the driver and reopens their upload step.
- **Screen 2 — Live Jobs View:** real-time list of jobs by status (`awaiting_payment` / `pending_offer` / `offered` / `accepted` / `in_progress` / `completed` / cancellation states), assigned driver, and timestamps — a live Firestore listener rather than polling, so it doesn't add meaningfully to function invocation count.
- **Screen 3 — Driver Management:** wallet balance, `verificationStatus`, `bannedUntil`, `strictMode`, and current `monthlyCancelCount` per driver, plus a **"Forgive this cancellation"** action. This calls the same audited wallet-credit Cloud Function the backend already uses for legitimate refunds — never a raw Firestore edit — and requires a reason, logged to `admin_actions`.
- **Screen 4 — Config Editor:** structured forms (typed fields, not a raw JSON textarea) for `booking_tiers`, `fare_formula`, and `cancellation_policy`, validated before writing — this is what actually delivers on "the formula should be easily editable" without risking a malformed write (e.g., a string landing where `per_km_rate` expects a number) taking down every fare calculation until someone notices. Writes go through a Cloud Function, not a direct client write, so there's one validation and audit point.
- **Screen 5 — Phone Booking** *(new)*: for the two of you to take bookings by phone. A simple form — customer phone number, pickup/destination (address search via Ola Maps geocoding, not manual lat/lng entry), towing category (flatbed/pulling) — that reuses the same six-argument `createJobAndQuote()` validation and pricing path with `channel: 'phone'` (see Dispatch Logic). Phase 6 must add authenticated `createdByAdmin` attribution and the matching `admin_actions` record around that shared path; the current Phase 3 function does not accept an admin UID. The customer still gets the booking-fee payment link and everything downstream (dispatch, invoice) via WhatsApp exactly as normal — the phone call only replaces how the pickup/destination/towing category details get captured, not what happens after. If a caller genuinely has no WhatsApp, the fallback is manual — read the amount and a plain payment-link URL aloud or via SMS — rather than building a second automated delivery channel for an edge case.

---

## Verification Checklist

- [ ] WhatsApp and Razorpay webhook signatures verified on every request
- [ ] Webhook idempotency: duplicate message IDs / retried requests never cause duplicate side effects
- [ ] Job acceptance is a single atomic transaction guarding against double-assignment
- [ ] ACCEPT JOB calls are idempotent via a client-generated `requestId`
- [ ] One backend-owned active job and one active offer per driver are enforced transactionally
- [ ] 45s offer timeout implemented via Cloud Tasks, not an in-function sleep
- [ ] `fareCalculator.js` is a standalone, unit-testable module reading tunable constants from Firestore
- [ ] Ola Maps Matrix API is only called against a pre-filtered shortlist, never the full on-duty fleet
- [ ] Matching uses approved backend-owned towing capabilities, fresh location, on-duty state, finite deduplicated search rounds, and deterministic ETA/distance/UID ranking
- [ ] Ola request and Matrix-pair usage are counted transactionally; provider failure degrades/retries or holds and never becomes `no_driver_found`
- [ ] GCP budget alert + deployment-configured `usage_counters` circuit breaker in place
- [ ] Driver OTP delivered through an approved WhatsApp authentication template, not free-form text or Firebase Phone Auth SMS
- [ ] Onboarding includes a background-location disclosure screen ahead of OS permission prompts
- [ ] The platform's Razorpay integration only ever collects the booking fee and driver commission — the full towing fare never flows through the platform
- [ ] Customer booking-fee cancellations are always non-refundable
- [ ] Driver commission refund on customer-initiated cancellation is unconditional (not subject to the ramp)
- [ ] Driver self-cancellation ramp reads `cancellation_policy` from Firestore, not hardcoded percentages
- [ ] Cancellation policy is versioned/snapshotted at acceptance and uses Asia/Kolkata plus HALF-UP integer-paise arithmetic
- [ ] Accepted-driver cancellation releases/excludes that driver and redispatches the same nonterminal customer job; normal in-progress self-cancellation is rejected
- [ ] `monthlyCancelCount` correctly resets on calendar-month rollover
- [ ] Once `strictMode` is `true`, every subsequent driver-initiated cancellation *within that same calendar month* forfeits 100% and issues a fresh 7-day ban (flat 7 days every time, not growing), bypassing the ramp
- [ ] `strictMode` resets to `false` on calendar-month rollover, using the same lazy-reset check as `monthlyCancelCount` — no separate scheduled job
- [ ] Dispatch's driver-selection step excludes any driver with `bannedUntil` in the future
- [ ] Driver app shows a ban-status banner and previews the current cancellation penalty before confirming a cancel
- [ ] ID/RC/selfie capture uses in-app camera only — gallery/file picker disabled for all three
- [ ] Dispatch's driver-selection step also excludes any driver whose `verificationStatus` isn't `approved`
- [ ] Drivers consume sanitized top-level `job_offers` and cannot read complete jobs because of an offer/assignment
- [ ] Paid-job live traffic remains disabled until the durable pending-offer reconciler passes real Firestore Emulator race/recovery tests
- [ ] Verification photos are stored with Storage rules restricted to the uploading driver + admin-claim users only — never publicly readable
- [ ] A consent screen is shown before document capture, and a retention/deletion policy exists for verification photos (DPDP Act)
- [ ] Admin Panel auth checks the `admin: true` custom claim on every write, not just at login
- [ ] "Forgive this cancellation" in the Admin Panel calls the existing audited wallet-credit function — no direct Firestore balance edits
- [ ] Every admin approval, rejection, forgiveness, and config change is written to `admin_actions` with who/what/why/when
- [ ] Config Editor writes go through a Cloud Function with type validation, not a raw client write to `pricing_config`
- [ ] GST invoice PDFs are generated only for the booking fee amount — never for the full tow fare
- [ ] Each logical paid job receives one immutable invoice number via an atomic Firestore transaction on `business_config.invoiceNumberCounter`; retries cannot increment twice, without claiming universal gaplessness across crashes/provider failures
- [ ] WhatsApp-originated and phone-originated bookings both call the same `createJobAndQuote()` function — no separate, less-validated path for phone bookings
- [ ] Phone bookings created via the Admin Panel are logged to `admin_actions` and tagged `channel: 'phone'` / `createdByAdmin` on the job doc
