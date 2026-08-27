# Phase 3 Repair Requirement Matrix

This matrix ties the Phase 3 production invariants to focused tests. It is a
repair checklist, not evidence by itself; concurrency claims require the
Firestore emulator rather than the in-memory unit fake.

| Area | Required invariant | Primary production module | Required test level |
|---|---|---|---|
| Configuration | No fallback Meta, Razorpay, or OTP secrets; environment names match deployed bindings | `src/index.js`, provider clients, OTP service | Unit/config contract |
| Utilities | Strict phone/coordinate validation; deterministic IST independent of host timezone | `src/utils/phone.js`, `date.js`, `haversine.js` | Unit, timezone subprocess |
| Idempotency | Owner-token lease; stale owners cannot complete or release a reclaimed request | `src/utils/idempotency.js` | Unit plus Firestore emulator |
| WhatsApp authenticity | GET token verification and POST raw-body SHA-256 HMAC before parsing/side effects | `src/messaging/whatsappWebhook.js` | Handler contract |
| WhatsApp sessions | Same-message resume, different-message active-lease rejection, stale reclaim, pending-reply recovery, no duplicate state advance | `src/messaging/whatsappWebhook.js` | Failure injection plus Firestore emulator |
| Job creation | Exact caller-provided ID; immutable retry validation; normalized phone; valid coordinates/channel/truck type | `src/services/jobService.js` | Unit plus Firestore emulator |
| Pricing | Haversine distance; IST hour; Phase 2 `calculateCommission` and `calculateFare`; persisted paise fields | `src/services/jobService.js` | Unit/Phase 2 integration |
| Payment Link | Local reuse, official `payment_links` recovery shape, strict candidate validation, owner-fenced provisioning, remote-create/local-save recovery | `src/services/razorpayClient.js`, `jobService.js` | Provider contract/failure injection plus emulator |
| Payment webhook | Raw signature first; strict paid payload; payment-ID identity; fail-closed partial markers; atomic payment persistence; cancellation race; resumable invoice/handoff | `src/payments/razorpayWebhook.js` | Handler/failure injection plus emulator |
| Customer cancellation | Marker first; remote cancellation outside transaction; confirmed-unpaid finalization; paid-race reconciliation with customer provenance and owner-safe session reset; no customer refund | `src/messaging/whatsappWebhook.js`, `razorpayClient.js` | Unit/failure injection plus emulator |
| Invoice | Booking fee only; atomic number recovery; private Storage path; internally consistent completion markers; `invoiceSentAt` means Meta accepted the send, with at-least-once external delivery | `src/services/invoiceService.js`, `whatsappClient.js` | Unit/provider failure injection plus emulator |
| Refund | Strict `refund.processed`; refund-ID identity; fail-closed partial markers; unique matching system/no-driver job; exact booking fee | `src/payments/razorpayWebhook.js` | Handler plus emulator |
| OTP send | Configured expiry/cooldown/window/block policy; approved Meta authentication-template configuration; random OTP/salt; async scrypt; no persisted plaintext | `src/services/otpService.js`, `whatsappClient.js` | Unit/provider contract plus emulator |
| OTP verify | Attempt limit before scrypt; unchanged-challenge consumption before Auth; expiry recheck; Auth/token failure requires a new OTP | `src/services/otpService.js` | Unit/failure injection plus emulator |
| Fake infrastructure | Unit fake must not be cited as transaction-isolation or conflict evidence | `tests/phase3/fakeDeps.js` | Documented limitation |

Deployment gate: Phase 3 persists successfully paid jobs at the durable
`pending_offer` boundary and calls only the Phase 4 boundary stub. Phase 3 must
not receive production/live payment traffic until Phase 4 supplies a durable
consumer or backlog-reconciliation mechanism for every `pending_offer` job.
