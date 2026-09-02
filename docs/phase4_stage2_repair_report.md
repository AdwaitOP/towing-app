# Phase 4 Stage 2 blocker repair report

Date: 2026-09-02. Target: the existing unstaged Stage 2 implementation on
`ed46f452acd89620d623210d7d252d4b3d1d8965`. All work remains unstaged.

## A. Repair mapping to findings 1–15

| Finding | Repair | Verification |
|---|---|---|
| 1. Zero-invocation recovery | Exported Firestore consumer plus scheduled status-only, paginated backlog reconciliation; payment boundary only materializes workflow fields. | Paid webhook commits without dispatch acceleration; a fresh consumer discovers the legacy job and publishes. Due retries and pagination past holds are exercised. |
| 2. Run storage | `jobs/{jobId}/dispatch_runs/{String(generation)}`; initial generation ID is `1`; `jobs.dispatchRunId` stores that ID. | Concurrent semantic triggers produce exactly one nested run and offer; top-level collection remains empty. |
| 3. Lease authority | Every claimed-worker transaction checks owner and `dispatchLeaseUntil > now` after reads, including usage reservation. Time is recomputed on transaction callback retries. | Separate before-reclaim and after-reclaim publication tests; run creation, selecting, skip, exhaustion, failure persistence, and HTTP retry reservation fences. |
| 4. Legacy bootstrap | Only missing Phase 4 workflow defaults are added; the committed null/not_started workflow state becomes ready. Historical markers are never reset. | Concurrent claim preserves paid/pricing/invoice evidence; cancellation/refund contradictions reject bootstrap and preserve the complete document. |
| 5. Job validation | Strict coordinates, truck category, integer-paise money, payment identity/timestamp, pricing, assignment, dispatch, cancellation and refund guards. | Invalid-value unit cases and real concurrent changes to assignment, money and current-offer pointers cannot publish. |
| 6. Publication eligibility | Driver is reread inside publication; checks duty, approval, both capability types and required capability, ban, exact null engagement, wallet, GeoPoint, freshness and future timestamps. | Real mutations after selection revoke publication. Driver contention yields one active offer. |
| 7. Customer cancellation | All cancellation provenance must be null and resolution must be none; current status is reread. | Customer marker and terminal customer cancellation each win against continuing dispatch without run/refund/offer writes. |
| 8. Exhaustion/refund intent | Complete finite list is persisted only after all rounds succeed. Terminal transaction validates policy, identity, cursor, resolved history, authority and cancellation, then creates the refund intent and job/run terminal projections together. | Empty finite search atomically produces exact refund schema; corrupt cursor/history and conflicting refund intent cannot terminally cancel. |
| 9. Config | All committed critical fields and relationships validated; maxima are 30 candidates and 10 per shortlist. Null cap selects Haversine; malformed config holds. | Invalid config matrix and null-cap offer test; invalid configuration never creates no-driver. |
| 10. Current cap | Counter transaction reads current config and current monthly counter; caller cap is ignored. | Cap 5 rejects 10 pairs despite previously observed caller cap 100. |
| 11. Retry accounting | Authorization callback runs before each HTTP attempt; automatic redirects are disabled. | 429, 500, success yields 3 requests/30 pairs; lowered cap and expired lease prevent further HTTP calls. |
| 12. Counter integrity | Existing required fields must be valid nonnegative safe integers; only an absent document receives defaults; arithmetic checks overflow. | Concurrent near-cap reservations, negative/nonnumeric/fractional/unsafe/missing counters and overflow cases. Corruption remains unchanged. |
| 13. Failure classes | Only timeout, enumerated transient network failures, 429 and 5xx retry; only exhausted approved retries or explicit cap denial allow degraded routing. | Credentials, local errors, 400/401/403, authorization and counter errors fail closed. Transient Firestore failures enter durable retry_wait. |
| 14. Matrix validation | Strict rows/elements/dimensions/order, successful statuses and finite nonnegative metrics; malformed JSON and unexpected success responses reject. | ZERO_RESULTS, missing/short/extra dimensions, null/NaN/Infinity/negative/string metrics and malformed bodies. |
| 15. Offer identity | SHA-256 of UTF-8 `JSON.stringify([jobId, driverId, generation])`, prefixed `offer_`. | The `a_b/c/1` and `a/b_c/1` collision pair produces distinct real offer documents; identical tuples are deterministic. |

## B. Durable zero-invocation recovery architecture

`index.js` exports `dispatchPendingJob` (`onDocumentWritten`, jobs path, retry
enabled) and `reconcilePendingDispatch` (`onSchedule`). The former accelerates
entry into pending_offer/ready and ignores its own claim/selecting writes. The
latter repeatedly queries only `where('status', '==', 'pending_offer')`, with a
page limit and the implicit document-ID cursor. It does not order or filter on
Phase 4 fields. It scans past holds, future retries and active leases, recovering
missing workflow fields, due retry_wait and expired claims through the same
transactional worker. No correctness state resides in process memory.

Individual database failures do not prevent processing the rest of a page;
the scheduled invocation reports failure after the scan, and future scheduled
invocations retry. Aggregate fixed reason codes make invalid/held jobs visible
without recording arbitrary errors or customer information.

Required deployment values are documented in `firebase/functions/.env.example`:
`DISPATCH_RECONCILE_SCHEDULE`, `DISPATCH_RECONCILE_BATCH_SIZE`,
`DISPATCH_LEASE_MS`, `DISPATCH_RETRY_DELAY_MS`, `OLA_MATRIX_TIMEOUT_MS`,
`OLA_MATRIX_MAX_RETRIES`, and `OLA_MATRIX_BACKOFF_MS`. The Ola key is bound only
to the dispatch functions. No deployable schedule or production timing values
were invented; missing settings fail closed. Library defaults support direct
service use and tests, while production consumers require explicit settings.

## C. Nested dispatch-run implementation

Run references use the job subcollection and the decimal generation string.
Stage 2 creates generation 1 once, with a create precondition and the job pointer
in the same transaction. It resumes an existing current generation and never
replaces a missing, conflicting or malformed referenced run with a new search.
Policy snapshots exclude the mutable Ola cap. No rules/schema/index changes
were made to accommodate runtime paths.

## D. Lease-expiry fencing evidence

Real emulator tests pause a worker after run creation, expire its lease, then
resume publication both without reclamation and after worker B has published.
The stale worker changes neither job nor run. Additional tests cover expiry
before selecting, during ranking/run creation, before skip or exhaustion,
before failure persistence, during Firestore callback retry, and before an Ola
retry reservation. Fresh tokens are required to reclaim expired authority.

## E. Legacy bootstrap preservation evidence

The successful concurrent bootstrap test compares every original field except
the mutable updatedAt against its prior value, including pricing, payment IDs,
confirmation, invoice number/path/date/timestamps/message identity and legacy
display evidence. Separate cancellation/refund marker tests compare the entire
document before and after rejected bootstrap/claim. Contradictory history is
preserved for operations; it is not made dispatchable by clearing markers.

## F. Job validation evidence

Validation checks safe nonnegative integer paise, exact coordinate maps and
ranges, canonical requested category, valid pricing/distance/channel/contact,
confirmed payment ID and Payment Link identity, timestamps, null current
assignment/offer guards, valid workflow enums/leases/generation binding,
monotonic version capacity, structured failure metadata, and absence of winning
cancellation/refund evidence. Validation repeats in claimed-worker transactions.
Invoice generation remains independent, so a paid job need not await an invoice
before dispatch. Existing invoice values are preserved.

## G. Final publication eligibility evidence

The transaction rereads job, nested run, current config, driver and deterministic
offer document. It validates the exact current cursor and candidate, active run,
generation binding and cancellation fence before atomically creating the offer
and updating job, driver and run. GeoPoint type, location freshness, future
timestamps, moved-outside-round location, ban, wallet, capability and engagement
checks execute against the reread driver. All 26 sanitized offer fields and the
45-second lifetime are unchanged; runtime options cannot override the lifetime.

## H. Customer cancellation precedence evidence

The emulator covers a customer marker before publication, a marker alone while
pending_offer before exhaustion, and cancelled_customer before exhaustion.
Dispatch changes no customer provenance, offers, runs or refunds in those
losing paths. No penalty, driver-cancel or driver-redispatch runtime was added.

## I. Exhaustion and atomic refund intent

The terminal transaction requires an unexpired owner, dispatchable current job,
valid current config, matching active run, exact cursor equal to candidate count,
and terminal non-accepted candidate outcomes with consistent attempted/excluded
history. Query/ranking failures cannot persist a partial candidate list.

The same commit creates `refund_requests/{jobId}`, sets pending refund job
projections, and finalizes the run with system/no_driver_found cancellation.
The intent stores the exact booking fee, immutable payment identity,
`refund_no_driver_found_{jobId}`, and lowercase SHA-256 canonical payment/amount
hash, plus all required initial worker/reconciliation fields. Invalid provider
job-ID alphabet, zero refundable amount or an existing conflicting refund intent
fails closed. No Razorpay refund request or reconciliation worker is implemented.

## J. Config and null-cap behavior

Config requires positive safe-integer version, freshness and candidate limits;
strictly increasing nonempty positive finite radii; shortlist <= candidate cap;
candidate cap <= 30 and shortlist <= 10; exact ranking/failure enums; a real
updatedAt timestamp; and a null or positive safe-integer Ola cap. Null permits
Haversine offers with no Ola call. Missing/malformed config enters operational
hold and cannot justify no-driver cancellation.

## K. Current-cap authorization evidence

Every reservation reads `dispatch_config/main` and `usage_counters/{YYYY-MM}`
within the transaction that increments usage. Dispatch-originated reservations
also reread and fence the job lease. Cap is not accepted as caller authority or
stored in the run snapshot. Two near-cap callers cannot spend the same budget.

## L. Per-HTTP-attempt accounting

Each outbound fetch is preceded by one reservation of one request and exact
origin-count times destination-count pairs. Retries each reserve again. The
emulator verifies 3 HTTP attempts consume 3 requests and 30 pairs. Cap reduction
after attempt 1 prevents attempt 2 and permits Haversine; an expired dispatch
lease prevents further reservation and stops the worker. Uncertain attempts
are not decremented. Redirects cannot hide additional unaccounted HTTP calls.

## M. Counter corruption and overflow

Existing request, pair, WhatsApp-send and WhatsApp-cap fields must all be
nonnegative safe integers with a valid update timestamp. Missing fields are
not zero defaults. Request increment and pair addition explicitly reject
overflow before writes. Absent monthly documents use only the approved seed
defaults. All corruption tests assert the persisted counter is unchanged.

## N. Provider and response validation

Provider transient retries are bounded. Authentication/configuration/local
failures, malformed responses and counter/authorization failures hold rather
than silently degrading. Retryable Firestore failures use retry_wait and its
real scheduled consumer. Persisted failure maps contain only fixed bounded
code/source, retryable boolean and timestamp.

Matrix response tests require exact dimensions and successful element statuses;
ZERO_RESULTS cannot become a routed candidate through numeric-looking metrics.
Tests use controlled HTTP responses, not live Ola traffic. The request endpoint
matches the [official Ola Matrix documentation](https://maps.olakrutrim.com/docs/routing-apis/distance-matrix-api).

## O. Collision-safe identity and existing offer safety

Offer IDs encode a canonical semantic tuple through SHA-256. Underscores remain
valid in both IDs. Publication uses transaction.create, never an unconditional
set. A completed duplicate trigger is a no-op with its existing offer/run/driver
projections preserved. An existing offer under an inconsistent pending-job
projection, even with the same tuple, is an integrity conflict rather than
permission to overwrite or resurrect it.

## P. Retry durability and Phase 3 boundary behavior

The paid webhook implementation and all Phase 3 tests remain unchanged. Payment
commits before the boundary, which only attempts safe workflow materialization
and returns a deferred result on infrastructure failure. It does not search,
rank, call Ola or publish. The existing invoice failure/retry semantics remain;
invoice failure cannot roll back payment. The missed handoff converges via the
scheduled consumer. Holds require an explicit administrative/config recovery
transition to ready; retry_wait is automatically rediscovered when due.

## Q. New real-emulator evidence

The final suite has 71 tests, using the real Admin SDK and Firestore Emulator.
Transaction barriers delay entry to actual transactions; they do not replace
Firestore locking, reads, commits or retry semantics. All requested concurrency,
recovery, lease, cancellation, quota, corruption, identity and atomic-refund
cases are represented. The unchanged rules suite separately verifies the nested
run client-access boundary. Export registration and recovery handler behavior
are tested; Cloud Scheduler/Eventarc deployment and live timer delivery are not
claimed as tested.

## R. Full regression results

Runtime: Node **v24.19.0**; Java **25**, build **25+37-LTS-3491**;
Firestore Emulator **1.22.0**. The package's declared production Node engine
remains **22**; this report states the actual locally used runtime.

| Suite/check | Passed | Failed | Skipped | Todo |
|---|---:|---:|---:|---:|
| Stage 2 unit | 116 | 0 | 0 | 0 |
| Stage 2 real Firestore Emulator | 71 | 0 | 0 | 0 |
| Stage 0+1 schema/config, unchanged | 13 | 0 | 0 | 0 |
| Phase 4 rules, clean run 1 | 18 | 0 | 0 | 0 |
| Phase 4 rules, fresh emulator process run 2 | 18 | 0 | 0 | 0 |
| Phase 3 unit, unchanged | 123 | 0 | 0 | 0 |
| Phase 3 Firestore concurrency, unchanged | 7 | 0 | 0 | 0 |
| Phase 2 fare assertions, unchanged | 49 | 0 | 0 | 0 |
| **Total tests/assertions** | **415** | **0** | **0** | **0** |
| Recursive JS syntax (repository files, dependencies excluded) | 58 | 0 | 0 | 0 |
| Recursive JSON parsing (repository files, dependencies excluded) | 18 | 0 | 0 | 0 |

`git diff --check` and `git diff --cached --check` both pass. The fare script
reports 49 actual assertions; its source contains no skips or todos. Node test
suites report zero cancelled tests as well. Rules run 1 used a new emulator
process on 8096; run 2 used another fresh process on 8097 with isolated projects.

Reproduction from the repository root (PowerShell, after starting an isolated
Firestore Emulator with the committed rules):

```powershell
$repairNode = 'C:/Users/adwai/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$env:NODE_PATH = (Resolve-Path firebase/functions/node_modules).Path
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8096'
& $repairNode --test tests/phase4/dispatch/*.test.js tests/phase4/services/*.test.js
& $repairNode --test tests/phase4/emulator/dispatchConcurrency.emulator.test.js
& $repairNode --test tests/phase4/schema/stage1Schemas.test.js
# Set a distinct GCLOUD_PROJECT for each rules run and Phase 3 emulator run.
& $repairNode --test tests/phase4/emulator/firestoreRules.emulator.test.js
& $repairNode scripts/testPhase3.js
& $repairNode tests/phase3/emulator/firestoreConcurrency.emulator.js
& $repairNode scripts/testFare.js
```

## S. Exact Git state

- Branch: `main`, aligned with `origin/main`.
- HEAD/main/origin/main: `ed46f452acd89620d623210d7d252d4b3d1d8965`.
- Nothing staged; cached diff empty. No commit, push, stash mutation or reset.
- `stash@{0}`: `7c4b8222928411cf9c952a01243ce2226e2af02c`,
  `On main: Phase 4 Stage 2 before Sol repair`.
- `stash@{1}`: `c2941dbf72e63af7cb4ab6ec2a531a46d8b7829e`,
  `On main: Phase 3 Gemini WIP before Codex audit`.
- `BUILD_PHASES_SIMPLE.md` remains preexisting/untracked, untouched; SHA-256
  `83C3B461D1AA696182BB9C75D8BE33823C37848D0AEE8FF6B51590E54CD6B65D`.
- Protected committed ADR, BUILD_PHASES.md, seeds, rules, indexes, schema tests,
  Phase 3 tests and fare regression source have zero diff against the baseline.
- Tracked diff comprises `.env.example`, `index.js`, `dispatchBoundary.js`, and
  the preexisting additive `date.js` change. Stage 2 source/tests and this report
  remain untracked. Ordinary `git diff --stat` omits those untracked files.
- No unrelated edits or later-stage accept/timeout/decline/lifecycle/penalty,
  refund-provider/reconciliation, or notification-provider implementation.

## T. Remaining genuine commit blockers

None identified by the completed repair and regression checks. Independent
final Stage 2 audit remains the requested next review. Production deployment
settings, real provider/account configuration, deployed indexes, wallet top-up,
and the later offer/refund/lifecycle stages remain existing deployment gates;
this repair does not enable paid live traffic or claim production deployment.

## U. Final verdict

READY FOR FINAL STAGE 2 AUDIT
