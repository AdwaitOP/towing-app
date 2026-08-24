# Towing Dispatch System

A towing dispatch platform connecting customers with tow-truck
drivers.

## Project Documentation

- towing_dispatch_spec_v9.md — Product and technical specification
- BUILD_PHASES.md — Implementation roadmap

## Tech Stack

- Flutter
- Node.js
- Firebase
- WhatsApp Cloud API
- Razorpay

## Development

See BUILD_PHASES.md for the current implementation phase.

## Local Emulator Setup (Phase 1+)

Prerequisites: [Firebase CLI](https://firebase.google.com/docs/cli) (`npm install -g firebase-tools`), Node.js 22.

```bash
# 1. Connect to your Firebase project (one-time, not committed to Git)
cd firebase
firebase use --add

# 2. Install Cloud Functions dependencies
cd functions
npm install
cd ..

# 3. Copy and fill in secrets for local development
cp functions/.env.example functions/.env
# Edit functions/.env with your API keys

# 4. Start the emulator suite (run from inside the firebase/ directory)
firebase emulators:start

# Emulator ports (see firebase/firebase.json):
#   Auth:      http://localhost:9099
#   Firestore: http://localhost:8080
#   Functions: http://localhost:5001
#   Storage:   http://localhost:9199
#   UI:        http://localhost:4000
```

### Seed data

`firebase/seed/` contains JSON reference documents for initial Firestore data:

| File | Firestore target |
|---|---|
| `pricing_config.json` | `pricing_config/main` |
| `business_config.json` | `business_config/main` |
| `usage_counters_template.json` | `usage_counters/{YYYY-MM}` (monthly) |
| `drivers_schema.json` | Schema reference — not a live document |
| `jobs_schema.json` | Schema reference — not a live document |

To load seed data into the emulator, create the documents manually via the Emulator UI at `http://localhost:4000` or write a one-time seed script using the Firebase Admin SDK pointed at the emulator.

### Documentation

- `towing_dispatch_spec_v9.md` — Authoritative product and technical specification
- `BUILD_PHASES.md` — Implementation roadmap (do not modify)
- `docs/data_model.md` — Firestore collections and Storage paths quick reference