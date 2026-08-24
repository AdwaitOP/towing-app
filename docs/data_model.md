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
| `vehicleType` | `string` | — | Customer's vehicle type |
| `distanceKm` | `number` | — | Haversine straight-line distance |
| `bookingFee` | `number` | — | Platform fee (paise). **Never the full fare.** |
| `driverCommission` | `number` | — | Deducted from driver wallet on accept (paise) |
| `estimatedFare` | `number` | — | Informational only. Customer pays driver directly. |
| `status` | `string` enum | `pending_offer` | `pending_offer \| offered \| accepted \| in_progress \| completed \| cancelled_customer \| cancelled_driver \| cancelled_system` |
| `offeredTo` | `string \| null` | `null` | UID of driver currently being offered the job |
| `assignedDriver` | `string \| null` | `null` | UID of driver who accepted |
| `channel` | `string` enum | — | `whatsapp \| phone` |
| `createdByAdmin` | `string \| null` | `null` | Admin UID for phone-originated bookings |
| `razorpayOrderId` | `string \| null` | `null` | — |
| `razorpayPaymentId` | `string \| null` | `null` | Stored for refund operations |
| `invoiceNumber` | `string \| null` | `null` | Sequential GST invoice number |
| `invoiceUrl` | `string \| null` | `null` | Storage URL for invoice PDF |
| `offerExpiresAt` | `Timestamp \| null` | `null` | Cloud Task scheduled for this time |
| `requestId` | `string` | — | Client UUID for accept idempotency |
| `cancelledBy` | `string \| null` | `null` | `customer \| driver \| system` |
| `cancellationReason` | `string \| null` | `null` | — |
| `refundedAmount` | `number \| null` | `null` | Paise |
| `forfeitedAmount` | `number \| null` | `null` | Paise |
| `createdAt` | `Timestamp` | — | — |
| `updatedAt` | `Timestamp` | — | — |

---

### `whatsapp_sessions/{phoneNumber}`

Document ID = customer phone in E.164 format. Managed exclusively by Cloud Functions (Admin SDK). No client access.

| Field | Type | Notes |
|---|---|---|
| `phoneNumber` | `string` | E.164 |
| `state` | `number` | Conversation state: 0=intent, 1=pickup, 2=destination, 3=vehicleType, 4=fareQuote, 5=paymentSent |
| `intent` | `string \| null` | `tow \| mechanic` — set at State 0 |
| `pickupCoords` | `map \| null` | Accumulated across states |
| `destCoords` | `map \| null` | — |
| `vehicleType` | `string \| null` | — |
| `jobId` | `string \| null` | Set once job is created |
| `updatedAt` | `Timestamp` | — |

---

### `processed_requests/{requestId}`

Idempotency log. Document ID = WhatsApp message ID or driver `requestId` UUID.

| Field | Type | Notes |
|---|---|---|
| `processedAt` | `Timestamp` | When this request was first handled |
| `type` | `string` | `whatsapp_message \| accept_job` |

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
