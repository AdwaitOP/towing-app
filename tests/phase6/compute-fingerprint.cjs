const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const candidateFiles = [
  'admin_panel/package.json',
  'admin_panel/src/App.tsx',
  'admin_panel/src/types/operations.ts',
  'admin_panel/src/services/driverVerification.ts',
  'admin_panel/src/services/liveJobs.ts',
  'admin_panel/src/services/operationsSession.ts',
  'admin_panel/src/services/__tests__/liveJobs.test.ts',
  'admin_panel/src/services/__tests__/operationsSession.test.ts',
  'admin_panel/src/hooks/useVerificationQueue.ts',
  'admin_panel/src/hooks/useLiveJobs.ts',
  'admin_panel/src/pages/DriverVerificationQueuePage.tsx',
  'admin_panel/src/pages/LiveJobsPage.tsx',
  'admin_panel/src/components/verification/EvidenceViewer.tsx',
  'admin_panel/src/components/verification/VerificationDetail.tsx',
  'admin_panel/src/components/verification/VerificationDecisionDialog.tsx',
  'admin_panel/src/components/verification/__tests__/VerificationDecisionDialog.test.tsx',
  'admin_panel/src/components/jobs/JobDetail.tsx',
  'firebase/functions/src/index.js',
  'firebase/functions/src/admin/adminAuthorization.js',
  'firebase/functions/src/admin/approveDriver.js',
  'firebase/functions/src/admin/rejectDriver.js',
  'firebase/functions/src/admin/driverVerificationDecision.js',
  'admin_panel/scripts/m2-operations-browser.mjs',
  'admin_panel/scripts/seed-m2-emulator.mjs'
];

const results = [];
const overallHash = crypto.createHash('sha256');

for (const rel of candidateFiles) {
  const full = path.resolve(rel);
  if (fs.existsSync(full)) {
    const buf = fs.readFileSync(full);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    results.push({ file: rel, sha256: hash });
    overallHash.update(`${rel}:${hash}\n`);
  } else {
    results.push({ file: rel, missing: true });
  }
}

const candidateFingerprint = overallHash.digest('hex');
console.log(JSON.stringify({ candidateFingerprint, files: results }, null, 2));
