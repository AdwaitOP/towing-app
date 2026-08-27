# Phase 3 Firestore emulator tests

These tests are intentionally separate from the in-memory unit suite. They
exercise actual Firestore optimistic transaction conflicts and retries for
processed-request fencing, session ownership, immutable job creation, Payment
Link provisioning, invoice numbering, OTP consumption, and CANCEL/PAYMENT
reconciliation.

Prerequisites:

1. From `firebase/functions/`, install exactly the locked dependencies with
   `npm ci` (do not resolve new versions).
2. From `firebase/`, start only Firestore against the isolated project:
   `firebase emulators:start --only firestore --project towing-phase3-emulator`.
3. In a second shell at the repository root, expose the functions-local
   dependencies because the test file lives outside that package, set the
   emulator variables, and run the suite.

PowerShell:

```powershell
$env:NODE_PATH = (Resolve-Path firebase/functions/node_modules).Path
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
$env:GCLOUD_PROJECT = 'towing-phase3-emulator'
node tests/phase3/emulator/firestoreConcurrency.emulator.js
```

POSIX shell:

```sh
NODE_PATH="$PWD/firebase/functions/node_modules" \
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
GCLOUD_PROJECT=towing-phase3-emulator \
node tests/phase3/emulator/firestoreConcurrency.emulator.js
```

The runner fails if the emulator environment is absent. It contains no skipped
or todo tests.
