# Phase 4 Decision Lock and Stage 1 Contract

Status: **Accepted — owner-approved**

Decision date: **2026-08-28**

Scope: **Phase 4 architecture and Stage 1 schema/rules/index contract only**

Implementation status: **Stage 0 decision lock complete; Stage 1 schema/rules/index artifacts only. No Phase 4 production runtime is implemented by this document.**

This ADR is the authoritative decision record for Phase 4. It supplements
`towing_dispatch_spec_v9.md`, `BUILD_PHASES.md`, and `docs/data_model.md`. Where
older Phase 4 wording conflicts with an accepted decision below, this ADR wins.
It does not change the trusted Phase 1–3 payment, invoicing, OTP, or messaging
behavior.

## Architectural boundary

Phase 3 establishes the durable boundary by atomically persisting a verified
paid job as `pending_offer`. Its `triggerDispatch(jobId)` call may happen zero,
one, or multiple times and is only an accelerator. Phase 4 correctness comes
from database-owned state and a lease-based reconciler:

```text
Firestore transaction establishes authoritative state
  -> external effect after commit
  -> durable progress marker
  -> lease-based reconciliation
  -> every retry revalidates current state and semantic identity
```

Paid live traffic remains disabled until the durable `pending_offer` consumer
and reconciler exist and pass real Firestore Emulator concurrency tests.

## Decision register

| ID | Decision | Rationale | Affected state/schema/module | Kind |
|---|---|---|---|---|
| P4-D001 | Matching uses backend-owned `canFlatbed` and `canPulling`. `flatbed` requires `canFlatbed == true`; `pulling` requires `canPulling == true`. `truckType` remains separate descriptive verified data. | Display labels are not a safe compatibility matrix. | `drivers`, eligibility, verification/admin callable | Invariant |
| P4-D002 | Eligibility requires `isOnDuty === true`. | The duty toggle means whether the driver is accepting jobs. | `drivers`, matcher, accept revalidation | Invariant |
| P4-D003 | One active job per driver across `accepted` and `in_progress`, represented by backend-owned `activeJobId`. | Prevents the same driver accepting two jobs. | `drivers`, accept/start/complete/cancel transactions | Invariant |
| P4-D004 | One active offer per driver, represented by backend-owned `activeOfferId`. | Prevents conflicting simultaneous offers. | `drivers`, offer/decline/timeout/accept transactions | Invariant |
| P4-D005 | Location freshness is configurable; initial `locationFreshnessSeconds` is `120`. A stationary driver may refresh by reporting the same valid GeoPoint with `locationUpdatedAt == request.time`; a changed point requires the same timestamp pairing. Missing, malformed, deleted, arbitrary-time, or stale location fails closed. | Stale coordinates are unsafe dispatch input, while value equality must not block a legitimate freshness report. | `dispatch_config`, rules, `drivers.locationUpdatedAt`, eligibility | Configurable value; fail-closed invariant |
| P4-D006 | Search radii are `[10, 20, 35]` km; maximum unique candidates per generation is `30`; maximum Matrix shortlist per round is `10`; candidates are deduplicated across the generation. | Establishes a finite, recoverable search policy. | `dispatch_config`, dispatch run, matcher | Configurable values; finite/deduplicated invariant |
| P4-D007 | Rank by Ola routed ETA, then Ola routed distance, then driver UID. | Produces operationally useful and deterministic ordering. | matcher, dispatch-run candidate metrics | Invariant |
| P4-D008 | A driver is never offered the same job twice in one dispatch generation. | Prevents duplicate pressure and ambiguous exhaustion. | dispatch run, offer creation | Invariant |
| P4-D009 | Ola timeout/429/5xx receives bounded retry, then explicit Haversine degraded mode. Provider failure is never `no_driver_found`. | Infrastructure failure is not market exhaustion. | Ola client, matcher, retry/hold state | Failure classification invariant; timing configurable |
| P4-D010 | Track Matrix HTTP requests and origin×destination pairs separately. The historical 4.5M soft cap is not authoritative; the production pair/cost cap is mutable deployment configuration that must be revalidated before every pair reservation/provider attempt and is never snapshotted as run authority. | Provider accounting is pair-sensitive and operators must be able to reduce/disable spend for recovered old runs. | `usage_counters`, current `dispatch_config`, shared counter service, deployment config | Counters/current-cap invariant; cap configurable |
| P4-D011 | Exclude drivers whose `walletBalance < driverCommissionPaise` before offering, and revalidate the same condition in the accept transaction. | Avoids unusable offers without weakening financial concurrency checks. | matcher, offer, accept | Invariant |
| P4-D012 | Explicit decline is supported, penalty-free, resolves the offer immediately, and advances the cursor. | Avoids waiting 45 seconds when the driver has answered. | offer state, decline callable, dispatch run | Invariant |
| P4-D013 | An assigned driver may self-cancel only while job status is `accepted`. Apply the monthly policy, release the driver, exclude them for the current generation, return the job to `pending_offer`, and continue remaining candidates. Do not terminally cancel the customer job. | Preserves the paid customer’s chance of service while retaining the approved driver penalty. | job/offer/driver/wallet transactions, dispatch run | Invariant |
| P4-D014 | Normal driver self-cancellation while `in_progress` is initially unsupported; exceptional failures go to admin/support. | Post-pickup recovery requires a separate operational policy. | cancel callable, admin/support | Invariant until superseded |
| P4-D015 | `accepted -> in_progress` is an authenticated assigned-driver callable with client `requestId`. | Makes the transition authorized and idempotent. | start callable, request receipt, job/offer | Invariant |
| P4-D016 | `in_progress -> completed` is an authenticated assigned-driver callable with client `requestId`. | Makes completion authorized and idempotent. | complete callable, request receipt, job/offer/driver | Invariant |
| P4-D017 | Use top-level `job_offers` with a sanitized driver-facing projection. Drivers do not read complete job documents because of an offer or assignment. | Prevents payment/customer/internal-field exposure and preserves offer history. | schema, rules, Phase 5 feed | Invariant |
| P4-D018 | Firestore `job_offers` is the authoritative driver offer feed. FCM belongs to Phase 5 unless separately brought forward. Important customer lifecycle messages use the WhatsApp outbox. | Keeps backend truth independent of push delivery. | offer feed, outbox, Phase 5 | Invariant; FCM timing configurable |
| P4-D019 | Cloud Tasks and worker timing are configurable; correctness cannot depend on exact retry/rate/lease values. Offer lifetime remains exactly 45 seconds. | Operational tuning must not change safety. | task queue, workers, reconciler | 45s invariant; other timing configurable |
| P4-D020 | Cancellation calendar month is `Asia/Kolkata`. | Establishes one business-month boundary. | cancellation policy evaluator | Invariant |
| P4-D021 | Fractional-paise forfeiture uses HALF-UP; `creditPaise = commissionPaise - forfeiturePaise`. Ledger arithmetic and deterministic IDs are type-specific and all money values are safe integer paise. | Prevents creation/loss of paise and duplicate semantic entries. | money utility, wallet ledger | Invariant |
| P4-D022 | Snapshot and version the driver-cancellation policy when a job is accepted. | Later config changes cannot silently alter an accepted job’s financial terms. | accepted offer, pricing config, cancellation | Invariant |
| P4-D023 | Wallet top-up is a production prerequisite and may be a separate Phase 4 prerequisite/substage. No wallet source may be invented. | Acceptance cannot safely launch without funded balances. | wallet/top-up boundary, production gate | Deployment prerequisite |
| P4-D024 | Missing/malformed driver, wallet, or financial-policy fields fail closed and produce an operationally visible reason code. | Silent defaults can misassign jobs or corrupt money. | validators, dispatch failure metadata | Invariant |
| P4-D025 | Infrastructure/provider failures enter durable retry or operational hold and are never reclassified as no-driver. | Protects customers from false cancellation/refund. | dispatch state, reconciler, provider clients | Invariant |
| P4-D026 | `no_driver_found` occurs only after the persisted finite policy for the current generation is genuinely exhausted. | Makes system cancellation auditable. | dispatch run, no-driver transaction | Invariant |
| P4-D027 | GCP budget threshold and recipients are deployment configuration; the historical `$5` example is not production policy. | Billing-account context is deployment-specific. | GCP billing configuration | Configurable deployment gate |
| P4-D028 | Wallet ledger records are permanent. Operational retention for offers, dispatch runs, outbox, and request receipts remains configurable; no destructive period is assumed. | Financial audit evidence must remain durable. | ledger and operational collections | Ledger invariant; other retention configurable |
| P4-D029 | Canonical verification status remains `pending`; do not migrate to `pending_verification`. | Matches committed schema and rules. | driver schema, onboarding/admin logic | Invariant |
| P4-D030 | Applicable Phase 4 provider usage uses one shared transactional counter service. | Prevents divergent quota accounting. | usage service, Ola/WhatsApp callers | Invariant |
| P4-D031 | Critical job/offer/wallet/ledger/refund writes are backend-only; drivers cannot mutate wallet, verification, ban, capability, or engagement fields; sensitive admin mutations use audited callables. Driver ledger read is denied until separately approved. | Preserves authorization and money integrity. | Firestore rules and backend callables | Invariant |
| P4-D032 | The database is workflow authority, and paid live traffic stays disabled until the reconciler and concurrency tests pass. | Phase 3’s callback is explicitly non-durable and retryable. | production gate, dispatch boundary, reconciler | Invariant |
| P4-D033 | Dispatch-run `assigned` is nonterminal. Acceptance moves `active -> assigned`; an accepted-driver cancellation moves `assigned -> active` in the same generation with authoritative `nextCandidateIndex` exactly unchanged, history preserved, and cancelling driver consumed/excluded. | Acceptance may later resume same-generation dispatch, so it cannot finalize the run. | dispatch-run state, cancellation matrix | Invariant |
| P4-D034 | Accepted-driver cancellation uses the exact atomic reset matrix below; current job assignment/offer pointers are cleared and history survives only in offer/run/ledger evidence. | Prevents stale current-assignment state and Stage 8 invention. | job/offer/driver/run/receipt transaction | Invariant |
| P4-D035 | Wallet operation IDs are exactly `commission_debit:{jobId}:{offerId}`, `customer_cancel_credit:{jobId}:{offerId}`, and `driver_cancel_credit:{jobId}:{offerId}`. The `offerId` is the immutable accepted-offer document ID and is the occurrence identity of each accepted-driver assignment. Using `{offerId}` rather than `{driverId}` ensures that the same driver accepting in two different dispatch generations for the same job produces distinct immutable ledger IDs, while the same acceptance occurrence retried always produces the same ID. Driver-cancel entries carry complete immutable policy evidence and exist even for zero-credit/full-forfeiture. | The permanent ledger must remain independently auditable after operational retention and must not collide across legitimate re-acceptance occurrences. | wallet ledger | Invariant |
| P4-D036 | No-driver refund intent, provider request identity, and signed reconciliation converge monotonically. `providerIdempotencyKey` and canonical request hash are durable before the first external attempt; matching `refund.processed` may confirm from any non-confirmed state and `confirmed` never regresses. | Handles response-loss and webhook/worker reordering without duplicate or contradictory refunds. | refund request, job projection, Stage 9 Phase 3 integration | Invariant |
| P4-D037 | Stage 2 backlog bootstrap first queries `status == pending_offer` without ordering by new Phase 4 fields, then transactionally initializes safe operational defaults. | Firestore ordered queries omit legacy documents missing the ordered field. | backlog recovery, compatibility | Invariant |
| P4-D038 | Razorpay no-driver refund identity is exactly `refund_no_driver_found_{jobId}` and must match `^refund_no_driver_found_[A-Za-z0-9_-]+$`. Firestore auto-generated job IDs satisfy the provider alphabet; a nonconforming job ID fails closed before refund intent is created. The key is stored before the first request and is invariant across retries, attempt numbers, and workers. | Razorpay refund idempotency keys permit letters, digits, hyphens, and underscores only. | refund request, Stage 9 provider call | Invariant |
| P4-D039 | The future Razorpay operation is `POST payments/{razorpayPaymentId}/refund` with body `{ amount: bookingFeePaise }`. Its canonical semantic identity is `JSON.stringify({ paymentId: razorpayPaymentId, amount: bookingFeePaise })`, constructed in that exact key order with no optional/undefined fields; `providerRequestHash` is the lowercase SHA-256 hex of its UTF-8 bytes. Payment, amount, provider key, canonical string, and hash are identical on every retry. | Makes response-loss recovery independently verifiable without inventing optional provider fields. | refund request, Stage 9 provider call | Invariant |
| P4-D040 | Customer cancellation marker wins over accepted-driver cancellation. The driver transaction requires `cancellationRequestedAt == null`, `cancellationResolutionState == none`, `cancellationResolvedAt == null`, `cancelledAt == null`, `cancelledBy == null`, and `cancellationReason == null`. Every cancellation provenance field must be null — not merely different from customer-specific values — so that any unexpected stale provenance fails closed and never silently allows a driver cancellation path to overwrite resolution state. If any customer marker/resolution/terminal evidence is present, driver cancel returns a stable non-penalizing result and changes no job, offer, driver, run, wallet, or ledger domain state; the customer resolver owns resolution. | Prevents the driver path from penalizing a customer-triggered cancellation or overwriting its provenance, including partially repaired/legacy marker states. A null guard is stronger than a value inequality and correctly handles unexpected stale values. | cancellation resolver, driver-cancel transaction | Invariant |
| P4-D041 | Every no-driver refund initiation attempt sends request header `X-Refund-Idempotency` whose value is exactly the durable immutable `providerIdempotencyKey`. The header name and value binding are invariant across attempts and workers. | Locks the provider transport binding, not only an internal key value, so response-loss retries cannot silently omit or rename provider idempotency. | refund request, Stage 9 provider call | Invariant |
| P4-D042 | A `submitted` refund remains durably scheduled for reclaimable provider-status reconciliation using its stored payment/refund IDs until confirmation. A matching provider `processed` result may confirm request/job transactionally; matching `pending` or unavailable/uncertain lookup stays `submitted` with bounded retry metadata and never resubmits; a matching provider `failed` result moves transactionally to `failed_terminal` and disables automated retry while preserving all identities and updating the job projection. A later valid matching signed `refund.processed` webhook can still converge `failed_terminal` to `confirmed`. Provider lookup and signed webhook races converge through identity-validated transactions; `confirmed` is absorbing and mismatches fail closed. | A signed webhook can be missed indefinitely; durable fetch reconciliation closes that liveness gap without duplicate provider initiation, while definitive failure terminates ordinary retry without blocking late signed webhook proof. | refund request, job projection, Stage 9 reconciliation | Invariant |
| P4-D043 | Stage 1 notification outbox events are exactly `job_accepted`, `job_in_progress`, `job_completed`, `job_cancelled_customer`, `job_cancelled_system`, and `refund_confirmed`, delivered only through `whatsapp`. Resource types are exactly `job|refund_request`; payload version 1 has exact keys `jobId`, `jobStatus`, and `refundAmountPaise`, with event-specific bindings. No offer event, customer phone, coordinates, driver/payment identity, provider body, credential, or secret is stored in the payload. | Converts an unconstrained map into an auditable, privacy-bounded Stage 1 contract without introducing Phase 5 driver delivery. | notification outbox | Invariant |

## Final state-transition contract

### Job lifecycle

`dispatchState` is an internal Phase 4 workflow axis. It does not add
`operational_hold` to the customer-facing `jobs.status` enum. A provider hold
therefore keeps `jobs.status == pending_offer` while `dispatchState ==
operational_hold`.

| From `jobs.status` | Event/guard | To `jobs.status` | Required atomic consequences | Ownership |
|---|---|---|---|---|
| `awaiting_payment` | Verified exact booking-fee payment, no customer cancellation winner | `pending_offer` | Existing Phase 3 payment fields remain authoritative | Phase 3, unchanged |
| `awaiting_payment` | Existing unpaid/paid-race customer cancellation path | `cancelled_customer` | Existing Phase 3 cancellation behavior | Phase 3, unchanged |
| `pending_offer` | Current dispatch generation publishes a valid offer | `offered` | Set current offer fields and driver `activeOfferId` | Phase 4 |
| `pending_offer` | Customer cancellation wins | `cancelled_customer` | Close dispatch; no booking-fee refund | Phase 3/4 boundary |
| `pending_offer` | Persisted finite generation is genuinely exhausted, including after an accepted-driver redispatch | `cancelled_system` | `system/no_driver_found`; create exact booking-fee refund request; any prior driver cancellation ledger remains final | Phase 4 |
| `offered` | Target driver accepts valid offer with sufficient wallet | `accepted` | Assign driver, debit wallet+ledger, set `activeJobId`, snapshot cancellation policy | Phase 4 |
| `offered` | Target driver declines | `pending_offer` | Offer `declined`; clear `activeOfferId`; advance cursor | Phase 4 |
| `offered` | 45 seconds elapse and current offer is still valid | `pending_offer` | Offer `expired`; clear `activeOfferId`; advance cursor | Phase 4 |
| `offered` | Customer cancellation wins | `cancelled_customer` | Cancel offer; clear driver engagement; no booking-fee refund | Phase 4 |
| `accepted` | Assigned driver starts with new client `requestId` | `in_progress` | Update job and accepted offer together | Phase 4 |
| `accepted` | Customer cancellation wins | `cancelled_customer` | Full commission credit+ledger; release `activeJobId` | Phase 4 |
| `accepted` | Assigned driver self-cancels | `pending_offer` | Apply snapshotted ramp; credit permitted remainder; exclude driver; release; continue same generation | Phase 4 |
| `in_progress` | Assigned driver completes with new client `requestId` | `completed` | Update job/offer; release `activeJobId` | Phase 4 |
| `in_progress` | Customer cancellation wins | `cancelled_customer` | Full commission credit+ledger; release `activeJobId` | Phase 4 |

Illegal initial transitions include accepting a non-current/expired offer,
driver self-cancellation from `in_progress`, completing from `accepted`,
starting from `offered`, any normal driver-cancel transition to terminal
`cancelled_driver`, and every transition out of `completed` or a cancellation
terminal. `cancelled_driver` remains in the legacy enum but is not emitted by
the approved normal Phase 4 driver-cancellation path.

### Internal dispatch state

Target enum:

```text
not_started | ready | claimed | selecting | retry_wait |
operational_hold | offered | assigned | closed
```

| From | To | Cause |
|---|---|---|
| `not_started` or missing | `ready` | Phase 4 materializes a paid `pending_offer` backlog job |
| `ready` | `claimed` | Owner/lease transaction succeeds |
| `claimed` | `selecting` | Current owner begins/recoverably resumes matching |
| `selecting` | `offered` | Current candidate offer is committed |
| `selecting` | `retry_wait` | Retryable provider/infrastructure failure with next action time |
| `selecting` | `operational_hold` | Retry policy cannot proceed safely or required deployment config is absent |
| `retry_wait` | `claimed` | Due retry is claimed |
| `operational_hold` | `ready` | Admin/config/recovery condition explicitly clears the hold |
| `offered` | `ready` | Decline or expiry resumes the same generation |
| `offered` | `assigned` | Offer acceptance commits |
| `assigned` | `ready` | Accepted driver cancellation resumes the same generation |
| any nonterminal | `closed` | Customer cancellation, genuine no-driver exhaustion, or job completion |

Provider failure may move only to `retry_wait` or `operational_hold`; it may
not move to `closed` through `no_driver_found`.

### `job_offers` lifecycle

Target enum:

```text
offered | accepted | in_progress | completed | declined | expired |
cancelled_customer | cancelled_driver | superseded
```

Legal transitions:

```text
offered -> accepted -> in_progress -> completed
offered -> declined | expired | cancelled_customer | superseded
accepted -> cancelled_customer | cancelled_driver
in_progress -> cancelled_customer
```

All other transitions are illegal. A stale task/call returns a successful
no-op or stable stale-domain result without mutating newer state.

### Driver engagement

| Event | `activeOfferId` | `activeJobId` |
|---|---|---|
| Offer published | Set to offer ID | Must be null |
| Decline/expiry/customer cancellation/supersede | Clear | Unchanged/null |
| Acceptance | Clear | Set to job ID |
| Start towing | Null | Remains job ID |
| Completion/customer cancellation/accepted-driver cancellation | Null | Clear |

### Accepted-driver cancellation atomic reset matrix

This transaction is legal only while the authenticated driver is the current
`assignedDriver`, `jobs.status == accepted`, `dispatchState == assigned`, the
current offer is `accepted`, the request receipt is new or binding-identical,
`cancellationRequestedAt == null`, `cancellationResolutionState == none`,
`cancellationResolvedAt == null`, `cancelledAt == null`, `cancelledBy == null`,
and `cancellationReason == null`.
A legacy missing resolution field is not permission to bypass an
existing customer marker; the transaction must prove the complete customer
cancellation fence before applying policy. It does not implement a runtime
handler in Stage 1; it fixes the future runtime contract.

| Document | Field/evidence | Exact winning-transaction result |
|---|---|---|
| job | `status` | `accepted -> pending_offer` |
| job | `dispatchState` | `assigned -> ready` |
| job | `assignedDriver`, `offeredTo`, `currentOfferId` | set `null` |
| job | `offeredAt`, `offerExpiresAt`, `acceptedAt` | set `null` |
| job | `commissionDebitEntryId` | set `null` after immutable debit/credit entries are committed |
| job | `forfeitedAmount` | overwrite with `forfeiturePaise` for that most recent cancellation occurrence (non-authoritative display projection; not cumulative; `wallet_entries` is sole financial authority; not used for balance reconstruction, idempotency, or future penalties) |
| job | `dispatchLeaseOwner`, `dispatchLeaseUntil`, `dispatchLastFailure` | set `null`; driver cancellation is not a provider failure and the ready job is reclaimable |
| job | `dispatchNextActionAt`, `updatedAt` | transaction server time, making continuation immediately due |
| job | `stateVersion` | increment exactly by one |
| job | `dispatchGeneration`, `dispatchRunId` | preserve exactly; no new generation/run |
| job | `inProgressAt`, `completedAt`, `cancelledAt` | preserve null under the accepted-only guard; do not create terminal job-cancellation history |
| job | booking/pricing/payment/invoice data | preserve exactly |
| job | customer cancellation/refund fields | preserve exactly under the complete guard; if the customer transaction committed first, this driver transaction does not run |
| current offer | `status` | `accepted -> cancelled_driver` |
| current offer | `resolvedAt`, `updatedAt` | transaction server time |
| current offer | `resolutionReason` | exact `driver_cancelled` |
| driver | `activeJobId`, `activeOfferId` | set `null` |
| driver | `updatedAt` | transaction server time |
| driver | wallet/cancellation fields | apply only the accepted offer's immutable cancellation-policy evidence; create/reuse the exact deterministic ledger entry |
| dispatch run | `status` | `assigned -> active` |
| dispatch run | `currentOfferId` | set `null` |
| dispatch run | cancelling candidate `outcome` | `accepted -> driver_cancelled` |
| dispatch run | attempted/excluded evidence | driver remains attempted and is present once in `excludedDriverIds` |
| dispatch run | `generation`, `nextCandidateIndex` | generation unchanged; authoritative `nextCandidateIndex` preserved exactly, never advanced, decremented, or restarted |
| dispatch run | `updatedAt` | transaction server time |
| dispatch run | `finalizedAt` | remains `null` |
| receipt | bound driver-cancel request | complete atomically with domain/wallet changes; different binding under the same `requestId` fails closed |

Historical assignment and financial evidence remains in `job_offers`, the
dispatch candidate record, and permanent `wallet_entries`. No current job field
may point at the former assignment after this transaction.

Customer cancellation precedence is deterministic in both commit orders:

- Customer marker commits first: the driver-cancel guard fails, returns the
  stable non-penalizing customer-cancellation-in-progress result, writes no
  driver-cancel ledger entry, count, strict-mode/ban change, forfeiture,
  redispatch, or provenance overwrite, and the customer resolver completes the
  approved customer-cancellation path with full commission-credit semantics.
- Driver-cancel transaction commits first: the snapshotted driver policy is
  applied atomically and the job returns to `pending_offer` in the same
  generation. A later customer-cancel request observes that new current state
  and follows the already-approved customer-cancellation path.

### Dispatch-run lifecycle

Dispatch-run status is distinct from `jobs.dispatchState`:

```text
active -> assigned -> active       # accepted driver cancels before tow
active -> exhausted                # finite policy genuinely exhausted
active|assigned -> cancelled_customer
assigned -> completed
active -> superseded            # only active (no accepted assignment) can be superseded
```

`active` and `assigned` are nonterminal. `finalizedAt` must be null in both.
`exhausted`, `cancelled_customer`, `completed`, and `superseded` are terminal;
entering one sets `finalizedAt` exactly once. `active -> assigned` changes the
candidate outcome to `accepted` but does not finalize. `assigned -> active`
changes that same candidate to `driver_cancelled`, leaves the generation and
authoritative `nextCandidateIndex` exactly unchanged, retains attempted history, excludes the cancelling UID,
and makes it impossible to offer that UID again in the generation.

## Exact Stage 1 schema contract

Stage 1 updates schema references, seed/config documents, rules, indexes, and
schema/rules tests only. It does not implement dispatch workers or provider
calls.

### `drivers/{driverId}` additions

| Field | Type/default | Writer | Contract |
|---|---|---|---|
| `canFlatbed` | `boolean`, `false` | backend only | Server-approved towing capability |
| `canPulling` | `boolean`, `false` | backend only | Server-approved towing capability |
| `activeJobId` | `string|null`, `null` | backend only | Non-null only while assigned job is `accepted` or `in_progress` |
| `activeOfferId` | `string|null`, `null` | backend only | At most one current offered job |
| `locationUpdatedAt` | `Timestamp|null`, `null` | paired driver location report | Must change to server request time whenever a valid location is reported; the GeoPoint may equal the stored value |

`verificationStatus` remains `pending|approved|rejected`. Drivers may submit
and correct `truckType` and `vehicleNumber` while not approved. Once approved,
changes must go through an audited backend flow that resets verification and
capabilities; an approved driver cannot directly mutate the verified values.

### `dispatch_config/main`

New backend-written, admin-readable configuration document:

| Field | Type/value |
|---|---|
| `version` | positive integer, initial `1` |
| `locationFreshnessSeconds` | positive integer, initial `120` |
| `radiusKmSequence` | numeric array, initial `[10,20,35]` |
| `maxUniqueCandidatesPerGeneration` | positive integer, initial `30` |
| `maxMatrixShortlistPerRound` | positive integer, initial `10` |
| `rankingPrimary` | fixed enum `ola_eta_seconds` |
| `rankingSecondary` | fixed enum `ola_distance_meters` |
| `rankingTieBreak` | fixed enum `driver_uid` |
| `olaFailureMode` | fixed enum `bounded_retry_then_haversine_degraded` |
| `olaMonthlyPairCap` | positive integer or `null`; initial `null` until deployment confirms the account/tier |
| `updatedAt` | timestamp |

An absent/null production pair cap disables Ola calls and selects the explicit
Haversine degraded path; it never disables dispatch or creates no-driver by
itself. This cap is current mutable authorization: before every future Matrix
pair reservation/provider attempt, runtime must re-read it and current counters
transactionally. A dispatch run never snapshots it as authority, and recovery
cannot use an older larger cap. Queue names, regions, provider timeout/retry values, lease durations,
reconciler schedules/batches, budget recipients, and operational TTLs are
validated deployment/runtime configuration rather than invented seed values.

### `jobs/{jobId}` additions

All are backend-only:

| Field | Type/default | Purpose |
|---|---|---|
| `stateVersion` | non-negative integer, `0` | Monotonic Phase 4 transition fence |
| `dispatchGeneration` | non-negative integer, `0` | Current durable search generation |
| `dispatchState` | enum/null, `null` | Internal state defined above; legacy `pending_offer` null is treated as `ready` and materialized |
| `dispatchRunId` | `string|null`, `null` | Current `dispatch_runs` document ID |
| `dispatchLeaseOwner` | `string|null`, `null` | Current worker owner token |
| `dispatchLeaseUntil` | `Timestamp|null`, `null` | Reclaimable lease deadline |
| `dispatchNextActionAt` | `Timestamp|null`, `null` | Indexed retry/reconciliation due time |
| `dispatchLastFailure` | `map|null`, `null` | Safe `{code, source, retryable, occurredAt}` operational reason; no secrets/provider bodies |
| `currentOfferId` | `string|null`, `null` | Current offer/accepted-assignment projection |
| `offeredAt` | `Timestamp|null`, `null` | Current offer start |
| `acceptedAt` | `Timestamp|null`, `null` | Current assignment acceptance |
| `inProgressAt` | `Timestamp|null`, `null` | Tow start |
| `completedAt` | `Timestamp|null`, `null` | Completion |
| `commissionDebitEntryId` | `string|null`, `null` | Current assignment debit ledger identity |
| `cancellationResolutionState` | `none|pending|resolved`, `none` | Durable Phase 3 marker resolution |
| `cancellationResolvedAt` | `Timestamp|null`, `null` | Cancellation consequence completion |
| `cancelledAt` | `Timestamp|null`, `null` | Terminal cancellation time |
| `refundRequestId` | `string|null`, `null` | Deterministic no-driver refund operation |
| `refundState` | `none|pending|in_progress|submitted|confirmed|retry_wait|failed_terminal`, `none` | Job-level refund projection |
| `refundNextAttemptAt` | `Timestamp|null`, `null` | Indexed refund recovery due time |

Existing `offeredTo`, `assignedDriver`, and `offerExpiresAt` remain current-state
guards. Historical attempts and cancelled assignments live in `dispatch_runs`,
`job_offers`, and `wallet_entries`, not overwritten job summary fields.

### `jobs/{jobId}/dispatch_runs/{generationId}`

Backend-only durable run document. `generationId` is a deterministic string for
the job generation.

| Field | Type |
|---|---|
| `jobId` | string |
| `generation` | positive integer |
| `status` | `active|assigned|exhausted|cancelled_customer|completed|superseded`; `active` and `assigned` are nonterminal |
| `policyVersion` | positive integer |
| `policySnapshot` | exact immutable search map: radii, candidate/shortlist caps, freshness and ranking/failure-mode fields; excludes `olaMonthlyPairCap` |
| `candidates` | array of at most 30 candidate maps |
| `nextCandidateIndex` | non-negative integer |
| `attemptedDriverIds` | unique string array, maximum 30 |
| `excludedDriverIds` | unique string array, maximum 30 |
| `currentOfferId` | string/null |
| `createdAt`, `updatedAt` | timestamps |
| `finalizedAt` | timestamp/null; null for `active|assigned`, set once for a terminal run status |

Each candidate map contains `driverId`, `roundIndex`,
`haversineDistanceKm`, nullable `matrixEtaSeconds` and
`matrixDistanceMeters`, `rankingMode` (`ola|haversine_degraded`), `outcome`
(`pending|offered|declined|expired|accepted|driver_cancelled|skipped`), and a
nullable operational `reasonCode`. Candidate UIDs are unique across the array.
The immutable run proves search/exhaustion, not provider-spend authorization.
No cap observed by an old run can authorize a later Ola request.

### `job_offers/{offerId}`

Top-level server-written, target-driver/admin-readable projection:

| Field | Type |
|---|---|
| `jobId`, `driverId` | string |
| `dispatchGeneration`, `candidateIndex`, `roundIndex` | integer |
| `status` | offer enum defined above |
| `offeredAt`, `expiresAt` | timestamp |
| `resolvedAt`, `acceptedAt`, `inProgressAt`, `completedAt` | timestamp/null |
| `resolutionReason` | `declined_by_driver|offer_expired|customer_cancelled|driver_cancelled|superseded|null` |
| `timeoutTaskId` | string/null |
| `timeoutTaskState` | `pending|enqueued|not_required` |
| `acceptRequestId` | string/null |
| `cancellationPolicySnapshot` | map/null; written atomically on acceptance |
| `pickupCoords`, `destCoords` | sanitized `{lat,lng}` maps |
| `requestedTruckType` | `flatbed|pulling` |
| `pickupRoutedDistanceMeters`, `pickupEtaSeconds` | non-negative number/null |
| `estimatedFarePaise`, `driverCommissionPaise` | non-negative safe integer paise |
| `createdAt`, `updatedAt` | timestamp |

The projection excludes `customerPhone`, Razorpay fields, invoice fields,
dispatch leases/errors, refund internals, and unrelated admin metadata.
`acceptRequestId` is the one approved request-ID exception: it exposes only the
target driver's opaque winning acceptance ID, never receipt input hashes,
stored results, or another actor's data. Historical sanitized coordinates stay
readable to that target driver until a separately approved operational
retention policy deletes the offer; Stage 1 assumes no deletion period.

The cancellation snapshot contains `version`, all committed ramp values,
`timezone: Asia/Kolkata`, `roundingMode: HALF_UP`, and `capturedAt`.

### `wallet_entries/{operationId}`

Permanent, immutable, backend-written financial audit record:

Exact deterministic document IDs:

```text
commission_debit:{jobId}:{offerId}
customer_cancel_credit:{jobId}:{offerId}
driver_cancel_credit:{jobId}:{offerId}
```

`offerId` is the immutable accepted-offer document ID — the occurrence identity
of the accepted assignment. The same driver accepting in two separate dispatch
generations for the same job produces distinct ledger IDs; a retry of the same
acceptance occurrence produces the same ID.

Only one document may ever exist for each semantic operation. A retry must
resolve to the same immutable entry; update and delete are forbidden.

| Field | Type |
|---|---|
| `driverId`, `jobId`, `offerId` | string |
| `type` | `commission_debit|customer_cancel_credit|driver_cancel_credit` |
| `commissionPaise` | positive safe integer |
| `forfeiturePaise`, `creditPaise` | non-negative safe integers, present on every type |
| `deltaPaise` | signed safe integer |
| `balanceBeforePaise`, `balanceAfterPaise` | non-negative safe integer |
| `cancellationPolicyEvidence` | complete immutable map for `driver_cancel_credit`, null otherwise |
| `sourceRequestId` | string/null |
| `sourceType` | `driver|customer|system` |
| `actorUid` | authenticated actor UID/null |
| `createdAt` | timestamp |

All money fields are safe integer paise and
`balanceAfterPaise = balanceBeforePaise + deltaPaise`:

| Entry type | Exact arithmetic |
|---|---|
| `commission_debit` | `commissionPaise > 0`; forfeiture and credit are `0`; `deltaPaise = -commissionPaise`; after = before − commission |
| `customer_cancel_credit` | `commissionPaise > 0`; forfeiture `0`; credit = commission; delta = credit; after = before + credit |
| `driver_cancel_credit` | `commissionPaise > 0`; `0 <= forfeiture <= commission`; credit = commission − forfeiture; delta = credit; after = before + credit |

A 100% driver forfeiture still creates the permanent entry with forfeiture =
commission, credit = `0`, and delta = `0`. Its
`cancellationPolicyEvidence` contains exact policy version, timezone,
rounding mode, complete ramp, ban threshold/duration, applicable IST month and
cancellation count, strict-mode inputs/result, forfeiture percentage, and
capture timestamp. Interpretation never depends on mutable config or retained
offer/run documents. Balance mutation and ledger creation are one transaction.
Stage 1 denies driver reads until separate approval; driver writes are always
denied.

### `refund_requests/{jobId}`

One deterministic no-driver refund operation per job:

| Field | Type |
|---|---|
| `jobId`, `razorpayPaymentId` | string |
| `amountPaise` | positive safe integer equal to job `bookingFeePaise` |
| `reason` | fixed `no_driver_found` |
| `providerIdempotencyKey` | required immutable `refund_no_driver_found_{jobId}`; full value matches `^refund_no_driver_found_[A-Za-z0-9_-]+$`; stored before provider contact and identical across retries |
| `providerRequestHash` | required immutable lowercase SHA-256 hex of UTF-8 `JSON.stringify({ paymentId: razorpayPaymentId, amount: bookingFeePaise })`, constructed in that exact key order with no optional fields; here `bookingFeePaise` is the immutable value stored as request `amountPaise` |
| `state` | `pending|in_progress|submitted|confirmed|retry_wait|failed_terminal` |
| `ownerToken` | string/null |
| `leaseUntil`, `nextAttemptAt` | timestamp/null |
| `reconciliationNextAttemptAt` | timestamp/null; due schedule while `submitted` |
| `reconciliationAttempts` | non-negative integer provider-status fetch count |
| `razorpayRefundId` | string/null; required for `submitted|confirmed`, immutable once known |
| `confirmationSource` | `webhook|reconciliation|null`; set exactly once on confirmation |
| `attemptCount` | non-negative integer |
| `lastErrorCode` | string/null; no provider body/secrets |
| `createdAt`, `updatedAt`, `submittedAt`, `confirmedAt` | timestamp/null as applicable |

Eligibility is exact: the job is `cancelled_system`, `cancelledBy == system`,
and `cancellationReason == no_driver_found`. The no-driver domain transaction
creates exactly `refund_requests/{jobId}` and the matching job projection
atomically. Payment ID, amount, reason, provider key, and request hash are
durable before the first external attempt and never change; every retry sends
the identical semantic request/body and request header `X-Refund-Idempotency`
whose value is exactly the stored `providerIdempotencyKey`.

The future provider operation is `POST payments/{razorpayPaymentId}/refund`; its
Razorpay request body is exactly `{ amount: bookingFeePaise }`, where
`bookingFeePaise` is the immutable value stored as request `amountPaise`. Path identity is
documented separately while the canonical hash representation binds both the
stored payment ID and exact amount. No `speed`, `notes`, attempt, worker, reason,
or job field is added to that body or canonical representation. For the locked
test vector `razorpayPaymentId=pay_ABC123` and `amountPaise=10000`, the canonical
string is `{"paymentId":"pay_ABC123","amount":10000}` and the lowercase
SHA-256 hex is
`aa4a95fcf05307d4ea00c64e19d92b2f48e37b9cfd95fed1f6ddc62cd61ee4fb`.

Worker state moves `pending|retry_wait -> in_progress ->
submitted|retry_wait|failed_terminal`. `in_progress` requires a fenced owner
and lease. `submitted` means provider refund identity is known but signed
confirmation is outstanding. A valid matching signed `refund.processed` event
may move any non-confirmed state to `confirmed`, including if it arrives before
worker success persistence; `confirmed` is absorbing and never regresses.

`submitted` is also a durable reconciliation state, not a webhook-only waiting
room. The initiation-success transaction stores `razorpayRefundId` and a
bounded `reconciliationNextAttemptAt`. A due reconciler transactionally claims
the still-submitted request using `ownerToken`/`leaseUntil`, with stale claims
reclaimable, and fetches exactly
`GET payments/{razorpayPaymentId}/refunds/{razorpayRefundId}`. A matching
provider `processed` result confirms the request and job projection in one
transaction with `confirmationSource=reconciliation`. A matching provider `failed`
result (when payment, refund ID, and amount match stored identities) moves request
and job projection transactionally to `failed_terminal`, persists a bounded safe
failure classification in `lastErrorCode`, clears owner/lease, and clears/disables
reconciliation retry schedules (`reconciliationNextAttemptAt=null`, `nextAttemptAt=null`),
while preserving `jobId`, `razorpayPaymentId`, `razorpayRefundId`, `amountPaise`,
`providerIdempotencyKey`, and `providerRequestHash`. `failed_terminal` does not become
confirmed from the fetch that reported failed, does not automatically submit a second
refund, does not reset to pending/submitted through ordinary retry, and requires an
explicit future administrative/manual recovery operation if recovery is needed. However,
a later valid matching signed `refund.processed` webhook for the same exact provider
refund identity still converges `failed_terminal` to `confirmed` with `confirmationSource=webhook`.
A matching `pending` result, provider unavailability, or uncertain fetch keeps `state=submitted`,
increments `reconciliationAttempts`, writes a bounded next reconciliation time
and safe error code as applicable, clears the claim, and never creates or
resubmits a refund. Any payment/refund/amount/operation/reason/job mismatch
fails closed. If provider fetch and signed webhook race, both re-read request
and job transactionally; the first matching path confirms and the other becomes
an identity-validating no-op. `confirmed` clears both retry schedules and never
re-enters initiation or reconciliation.

Stage 9 must extend the existing Phase 3 signed webhook transaction to validate
job/request/payment/amount/refund/reason identity and set both the refund request
and job projection to `confirmed`. It must set the request refund ID and
`confirmedAt`, clear owner/lease/retry fields, and set job `refundState`,
`razorpayRefundId`, `refundConfirmedAt`, `refundedAmountPaise`, and
`refundNextAttemptAt` consistently. Any identity or amount mismatch fails
closed. This repair defines but does not implement that runtime integration.

### `notification_outbox/{eventId}`

eventId is occurrence-safe per event type. `job_accepted` uses
`job_accepted:{jobId}:{offerId}` because an accepted-driver pre-tow
cancellation followed by re-dispatch may produce a second legitimate
`job_accepted` notification for the same job. All other events occur at most
once per job/refund and use `{eventType}:{jobId}`. The Stage 1 event enum is
exactly `job_accepted|job_in_progress|job_completed|job_cancelled_customer|job_cancelled_system|refund_confirmed`;
the resource enum is exactly `job|refund_request`; and the channel is exactly
`whatsapp`. Any expansion requires a separately approved schema/version change.

`recipientKey` is the opaque non-PII reference `customer:{jobId}`, resolved
server-side to the customer's validated WhatsApp contact at send time. It is
never a raw phone number in this document.

`lastErrorCode` must be one of the exact bounded enum values:
`provider_unavailable`, `provider_rate_limited`, `provider_rejected_message`,
`provider_unknown_error`, `recipient_unreachable`, `configuration_missing`,
`internal_error`, or null. Raw provider bodies, stack traces, credentials, or
PII are never stored.

| Field | Type |
|---|---|
| `eventType` | exact enum above |
| `resourceType` | `job|refund_request` |
| `resourceId` | job ID for job events; refund request ID (= job ID) for `refund_confirmed` |
| `channel` | fixed `whatsapp` |
| `recipientKey` | opaque string `customer:{jobId}`; never raw phone |
| `payloadVersion` | fixed `1` |
| `payload` | exact map `{ jobId, jobStatus, refundAmountPaise }` |
| `state` | `pending|in_progress|sent|retry_wait|failed_terminal` |
| `ownerToken` | string/null |
| `leaseUntil`, `nextAttemptAt`, `sentAt` | timestamp/null |
| `attemptCount` | non-negative integer |
| `providerMessageId` | string/null |
| `lastErrorCode` | exact bounded enum (see above) or null |
| `createdAt`, `updatedAt` | timestamp |

For job events, `resourceType=job`, `resourceId=payload.jobId`, job status maps
exactly to the event suffix (`accepted`, `in_progress`, `completed`,
`cancelled_customer`, or `cancelled_system`), and `refundAmountPaise=null`.
For `refund_confirmed`, `resourceType=refund_request`,
`resourceId=payload.jobId`, `jobStatus=cancelled_system`, and
`refundAmountPaise` is the positive safe integer confirmed refund amount.
`recipientKey` is a validated backend contact reference. The payload contains no
customer phone, coordinates, driver identity, payment/provider identifier, raw
provider response, credential, or secret. External delivery remains
at-least-once; provider acceptance is not proof of recipient delivery.

### `processed_requests/{id}` additions

Existing Phase 3 records remain valid. Phase 4 client mutations additionally
bind `actorUid`, `operation`, `resourceId`, `payloadHash`, and `result` to the
request ID. Financial/domain completion is written in the same transaction as
the job/wallet mutation; a generic owner lease alone is insufficient.

### `pricing_config/main.cancellation_policy` additions

Add `version: 1`, `timezone: Asia/Kolkata`, and `roundingMode: HALF_UP` to the
existing Firestore-sourced policy. Any future change to a financial ramp value
must increment `version`. Acceptance snapshots the complete policy.

### `usage_counters/{YYYY-MM}` replacement fields

| Field | Type |
|---|---|
| `olaMapsMatrixRequests` | non-negative integer |
| `olaMapsMatrixPairs` | non-negative integer |
| `whatsappTemplateSends` | non-negative integer |
| `softCapWhatsapp` | non-negative integer; existing messaging guardrail retained |
| `updatedAt` | timestamp |

`olaMapsMatrixCalls` and `softCapOlaMaps` become legacy migration fields and
must not authorize production usage. The shared counter transaction reads the
deployment cap, checks overflow, and increments requests plus planned pairs
before the provider attempt. Uncertain attempts are not decremented.

## Exact Stage 1 Firestore rules changes

1. Update the access-model comment to match callable-only sensitive writes.
2. `drivers/{driverId}`:
   - retain owner/admin read;
   - retain owner create with the positive allow-list;
   - remove `|| isAdmin()` from direct update;
   - never allow client create/update of `canFlatbed`, `canPulling`,
     `activeJobId`, `activeOfferId`, wallet, verification, ban, strict-mode, or
     monthly-cancellation fields;
   - permit direct `truckType` and `vehicleNumber` correction only while the
     stored verification state is absent, `pending`, or `rejected`; an approved
     driver must use an audited backend flow that resets verification and
     capabilities;
   - every driver update must also set `updatedAt == request.time`;
   - permit a valid location report when the GeoPoint changes or remains equal
     to the stored value, but require `locationUpdatedAt` to change to
     `request.time`; deny location change without it, arbitrary timestamp,
     deletion/null, and malformed location;
   - continue allowing `isOnDuty` even while banned; eligibility enforces the ban.
3. `jobs/{jobId}`:
   - admin read only;
   - remove offered/assigned-driver whole-document read;
   - all client writes denied.
4. `job_offers/{offerId}`:
   - admin read;
   - authenticated driver read only when `resource.data.driverId == request.auth.uid`;
   - all client writes denied;
   - driver list queries must include the matching `driverId` constraint.
5. `jobs/{jobId}/dispatch_runs/{generationId}`: admin read only; client writes denied.
6. `wallet_entries/{operationId}`: admin read only for Stage 1; all client writes denied. Owner read remains disabled pending separate approval.
7. `refund_requests`, `notification_outbox`, `processed_requests`, and
   `usage_counters`: all driver/client access denied; admin read may be allowed
   for operations, writes remain denied.
8. `dispatch_config/{document}`: authenticated admin read; all client writes denied.
9. `pricing_config` remains authenticated read and client-write denied.
10. Keep the catch-all deny.

Backend Admin SDK bypasses rules, so every callable/worker must independently
validate auth, role, types, state, and idempotency.

## Exact Stage 1 index contract

Retain existing Phase 1–3 indexes that support admin/history views. Add:

### Driver candidate queries

Two capability-specific composite indexes, each ordered as:

```text
verificationStatus ASC
isOnDuty ASC
canFlatbed ASC             # use canPulling in the second index
activeJobId ASC
activeOfferId ASC
walletBalance ASC
```

The query uses equality on approval/duty/capability/null engagement and a
job-specific lower bound on `walletBalance`. `bannedUntil`, location validity,
freshness, Haversine radius, and final wallet validity are rechecked in backend
code. Raw Firestore GeoPoint is not treated as a radius query.

### Job recovery queries

```text
status ASC, dispatchState ASC, dispatchNextActionAt ASC
status ASC, dispatchState ASC, dispatchLeaseUntil ASC
status ASC, offerExpiresAt ASC
cancellationResolutionState ASC, cancellationRequestedAt ASC
refundState ASC, refundNextAttemptAt ASC
```

### Offer feed/recovery

```text
driverId ASC, status ASC, offeredAt DESC
status ASC, expiresAt ASC
jobId ASC, dispatchGeneration ASC, candidateIndex ASC
```

### Wallet/refund/outbox operations

```text
wallet_entries: driverId ASC, createdAt DESC
wallet_entries: jobId ASC, createdAt ASC
refund_requests: state ASC, nextAttemptAt ASC
refund_requests: state ASC, reconciliationNextAttemptAt ASC
refund_requests: state ASC, leaseUntil ASC
notification_outbox: state ASC, nextAttemptAt ASC
notification_outbox: state ASC, leaseUntil ASC
```

Direct document-ID lookups for `processed_requests`, `usage_counters`, and a
specific dispatch run need no composite index.

`tests/phase4/schema/indexQueryContract.json` is the exact Stage 1 query/index
fixture. It names each query purpose, equality/range/order shape, the five
trusted baseline composites, all approved Phase 4 composites, and direct-ID or
built-in single-field paths. Tests compare the entire production index file to
that fixture, not a subset. The Firestore Emulator validates rules/query shape
but cannot prove that production composite indexes have been deployed.

## Stage 1 implementation and test plan

Stage 1 is intentionally limited to data contracts and security boundaries.

### 1. Schema/config references

Expected changes:

- update `firebase/seed/drivers_schema.json` and `jobs_schema.json`;
- add schema references for `dispatch_runs`, `job_offers`, `wallet_entries`,
  `refund_requests`, `notification_outbox`, and extended Phase 4 request receipts;
- add `dispatch_config/main` seed/reference;
- add cancellation-policy version/timezone/rounding fields;
- replace authoritative Ola call-cap seed fields with request/pair counters and
  an intentionally unconfigured pair cap;
- update `docs/data_model.md` to exactly match.

Gate: all JSON parses; exact key/field/enum/default/type/ownership/conditional
consistency tests pass; driver-visible offers equal the complete approved
allowlist; legacy Phase 3 job documents remain valid. Stage 2 backlog bootstrap
must first discover `status == pending_offer` without ordering on a new field,
because an ordered query omits legacy documents where that field is absent,
then transactionally initialize only safe operational defaults.

### 2. Rules

Implement the rules contract above without dispatch code.

Gate: Firestore Rules Emulator tests prove:

- unauthenticated access is denied;
- a driver cannot read full jobs or another driver’s offer;
- a driver can query/read only their own sanitized offers;
- job/offer/wallet/ledger/refund/workflow writes are denied to clients;
- capability/engagement/wallet/verification/ban fields cannot be created or
  changed by a driver;
- direct admin writes to drivers/config/financial state are denied;
- every location report supplies a valid GeoPoint (which may equal the stored
  point) and refreshes `locationUpdatedAt` to server request time; a changed
  point without that timestamp, arbitrary/deleted timestamp, or malformed
  point is denied;
- permitted owner profile/duty/location writes still work;
- admins retain the approved read access.

### 3. Indexes

Add the exact indexes above, preserving existing Phase 1–3 indexes unless a
query audit proves one redundant.

Gate: index JSON parses, contains no duplicate definitions, and a query-shape
fixture maps every Phase 4 planned query to an index or direct-ID lookup.

### 4. Validation and regression

- Add pure schema/config consistency tests under `tests/phase4/schema/`.
- Add rules emulator tests under `tests/phase4/emulator/`.
- Run `git diff --check`.
- Run the existing Phase 3 unit/fixture suite and Firestore Emulator suite.
- Run the Phase 2 regression.
- Confirm no dispatch/provider/wallet production code or dependencies entered
  the Stage 1 diff.

No external provider calls, Cloud Task creation, deployment, data deletion, or
production migration occurs in Stage 1.

## Remaining deployment gates, not Stage 1 blockers

- Ola account/tier and monthly pair/cost cap.
- Exact Ola retry/timeout/backoff values.
- Cloud Tasks queue, region, retry/rate configuration, worker lease durations,
  reconciler cadence and batch sizes.
- GCP budget amount and recipients.
- Operational-record retention periods.
- Wallet top-up implementation and production validation.
- Admin/support runbook for exceptional in-progress driver failures.

## Stage 3 Recovery Checkpoint Contract

Stage 3 offer timeout and enqueue recovery guarantees deterministic, bounded, fair
progress across worker restarts without starvation or live-lock under continuous arrivals.

1. Persistent checkpoint lives at `dispatch_config/recovery_checkpoints`:
   - Strict validation: exact keys at root, sweep, and tuple levels; authoritative Firestore Timestamps (exact seconds/nanoseconds); non-empty legal document IDs without slashes; null-pair consistency (`(ts, id)` or `(null, null)`).
   - `dueOfferSweep`: tracks Category A due offer timeouts with `sweepEpoch` (`1 <= sweepEpoch <= Number.MAX_SAFE_INTEGER`), `cursor: {offerExpiresAt, jobId}`, and `upperBound: {offerExpiresAt, jobId}`.
   - `pendingEnqueueSweep`: tracks Category B pending task enqueues with `sweepEpoch` (`1 <= sweepEpoch <= Number.MAX_SAFE_INTEGER`), `cursor: {expiresAt, offerId}`, and `upperBound: {expiresAt, offerId}`.
2. High-water mark candidate acquisition:
   - Evaluated atomically at sweep start when `upperBound` is null.
   - Backed by production composite DESC indexes:
     - Category A: `jobs (status ASC, offerExpiresAt DESC)`
     - Category B: `job_offers (status ASC, expiresAt DESC)`
   - High-water candidate validation strictly requires authoritative Firestore Timestamps and legal document IDs; malformed ordering candidates are skipped and never enter checkpoint state.
3. UpperBound Immutability & Exact Sub-millisecond Ordering:
   - The acquired `upperBound` tuple is locked for the entire epoch. Mid-sweep cursor advancements never overwrite `upperBound`.
   - Tuple comparison uses exact Firestore Timestamp ordering (seconds, then nanoseconds) and deterministic document-ID ordinal comparison without lossy millisecond truncation or locale dependencies.
   - Any new continuous arrivals with keys greater than `upperBound` wait until the subsequent epoch.
4. Forward Scanner Malformed Record Defense:
   - Category B forward scan starts at `startAt(new Timestamp(0, 0))` when cursor is null, skipping non-Timestamp prefixes (e.g. `expiresAt: 0`).
   - Any malformed records returned consume forward-scanned budget, fail closed with zero domain mutations, and are never set as cursor.
   - Healthy records behind malformed records progress deterministically.
5. Epoch + Upper-Bound Fencing:
   - Checkpoint updates and sweep completions CAS-fence against both worker-observed `sweepEpoch` and exact `upperBound` tuple.
   - Stale workers from prior epochs or divergent bounds fail closed without mutating state or regressing cursors.
6. Hard Scanned-Doc Budget:
   - Invocations enforce strict scan budgets (`maxDueScannedPerInvocation`, `maxPendingScannedPerInvocation`) bounding total forward-scanned domain records.
   - Already-enqueued or non-matching records consume the scan budget and advance the cursor, preventing infinite worker loops on dense spans.
7. Finite Sweep Completion, Wrap & Epoch Boundary:
   - When the scanner reaches or passes `upperBound`, the sweep atomically completes: `sweepEpoch` increments by 1 (guarded against overflow at `MAX_SAFE_INTEGER`), and cursor and `upperBound` reset to null.
   - Loader accepts `1 <= sweepEpoch <= Number.MAX_SAFE_INTEGER`.
   - Transient failures skipped during sweep $N$ are revisited in sweep $N+1$.

## Stage 0+1 targeted-repair status

The decision lock and Stage 1 schema/rules/index/test artifacts incorporate the
seven independent-audit repairs and are ready for independent re-audit. This is
not authorization to begin Phase 4 runtime work or enable paid live traffic.
