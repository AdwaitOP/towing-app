# TowMitra Admin Panel (Phase 6 M1)

Navi Mumbai Towing Operations & Dispatch Management Console.

## Prerequisites & Runtime Environment

- **Node.js**: Requires Node.js `>=22.13` (independently verified on Node.js `24.19.0 LTS`), matching engine requirements of locked dependencies (Puppeteer `>=22.12`, ESLint `^20.19 || ^22.13 || >=24`).
- **Package Manager**: `npm` `>=10.x`.
- **Firebase Emulator Suite**: Required. Never connects to production Firebase.
  - Project ID: strictly `demo-towmitra-admin`.
  - Auth Emulator: `127.0.0.1:9099`
  - Firestore Emulator: `127.0.0.1:8080`
  - Functions Emulator: `127.0.0.1:5001`
  - Storage Emulator: `127.0.0.1:9199`
  - Functions Region: `asia-south1`

## Setup & Installation

From within the `admin_panel/` directory:

```bash
# 1. Environment configuration
cp .env.example .env.local

# 2. Clean lockfile installation
npm ci

# 3. Verify typecheck and linting
npm run typecheck
npm run lint

# 4. Production build
npm run build

# 5. Local development server
npm run dev
# Dashboard served at http://127.0.0.1:5173
```

## Running Local Emulators

Start the required Firebase emulators using the repository configuration:

From repository root:
```bash
# Export loopback environment
export FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_STORAGE_EMULATOR_HOST=127.0.0.1:9199
export GCLOUD_PROJECT=demo-towmitra-admin

# Start emulators referencing repository configuration explicitly:
firebase emulators:start --config firebase/firebase.json --only auth,firestore,storage --project demo-towmitra-admin
```

Alternatively, from the `firebase/` directory:
```bash
cd firebase
firebase emulators:start --only auth,firestore,storage --project demo-towmitra-admin
```

## Local Synthetic Bootstrap & Claim Tooling

Initialize synthetic development users and server proof document:

```bash
# Bootstrap synthetic admin and operator accounts
npm run bootstrap

# Controlled claim mutation fixture (strict boolean true|false)
npm run set-claims -- --email admin@towmitra.test --admin true
npm run set-claims -- --email operator@towmitra.test --admin false
```

Synthetic accounts created:
- `admin@towmitra.test` / `AdminPassword123!` (claims: `admin: true`)
- `operator@towmitra.test` / `OperatorPassword123!` (claims: `admin: false`)

## Running Tests

```bash
# Run unit & component tests (Vitest)
npm test

# Run Firestore security rules integration test against emulator
npm run test:rules

# Run end-to-end browser smoke test (Puppeteer)
npm run test:smoke
```

## Security Invariants

1. **Fail-Closed Boundary**: The application strictly rejects non-loopback emulator endpoints and any Firebase project other than `demo-towmitra-admin`.
2. **Server-Authoritative Authorization**: In addition to client-side custom token claims (`admin === true`), administrative access requires server-authoritative read proof of `dispatch_config/main`.
3. **Content Security Policy**: Outbound network requests are restricted to `'self'` and local loopback emulators (`127.0.0.1:*`, `localhost:*`). External telemetry, images, and services are strictly blocked.
4. **Session Intent Fencing**: Stale asynchronous login callbacks are fenced against subsequent logout actions to prevent delayed authorization regressions.
