# Data Model Reference — Towing Dispatch System

> Generated during Phase 1. Authoritative field names for all Firestore collections and Storage paths.
> Source of truth: `towing_dispatch_spec_v9.md`. This document is a human-readable summary intended to
> prevent field-name typos across phases — it is not a substitute for reading the spec.
>
> **Phase 4 Stage 1 status:** the owner-approved schema, rules, and index
> contracts below are now represented by the `firebase/seed/*_schema.json`
> references, `firebase/firestore.rules`, and `firebase/firestore.indexes.json`.
> No Phase 4 worker, provider, task, mutation, wallet, refund, or notification
> runtime is implemented. `docs/phase4_decisions.md` remains authoritative.

---

## Firestore Collections

### `drivers/{driverId}`

Document ID = Firebase Auth UID.

| Field | Type | Default | Writer | Notes |
|---|---|---|---|---|
| `uid` | `string` | — | driver | Same as doc ID |
| `name` | `string` | — | driver | Full name |
| `phone` | `string` | — | driver | E.164 format (+91…) |
| `truckType` | `string` enum | — | driver while unapproved; backend after approval | Descriptive/verified `flatbed \| tochan \| hydraulic \| crane`; not the matching capability source |
| `vehicleNumber` | `string` | — | driver while unapproved; backend after approval | e.g. `MH-46-XXXX`; approved-profile changes reset verification/capabilities through a callable |
| `isOnDuty` | `boolean` | `false` | driver | Home screen toggle |
| `location` | `GeoPoint \| null` | `null` | driver | Updated by background location service (Phase 5) |
| `locationUpdatedAt` | `Timestamp \| null` | `null` | driver, paired with a valid location report | Must change to server request time; the reported GeoPoint may equal the stored value; initial freshness policy is 120 seconds |
| `walletBalance` | `number` | `0` | **Cloud Function only** | Store as integer paise (INR × 100) to avoid float precision issues |
| `canFlatbed` | `boolean` | `false` | **Cloud Function only** | Server-approved capability required for `requestedTruckType=flatbed` |
| `canPulling` | `boolean` | `false` | **Cloud Function only** | Server-approved capability required for `requestedTruckType=pulling` |
| `activeJobId` | `string \| null` | `null` | **Cloud Function only** | At most one job across `accepted` and `in_progress` |
| `activeOfferId` | `string \| null` | `null` | **Cloud Function only** | At most one current offer |
| `verificationStatus` | `string` enum | `pending` | **Cloud Function only** | `pending \| approved \| rejected` |
| `verificationDocs` | `map \| null` | `null` | **Cloud Function only** | See sub-fields below |
| `verificationDocs.idPhotoUrl` | `string` | — | **Cloud Function only** | Storage URL for ID photo |
| `verificationDocs.rcPhotoUrl` | `string` | — | **Cloud Function only** | Storage URL for RC photo |
| `verificationDocs.selfiePhotoUrl` | `string` | — | **Cloud Function only** | Storage URL for selfie |
| `verificationDocs.submittedAt` | `Timestamp` | — | **Cloud Function only** | Used by DPDP retention job |
| `rejectionReason` | `string \| null` | `null` | **Cloud Function only** | Sent to driver via WhatsApp on rejection |
| `bannedUntil` | `Timestamp \| null` | `null` | **Cloud Function only** | Dispatch excludes if in the future |
| `strictMode` | `boolean` | `false` | **Cloud Function only** | Bypasses cancellation ramp; resets monthly |
| `monthlyCancelCount` | `map` | `{month: '', count: 0}` | **Cloud Function only** | Lazy reset on calendar-month change |
| `monthlyCancelCount.month` | `string` | `''` | **Cloud Function only** | Format: `YYYY-MM` |
| `monthlyCancelCount.count` | `number` | `0` | **Cloud Function only** | Includes the 1st (penalty-free) cancellation |
| `createdAt` | `Timestamp` | — | driver / Cloud Function | Set once on profile creation |
| `updatedAt` | `Timestamp` | — | driver / Cloud Function | Driver self-service updates require server timestamp equal to request time; backend writes use authoritative server time |

**Security rule invariant:** a driver client can never write `walletBalance`,
capabilities, engagement fields, verification, ban, strict-mode,
monthly-cancellation, verification-document, or rejection fields. Direct admin
writes to sensitive driver fields are removed; audited backend callables own
them. Every driver update includes `updatedAt == request.time`. A valid location
report may repeat the same GeoPoint or change it, but must refresh
`locationUpdatedAt == request.time`; missing/arbitrary/deleted timestamps and
malformed/null location reports are denied.

---

### `jobs/{jobId}`

Document ID = Firestore auto-ID. Created by `createJobAndQuote()` (Phase 3), written only by Cloud Functions thereafter.

| Field | Type | Default | Notes |
|---|---|---|---|
| `customerPhone` | `string` | — | E.164 |
| `pickupCoords` | `map {lat, lng}` | — | From WhatsApp location pin |
| `destCoords` | `map {lat, lng}` | — | From WhatsApp location pin |
| `requestedTruckType` | `string` | — | Customer's requested towing category (flatbed \| pulling) |
| `distanceKm` | `number` | — | Haversine straight-line distance |
| `pricingTier` | `number` enum | — | `1 \| 2 \| 3`, returned by the trusted Phase 2 commission calculation and fixed at creation |
| `bookingFeePaise` | `number` | — | Platform fee (paise). **Never the full fare.** |
| `driverCommissionPaise` | `number` | — | Deducted from driver wallet on accept (paise) |
| `estimatedFarePaise` | `number` | — | Informational only. Customer pays driver directly. |
| `status` | `string` enum | `awaiting_payment` | `awaiting_payment \| pending_offer \| offered \| accepted \| in_progress \| completed \| cancelled_customer \| cancelled_driver \| cancelled_system` |
| `offeredTo` | `string \| null` | `null` | UID of driver currently being offered the job |
| `assignedDriver` | `string \| null` | `null` | UID of driver who accepted |
| `channel` | `string` enum | — | `whatsapp \| phone` |
| `createdByAdmin` | `string \| null` | `null` | Reserved for Phase 6 phone-booking attribution. Phase 3's six-argument `createJobAndQuote` initializes it to `null`; it does not receive an admin UID. |
| `razorpayPaymentLinkId` | `string \| null` | `null` | — |
| `razorpayPaymentLinkUrl` | `string \| null` | `null` | Razorpay short_url returned on link creation |
| `paymentLinkProvisioningOwner` | `string \| null` | `null` | Owner token for recoverable Payment Link provisioning |
| `paymentLinkProvisioningLeaseUntil` | `Timestamp \| null` | `null` | Expiry for the provisioning owner; stale work may be reclaimed |
| `razorpayPaymentId` | `string \| null` | `null` | Stored for refund operations |
| `paymentConfirmedAt` | `Timestamp \| null` | `null` | Timestamp when payment was verified and persisted |
| `invoiceNumber` | `string \| null` | `null` | Sequential GST invoice number |
| `invoiceUrl` | `string \| null` | `null` | Storage URL for invoice PDF |
| `invoiceStoragePath` | `string \| null` | `null` | Exact private object path `invoices/{jobId}.pdf` |
| `invoiceIssueDateIst` | `string \| null` | `null` | Immutable `YYYY-MM-DD` invoice issue date in IST |
| `invoiceIssuedAt` | `Timestamp \| null` | `null` | Instant paired with the immutable issue date |
| `invoiceSentAt` | `Timestamp \| null` | `null` | Written after Meta accepts the outbound invoice message; it does not prove recipient delivery |
| `invoiceWhatsAppMediaId` | `string \| null` | `null` | Meta media ID accepted for the private PDF upload |
| `invoiceWhatsAppMessageId` | `string \| null` | `null` | Meta message ID returned when invoice delivery is accepted |
| `invoiceSendOwner` | `string \| null` | `null` | Owner token for the recoverable invoice send lease |
| `invoiceSendLeaseUntil` | `Timestamp \| null` | `null` | Expiry of the invoice send lease |
| `offerExpiresAt` | `Timestamp \| null` | `null` | Current parent-job offer deadline, exactly 45 seconds after `offeredAt`; reconciliation is authoritative |
| `requestId` | `string \| null` | `null` | Legacy accept audit projection; Phase 4 uses scoped `processed_requests` receipts |
| `stateVersion` | `number` | `0` | Monotonic Phase 4 transition fence |
| `dispatchGeneration` | `number` | `0` | Current durable finite search generation |
| `dispatchState` | `string enum \| null` | `null` | `not_started \| ready \| claimed \| selecting \| retry_wait \| operational_hold \| offered \| assigned \| closed`; missing on legacy `pending_offer` is normalized to `ready` |
| `dispatchRunId` | `string \| null` | `null` | Current dispatch-run document ID |
| `dispatchLeaseOwner` | `string \| null` | `null` | Reclaimable worker owner token |
| `dispatchLeaseUntil` | `Timestamp \| null` | `null` | Reclaimable worker lease deadline |
| `dispatchNextActionAt` | `Timestamp \| null` | `null` | Indexed retry/reconciliation due time |
| `dispatchLastFailure` | `map \| null` | `null` | Safe operational reason `{code, source, retryable, occurredAt}` |
| `currentOfferId` | `string \| null` | `null` | Current sanitized offer/assignment projection |
| `offeredAt` | `Timestamp \| null` | `null` | Current offer creation time |
| `acceptedAt` | `Timestamp \| null` | `null` | Current driver acceptance time |
| `inProgressAt` | `Timestamp \| null` | `null` | Assigned-driver tow start time |
| `completedAt` | `Timestamp \| null` | `null` | Completion time |
| `commissionDebitEntryId` | `string \| null` | `null` | Current assignment's immutable debit ledger ID |
| `cancellationResolutionState` | `string enum` | `none` | `none \| pending \| resolved` |
| `cancellationResolvedAt` | `Timestamp \| null` | `null` | Completion of active-state customer-cancellation consequences |
| `cancelledAt` | `Timestamp \| null` | `null` | Terminal cancellation time |
| `refundRequestId` | `string \| null` | `null` | Deterministic no-driver refund operation ID |
| `refundState` | `string enum` | `none` | `none \| pending \| in_progress \| submitted \| confirmed \| retry_wait \| failed_terminal` |
| `refundNextAttemptAt` | `Timestamp \| null` | `null` | Indexed refund-recovery due time |
| `cancelledBy` | `string \| null` | `null` | `customer \| driver \| system` |
| `cancellationRequestedAt` | `Timestamp \| null` | `null` | — |
| `cancellationReason` | `string \| null` | `null` | — |
| `razorpayRefundId` | `string \| null` | `null` | — |
| `refundConfirmedAt` | `Timestamp \| null` | `null` | — |
| `refundedAmountPaise` | `number \| null` | `null` | Customer booking-fee refund confirmed by Razorpay, in integer paise; not a driver-wallet credit |
| `forfeitedAmount` | `number \| null` | `null` | Non-authoritative display projection of the forfeiturePaise for the most recent accepted-driver cancellation occurrence; overwritten on each accepted-driver cancellation. Not cumulative, not used for wallet balance reconstruction, idempotency, or future penalty calculation. `wallet_entries` is sole permanent financial authority. |
| `createdAt` | `Timestamp` | — | — |
| `updatedAt` | `Timestamp` | — | — |

Phase 4 drivers do not read this document. Their authoritative driver-facing
projection is `job_offers/{offerId}`. `cancelled_driver` remains in the legacy
job enum but is not emitted by the approved normal pre-tow driver-cancellation
path; that path returns the customer job to `pending_offer` and continues the
same dispatch generation.

Accepted-driver cancellation is one future transaction with this exact reset.
Its guard additionally requires `cancellationRequestedAt == null`,
`cancellationResolutionState == none`, `cancellationResolvedAt == null`,
`cancelledAt == null`, `cancelledBy == null`, and `cancellationReason == null`.
All cancellation provenance fields must be null — not merely different from
customer-specific values. Any unexpected stale provenance fails closed.
CUSTOMER CANCELLATION MARKER WINS: once that marker exists/resolves, driver
cancel is a stable non-penalizing no-op and the customer resolver remains
authoritative.

| Resource | Required mutation | Required preservation |
|---|---|---|
| job | `status=accepted -> pending_offer`; `dispatchState=ready`; clear `assignedDriver`, `offeredTo`, `currentOfferId`, `offeredAt`, `offerExpiresAt`, `acceptedAt`, `commissionDebitEntryId`, dispatch lease/failure; overwrite `forfeitedAmount` with `forfeiturePaise` for that most recent cancellation occurrence (non-authoritative display projection; not cumulative; `wallet_entries` is sole financial authority); set `dispatchNextActionAt` and `updatedAt` to server time; increment `stateVersion` once | Same `dispatchGeneration` and `dispatchRunId`; immutable booking/payment/invoice/fare values; `inProgressAt`, `completedAt`, and terminal cancellation fields remain null |
| accepted offer | `status=cancelled_driver`; set `resolvedAt`, `resolutionReason=driver_cancelled`, `updatedAt` | Immutable identity, pricing, routed metrics, coordinates, and policy snapshot |
| driver | clear `activeJobId` and `activeOfferId`; update only snapshotted-policy cancellation/wallet fields and `updatedAt` | Identity, verification, capabilities, and descriptive vehicle fields |
| dispatch run | `status=assigned -> active`; current candidate outcome becomes `driver_cancelled` and remains excluded; preserve authoritative `nextCandidateIndex` exactly; set `updatedAt`; keep `finalizedAt=null` | Generation, immutable policy snapshot, ordered candidates, and all prior attempted/excluded outcomes; no dispatch-run owner/lease fields exist |
| receipt/ledger | atomically persist the bound successful request result and deterministic `driver_cancel_credit` entry | Existing ledger records remain immutable |

Existing Phase 1-3 jobs may omit every new Phase 4 field. The Phase 4 backend
must fail closed on malformed financial/assignment state and preserve old
financial values exactly. Stage 2 first runs a legacy bootstrap query on
`status == pending_offer` without ordering by any new field (ordered queries
omit documents missing that field), then transactionally materializes only
safe operational defaults. No destructive migration is required.

---

### `dispatch_config/main` *(Stage 1 schema/config contract)*

Backend-written, admin-readable configuration:

| Field | Type / initial value |
|---|---|
| `version` | positive integer / `1` |
| `locationFreshnessSeconds` | positive integer / `120` |
| `radiusKmSequence` | number array / `[10,20,35]` |
| `maxUniqueCandidatesPerGeneration` | positive integer / `30` |
| `maxMatrixShortlistPerRound` | positive integer / `10` |
| `rankingPrimary` | `ola_eta_seconds` |
| `rankingSecondary` | `ola_distance_meters` |
| `rankingTieBreak` | `driver_uid` |
| `olaFailureMode` | `bounded_retry_then_haversine_degraded` |
| `olaMonthlyPairCap` | positive integer or `null`; initially unconfigured |
| `updatedAt` | Timestamp |

The cap is mutable current provider authorization. It is revalidated with
current counters before every future Matrix pair reservation/provider attempt
and is never copied into an immutable dispatch run as authority.

---

### `jobs/{jobId}/dispatch_runs/{generationId}` *(Stage 1 schema contract)*

Backend-only finite search-policy snapshot and candidate/cursor audit. Status is
`active | assigned | exhausted | cancelled_customer | completed | superseded`.
`active` and `assigned` are nonterminal and keep `finalizedAt == null`;
acceptance moves `active -> assigned`, and accepted-driver cancellation moves
`assigned -> active` without changing generation or authoritative
`nextCandidateIndex`, and without removing attempted/excluded history. Worker
ownership is exclusively on the job as `dispatchLeaseOwner` and
`dispatchLeaseUntil`; dispatch-run documents have no owner/lease fields. The immutable snapshot excludes
`olaMonthlyPairCap`.

---

### `job_offers/{offerId}` *(Stage 1 schema contract)*

Top-level backend-written sanitized projection. Target driver/admin read only.
It carries job/driver/generation/candidate identity, offer lifecycle status,
offer/expiry/lifecycle timestamps and resolution reason, timeout task markers, client acceptance
request ID, the acceptance-time cancellation-policy snapshot, pickup and
destination coordinates, requested capability, routed pickup distance/ETA,
estimated fare, and driver commission. It never contains customer phone,
Razorpay/invoice fields, leases, provider errors, or refund internals.
`acceptRequestId` is the sole request-ID exception and contains only the target
driver's opaque winning acceptance ID. Exact historical sanitized coordinates
remain readable to that target driver until a future approved retention policy
deletes the offer.

Offer status enum:

`offered | accepted | in_progress | completed | declined | expired |
cancelled_customer | cancelled_driver | superseded`

Legal transitions are exactly:

`offered->accepted`, `accepted->in_progress`, `in_progress->completed`,
`offered->declined`, `offered->expired`, `offered->cancelled_customer`,
`offered->superseded`, `accepted->cancelled_customer`,
`accepted->cancelled_driver`, and `in_progress->cancelled_customer`.
In particular, `accepted->superseded` and `in_progress->superseded` are not
legal Stage 1 transitions.

Naming is intentionally entity-specific: the parent job's current-state guard
is `offerExpiresAt`, while each offer record uses `expiresAt`; the parent job's
accepted UID is `assignedDriver`, while each sanitized offer target is
`driverId`; the persisted candidate sequence is `candidateIndex`. Capability
names remain exactly `canFlatbed` and `canPulling` everywhere.

---

### `wallet_entries/{operationId}` *(Stage 1 schema contract)*

Permanent immutable backend-written financial audit. Balance mutation and
entry creation are one transaction. Types initially are
`commission_debit | customer_cancel_credit | driver_cancel_credit`. Deterministic
document IDs are exactly `commission_debit:{jobId}:{offerId}`,
`customer_cancel_credit:{jobId}:{offerId}`, and
`driver_cancel_credit:{jobId}:{offerId}`. The `offerId` is the immutable
accepted-offer document ID (the occurrence identity of the accepted assignment),
ensuring cross-generation collision-safety when the same driver accepts in
multiple dispatch generations. `deltaPaise` is signed and all money
values are safe integers. Commission debit requires
`deltaPaise=-commissionPaise`; customer cancellation requires full
`creditPaise=commissionPaise`, `forfeiturePaise=0`, and
`deltaPaise=creditPaise`; driver cancellation requires HALF-UP
`forfeiturePaise`, `creditPaise=commissionPaise-forfeiturePaise`, and
`deltaPaise=creditPaise`. Every entry proves
`balanceAfterPaise=balanceBeforePaise+deltaPaise`; even a 100% forfeiture emits
a zero-delta permanent record. A driver-cancel entry embeds the complete
acceptance-time policy and evaluation evidence, including month/count,
strict-mode inputs/outcome, applied percentage, and capture time, so deletion
of operational offers/config cannot erase the financial basis.
Driver reads remain denied until separately approved; driver writes are always
denied.

---

### `refund_requests/{jobId}` *(Stage 1 schema contract)*

One deterministic backend-only no-driver refund operation per job, containing
the exact stored payment/booking-fee identity, owner lease, retry state,
provider idempotency key/refund ID, attempt/error metadata, and timestamps. It
is created only with a job transition to `cancelled_system` where
`cancelledBy=system` and `cancellationReason=no_driver_found`, after objective
run exhaustion. The document ID and `operationId` are the `jobId`; immutable
provider inputs are `razorpayPaymentId`, exact `amountPaise`, `reason`,
`providerIdempotencyKey=refund_no_driver_found_{jobId}`, and a canonical
`providerRequestHash`. The full key must match
`^refund_no_driver_found_[A-Za-z0-9_-]+$`; a nonconforming job ID fails closed.
The future operation is `POST payments/{razorpayPaymentId}/refund` with exact
body `{ amount: bookingFeePaise }`, where `bookingFeePaise` is the immutable
value stored as request `amountPaise`. Its canonical semantic request is the UTF-8
string produced by constructing `{ paymentId: razorpayPaymentId, amount:
bookingFeePaise }` in that key order and calling `JSON.stringify`; the stored hash
is its lowercase SHA-256 hex. Every provider initiation attempt sends header
`X-Refund-Idempotency` with the exact stored `providerIdempotencyKey`. No
optional provider fields participate, and the header binding, payment, amount,
provider key, canonical request, and hash never vary by retry.

Worker states are `pending -> in_progress -> submitted` or `retry_wait`, with
bounded terminal `failed_terminal`; retry resumes at `in_progress`. A valid
Phase 3 signed `refund.processed` reconciliation may move any non-confirmed
state to `confirmed`. `confirmed` is absorbing: the Razorpay refund ID, amount,
confirmation timestamp, parent job projection, and receipt marker converge in
one transaction, while any stale owner/lease/retry metadata is cleared. The
worker must reconcile provider state by the immutable idempotency identity
before retrying an uncertain submission.

`submitted` requests are independently recoverable when the signed webhook is
missed. Provider initiation success stores `razorpayRefundId` and
`reconciliationNextAttemptAt`; a due reconciler claims the still-submitted
request with the same reclaimable owner/lease fence and fetches
`GET payments/{razorpayPaymentId}/refunds/{razorpayRefundId}`. A matching
`processed` result confirms request and job transactionally with
`confirmationSource=reconciliation`. A matching provider `failed` result (when
payment, refund ID, and amount match stored identities) moves request and job
projection transactionally to `failed_terminal`, persists a bounded safe failure
classification in `lastErrorCode`, clears owner/lease, and clears/disables
reconciliation retry schedules (`reconciliationNextAttemptAt=null`, `nextAttemptAt=null`),
while preserving `jobId`, `razorpayPaymentId`, `razorpayRefundId`, `amountPaise`,
`providerIdempotencyKey`, and `providerRequestHash`. `failed_terminal` does not
become confirmed from the fetch that reported failed, does not automatically submit
a second refund, does not reset to pending/submitted through ordinary retry, and
requires an explicit future administrative/manual recovery operation if recovery is
needed. However, a later valid matching signed `refund.processed` webhook for the
same exact provider refund identity still converges `failed_terminal` to `confirmed`
with `confirmationSource=webhook`. A matching `pending` result or unavailable
or uncertain lookup leaves `state=submitted`, increments
`reconciliationAttempts`, records a bounded next-attempt time and safe error
code as applicable, clears the claim, and never resubmits. Any identity/amount
mismatch fails closed. Webhook and fetch races re-read transactionally, converge
to the same absorbing `confirmed` state, and the losing path becomes a validated
no-op. Confirmation clears both retry schedules.

---

### `notification_outbox/{eventId}` *(Stage 1 schema contract)*

Backend-only durable important customer-lifecycle message. Event types are
exactly `job_accepted|job_in_progress|job_completed|job_cancelled_customer|job_cancelled_system|refund_confirmed`;
resource types are exactly `job|refund_request`; channel is fixed to `whatsapp`.
eventId format is occurrence-safe per event type:
- `job_accepted:{jobId}:{offerId}` — includes offerId because an accepted-driver pre-tow cancellation followed by re-dispatch may produce a second legitimate `job_accepted` notification for the same job
- all other events: `{eventType}:{jobId}` (each occurs at most once per job/refund)
`recipientKey` is the opaque non-PII reference `customer:{jobId}`, resolved server-side to the customer's validated WhatsApp contact at send time and never a raw phone number. `lastErrorCode` must be from the exact bounded enum: `provider_unavailable`, `provider_rate_limited`, `provider_rejected_message`, `provider_unknown_error`, `recipient_unreachable`, `configuration_missing`, `internal_error`. Payload version 1 has exactly
`{ jobId, jobStatus, refundAmountPaise }`. Job events bind the matching job
status and null refund amount. `refund_confirmed` binds resource type
`refund_request`, status `cancelled_system`, and the positive safe-integer
confirmed amount. Payloads exclude phone, coordinates, driver/payment identity,
provider responses, credentials, and secrets. Delivery is at-least-once;
provider acceptance is not recipient-delivery proof. Firestore `job_offers`,
not FCM or WhatsApp, remains the authoritative driver offer feed.

---

### `whatsapp_sessions/{phoneNumber}`

Document ID = customer phone in E.164 format. Managed exclusively by Cloud Functions (Admin SDK). No client access.

| Field | Type | Notes |
|---|---|---|
| `phoneNumber` | `string` | E.164 |
| `state` | `number` | Conversation state: 1=pickup, 2=destination, 3=requestedTruckType, 4=fareQuote, 5=paymentSent |
| `pickupCoords` | `map {lat, lng} \| null` | — |
| `destCoords` | `map {lat, lng} \| null` | — |
| `requestedTruckType` | `string \| null` | `flatbed \| pulling` |
| `jobId` | `string \| null` | Set once job is created |
| `processingMessageId` | `string \| null` | Identifies which Meta message currently owns the conversation-processing claim |
| `processingOwnerToken` | `string \| null` | Fences completion so a stale invocation cannot mutate a reclaimed session |
| `processingLeaseUntil` | `Timestamp \| null` | Allows another invocation to reclaim an abandoned claim after expiry |
| `lastProcessedMessageId` | `string \| null` | For WhatsApp webhook idempotency / outbound retries |
| `pendingReply` | `map \| null` | Serialized recoverable work. `kind` is `text`, `job_quote`, or `cancel_unpaid`; every record carries its originating `messageId`. |
| `updatedAt` | `Timestamp` | — |

---

### `processed_requests/{requestId}`

Idempotency log. Document ID = WhatsApp message ID or driver `requestId` UUID.

| Field | Type | Notes |
|---|---|---|
| `status` | `string` enum | `in_progress \| completed` |
| `type` | `string` | Request category, including `whatsapp_message` and `razorpay_webhook` |
| `ownerToken` | `string` | Random lease owner; only this owner may complete or release the record |
| `claimedAt` | `Timestamp` | When the current owner claimed or reclaimed processing |
| `leaseUntil` | `Timestamp \| null` | Active lease expiry; null after completion |
| `processedAt` | `Timestamp \| null` | Written when owned work completes |
| `actorUid` | `string \| null` | Phase 4 authenticated actor binding |
| `operation` | `string \| null` | `accept \| decline \| driver_cancel \| start_job \| complete_job` for Phase 4 client mutations |
| `resourceId` | `string \| null` | Canonical immutable job/offer resource identity |
| `payloadHash` | `string \| null` | Prevents reuse of a request ID with different input |
| `result` | `map \| null` | Stored stable result for an idempotent retry |

The Phase 4 binding fields are optional for legacy Phase 3 webhook records.
Financial/domain completion must be committed with its job/wallet transaction;
the generic owner lease alone is not a financial exactly-once guarantee.

---

### `driver_otps/{phoneNumber}`

Document ID = the driver's normalized E.164 WhatsApp phone number. Managed
exclusively by Cloud Functions. The OTP itself is never stored.

| Field | Type | Notes |
|---|---|---|
| `challengeId` | `string` | Random identifier replaced on every permitted resend |
| `hash` | `string` | Scrypt-derived OTP hash; never plaintext |
| `salt` | `string` | Random per-challenge salt |
| `expiresAt` | `Timestamp` | Challenge expiry computed from `otpPolicy.otpExpirySeconds` |
| `attempts` | `number` | Verification attempts against the current challenge |
| `consumedAt` | `Timestamp \| null` | Set once after successful verification |
| `lastSentAt` | `Timestamp` | Enforces resend cooldown |
| `sendWindowStartedAt` | `Timestamp` | Start of the current abuse-accounting window |
| `sendCount` | `number` | Permitted sends in the current window; resends do not reset it |
| `blockedUntil` | `Timestamp \| null` | Send block set after the current window reaches its configured maximum |
| `verifiedUid` | `string \| null` | Firebase Auth UID associated when the unchanged challenge is consumed; cleared when a resend replaces the challenge |

Successful verification consumes the unchanged challenge before Firebase Auth
lookup/creation and custom-token minting. If Auth or token creation then fails,
that challenge remains consumed and cannot be replayed; the driver must request
a new OTP after the normal cooldown. Resend replacement preserves the active
send-window abuse counters.

---

### `pricing_config/main`

Single document. Read by authenticated clients; written only via Cloud Functions (Config Editor, Phase 6).

See `firebase/seed/pricing_config.json` for exact field names and starter values.

**Key invariant for Tier 3 commission:**
```
driverCommission = tier3_driver_commission_base
                 + (per_km_overage_rate × (distanceKm − long_distance_limit_km))
```
`per_km_overage_rate` lives under `booking_tiers`, not `fare_formula`. `fareCalculator.js` (Phase 2) is the single implementation of this formula — it is never duplicated elsewhere.

Phase 4 adds the following fields to `cancellation_policy`:

| Field | Type / initial value | Notes |
|---|---|---|
| `version` | positive integer / `1` | Increment for any future financial-policy change |
| `timezone` | string / `Asia/Kolkata` | Calendar-month boundary |
| `roundingMode` | string / `HALF_UP` | Integer-paise forfeiture rule |

Acceptance snapshots the complete versioned policy onto the accepted
`job_offers` record.

---

### `usage_counters/{YYYY-MM}`

One document per calendar month. Cloud Function–only access.

| Field | Type | Notes |
|---|---|---|
| `olaMapsMatrixRequests` | `number` | Transactionally incremented before each Matrix HTTP attempt |
| `olaMapsMatrixPairs` | `number` | Transactionally incremented by planned origin×destination pairs before each attempt |
| `whatsappTemplateSends` | `number` | Incremented on each business-initiated template send |
| `softCapWhatsapp` | `number` | Default: 900 |
| `updatedAt` | `Timestamp` | Last shared-counter mutation |

The Ola monthly pair cap lives in deployment-confirmed `dispatch_config` and
is initially null/unconfigured. Legacy `olaMapsMatrixCalls` and
`softCapOlaMaps` may be preserved for migration/audit but are not authoritative
for production authorization.

---

### `admin_actions/{actionId}`

Append-only audit log. Auto-ID documents. Admin-claim read, Cloud Function write only.

| Field | Type | Notes |
|---|---|---|
| `adminUid` | `string` | UID of the admin who triggered the action, or `'system'` for automated jobs |
| `action` | `string` | e.g. `approve_driver \| reject_driver \| forgive_cancellation \| update_pricing_config \| create_phone_booking \| retention_cleanup` |
| `target` | `string` | Document ID of the affected resource (driver UID, job ID, etc.) |
| `reason` | `string \| null` | Required for rejection and forgiveness actions |
| `timestamp` | `Timestamp` | — |
| `metadata` | `map \| null` | Optional additional context (e.g. old vs new config values) |

---

### `business_config/main`

Single document. Admin-claim read, Cloud Function write only.

| Field | Type | Notes |
|---|---|---|
| `businessName` | `string` | Display name on GST invoices |
| `gstin` | `string` | GST Identification Number |
| `registeredAddress` | `string` | Registered business address |
| `invoiceNumberCounter` | `number` | Incremented atomically by invoicing Cloud Function. **Never edit manually.** |
| `retention_policy.retention_months` | `number` | DPDP retention window in months. `0` = not configured (no deletion). |
| `otpPolicy.otpExpirySeconds` | `number` | OTP lifetime. Seed: `300`. |
| `otpPolicy.resendCooldownSeconds` | `number` | Minimum delay between sends. Seed: `60`. |
| `otpPolicy.maxSendsPerWindow` | `number` | Permitted sends before blocking. Seed: `5`. |
| `otpPolicy.sendWindowSeconds` | `number` | Abuse-accounting window. Seed: `900`. |
| `otpPolicy.blockDurationSeconds` | `number` | Send block duration. Seed: `3600`. |
| `otpPolicy.maxVerificationAttempts` | `number` | Attempts per challenge; the next attempt is rejected before scrypt or increment. Seed: `5`. |
| `whatsappOtpTemplate.templateName` | `string` | Meta-approved authentication-template name. Empty is intentionally unconfigured and OTP send fails closed. |
| `whatsappOtpTemplate.languageCode` | `string` | Approved template language/locale code, such as `en_US`; must match the approved template. |

When a send window or block expires, the next permitted send starts a fresh
window with a fresh counter. Replacing an OTP challenge never erases the active
window's abuse counters, while clearing prior-challenge `verifiedUid` metadata.
These fields are operational configuration, not secrets. `OTP_PEPPER` is
supplied through Secret Manager and must not appear in this document.

The WhatsApp OTP template identity is non-secret deployment configuration. The
OTP plaintext is never stored; it exists only long enough to derive the scrypt
hash and populate the outbound authentication-template parameters.

---

## Firebase Storage Paths

| Path | Writer | Reader | Notes |
|---|---|---|---|
| `driver_verification/{driverId}/id.jpg` | Driver (own UID only) | Driver (own) + admin-claim | Aadhaar / DL photo. In-app camera only — no gallery. |
| `driver_verification/{driverId}/rc.jpg` | Driver (own UID only) | Driver (own) + admin-claim | Vehicle RC photo. |
| `driver_verification/{driverId}/selfie.jpg` | Driver (own UID only) | Driver (own) + admin-claim | Live selfie taken at submission time. |
| `invoices/{jobId}.pdf` | Cloud Function (Admin SDK) | Admin-claim only | GST invoice PDF. Delivered to customer via WhatsApp. |

**Never publicly readable.** No `getDownloadURL()` calls that produce unauthenticated access tokens are permitted for either path.

---

## Access Control Summary

| Who | Can do |
|---|---|
| Unauthenticated | Nothing |
| Authenticated driver (own doc) | Read own driver doc; update allowed display/duty fields and paired `location`/server-time `locationUpdatedAt`; correct truck/vehicle only while not approved; upload own verification photos |
| Authenticated driver (own offers) | Query/read only sanitized `job_offers` where `driverId` is their UID; no offer writes and no complete-job reads |
| Authenticated driver (other) | Nothing |
| Admin-claim user | Read approved operational/admin collections; no direct sensitive writes (all mutations via audited Cloud Functions) |
| Cloud Function (Admin SDK) | Bypasses all Firestore and Storage rules; responsible for its own validation |
