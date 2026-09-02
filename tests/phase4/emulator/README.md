# Phase 4 Stage 1 Firestore rules tests

These dependency-free Node tests exercise `firebase/firestore.rules` against a
real Firestore Emulator. They use the emulator's `Bearer owner` Admin-SDK
bypass only to seed fixtures and prove backend writes; all client assertions
use Firebase-shaped emulator JWTs and the public Firestore REST API.

The suite deletes all documents in its isolated emulator project before
seeding and also uses a unique suffix per process, so a second execution cannot
turn a create assertion into an update assertion. Never point this test at a
production Firestore host or project.

On this development host, this is a reproducible dependency-free launch from
the repository root (PowerShell, first terminal):

```powershell
& 'C:\Program Files\Java\jdk-25\bin\java.exe' `
  -jar "$env:USERPROFILE\.cache\firebase\emulators\cloud-firestore-emulator-v1.22.0.jar" `
  --host 127.0.0.1 --port 8085 --rules firebase/firestore.rules `
  --project_id towing-phase4-rules
```

Then run in a second PowerShell terminal:

```powershell
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8085'
$env:GCLOUD_PROJECT = 'towing-phase4-rules'
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" `
  --test tests/phase4/emulator/firestoreRules.emulator.test.js
```

The suite intentionally requires an emulator. It does not substitute a rules
mock or static text assertion. The emulator verifies rules and query shape; it
does not prove that composite indexes have been deployed in production. The
exact production index/query contract is independently checked by
`tests/phase4/schema/indexQueryContract.json`.
