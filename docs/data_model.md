# Data Model Reference — Towing Dispatch System

> Generated during Phase 1. Authoritative field names for all Firestore collections and Storage paths.
> Source of truth: `towing_dispatch_spec_v9.md`. This document is a human-readable summary intended to
> prevent field-name typos across phases — it is not a substitute for reading the spec.

---

## Firestore Collections

### `drivers/{driverId}`

Document ID = Firebase Auth UID.

| Field | Type | Default | Writer | Notes |
|---|---|---|---|---|
| `uid` | `string` | — | driver | Same as doc ID |
| `name` | `string` | — | driver | Full name |
| `phone` | `string` | — | driver | E.164 format (+91…) |
| `truckType` | `string` enum | — | driver | `flatbed \| tochan \| hydraulic \| crane` |
| `vehicleNumber` | `string` | — | driver | e.g. `MH-46-XXXX` |
| `isOnDuty` | `boolean` | `false` | driver | Home screen toggle |
| `location` | `GeoPoint \| null` | `null` | driver | Updated by background location service (Phase 5) |
| `walletBalance` | `number` | `0` | **Cloud Function only** | Store as integer paise (INR × 100) to avoid float precision issues |
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
| `updatedAt` | `Timestamp` | — | driver / Cloud Function | Updated on every write |

**Security rule invariant:** a driver auth'd client can never write `walletBalance`, `verificationStatus`, `bannedUntil`, `strictMode`, `monthlyCancelCount`, `verificationDocs` (including `idPhotoUrl`, `rcPhotoUrl`, `selfiePhotoUrl`, `submittedAt`), or `rejectionReason`. These are Cloud Function–only fields enforced in `firestore.rules`.

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
| `offerExpiresAt` | `Timestamp \| null` | `null` | Cloud Task scheduled for this time |
| `requestId` | `string` | — | Client UUID for accept idempotency |
| `cancelledBy` | `string \| null` | `null` | `customer \| driver \| system` |
| `cancellationRequestedAt` | `Timestamp \| null` | `null` | — |
| `cancellationReason` | `string \| null` | `null` | — |
| `razorpayRefundId` | `string \| null` | `null` | — |
| `refundConfirmedAt` | `Timestamp \| null` | `null` | — |
| `refundedAmountPaise` | `number \| null` | `null` | Customer booking-fee refund confirmed by Razorpay, in integer paise; not a driver-wallet credit |
| `forfeitedAmount` | `number \| null` | `null` | Paise |
| `createdAt` | `Timestamp` | — | — |
| `updatedAt` | `Timestamp` | — | — |

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

---

### `usage_counters/{YYYY-MM}`

One document per calendar month. Cloud Function–only access.

| Field | Type | Notes |
|---|---|---|
| `olaMapsMatrixCalls` | `number` | Incremented by dispatch on each Matrix API call |
| `whatsappTemplateSends` | `number` | Incremented on each business-initiated template send |
| `softCapOlaMaps` | `number` | Default: 4,500,000 (90% of 5M free tier) |
| `softCapWhatsapp` | `number` | Default: 900 |

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
| Authenticated driver (own doc) | Read own driver doc; write allowed fields (name, truckType, vehicleNumber, isOnDuty, location); upload own verification photos to Storage |
| Authenticated driver (other) | Nothing |
| Admin-claim user | Read everything in `drivers`, `jobs`, `admin_actions`, `business_config`; no direct writes (all writes via Cloud Functions) |
| Cloud Function (Admin SDK) | Bypasses all Firestore and Storage rules; responsible for its own validation |
