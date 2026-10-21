const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXPECTED_PROJECT_ID = 'demo-towmitra-admin';
const project = process.argv[2] || process.env.GCLOUD_PROJECT || EXPECTED_PROJECT_ID;

if (project !== EXPECTED_PROJECT_ID) {
  console.error(`\x1b[31m[FATAL] Target project ID "${project}" is not permitted. Must strictly be "${EXPECTED_PROJECT_ID}". Live/production mode is forbidden.\x1b[0m`);
  process.exit(1);
}

function assertLoopbackHost(hostStr, varName) {
  if (!hostStr) return;
  let hostname = hostStr;
  try {
    if (hostStr.includes('://')) {
      const parsed = new URL(hostStr);
      hostname = parsed.hostname;
    } else if (hostStr.startsWith('[')) {
      const endBracket = hostStr.indexOf(']');
      hostname = endBracket !== -1 ? hostStr.slice(1, endBracket) : hostStr;
    } else if (hostStr.includes(':')) {
      hostname = hostStr.split(':')[0];
    }
  } catch {
    console.error(`\x1b[31m[FATAL] Invalid host format "${hostStr}" in ${varName}.\x1b[0m`);
    process.exit(1);
  }
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    console.error(`\x1b[31m[FATAL] Non-loopback host "${hostStr}" detected in ${varName}. Only loopback ("127.0.0.1" or "localhost") is permitted.\x1b[0m`);
    process.exit(1);
  }
}

// Validate environment variables
const hostEnvVars = [
  'FIREBASE_AUTH_EMULATOR_HOST',
  'FIRESTORE_EMULATOR_HOST',
  'FIREBASE_STORAGE_EMULATOR_HOST',
  'FIREBASE_EMULATOR_HUB',
  'FUNCTIONS_EMULATOR_HOST',
  'FIREBASE_DATABASE_EMULATOR_HOST',
  'HOST'
];
for (const v of hostEnvVars) {
  if (process.env[v]) {
    assertLoopbackHost(process.env[v], v);
  }
}

const harnessDir = path.join(__dirname, 'emulator-harness');

// Validate harnessDir firebase.json emulator config
try {
  const cfgPath = path.join(harnessDir, 'firebase.json');
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.emulators) {
      for (const [svc, conf] of Object.entries(cfg.emulators)) {
        if (conf && conf.host) {
          assertLoopbackHost(conf.host, `firebase.json emulators.${svc}.host`);
        }
      }
    }
  }
} catch (err) {
  console.error(`\x1b[31m[FATAL] Failed to validate emulator harness config: ${err.message}\x1b[0m`);
  process.exit(1);
}

function resolveFirebaseBin() {
  try {
    return require.resolve('firebase-tools/lib/bin/firebase.js');
  } catch {}
  if (process.env.APPDATA) {
    const globalPath = path.join(process.env.APPDATA, 'npm/node_modules/firebase-tools/lib/bin/firebase.js');
    if (fs.existsSync(globalPath)) {
      return globalPath;
    }
  }
  return 'firebase';
}

const firebaseBin = resolveFirebaseBin();

const isJsBin = firebaseBin.endsWith('.js');
const executable = isJsBin ? process.execPath : firebaseBin;
const args = isJsBin
  ? [firebaseBin, 'emulators:start', '--config', path.join(harnessDir, 'firebase.json'), '--project', project]
  : ['emulators:start', '--config', path.join(harnessDir, 'firebase.json'), '--project', project];

const log = fs.createWriteStream(path.join(__dirname, 'emulator-harness.log'));
log.write(JSON.stringify({ executable, args, cwd: harnessDir }) + '\n');

const p = spawn(executable, args, {
  cwd: harnessDir,
  windowsHide: true,
  env: {
    ...process.env,
    GCLOUD_PROJECT: project,
    NODE_OPTIONS: '--dns-result-order=ipv4first',
    METADATA_SERVER_DETECTION: 'none',
    FIREBASE_CLI_DISABLE_UPDATE_CHECK: 'true'
  }
});

p.stdout.pipe(log);
p.stdout.pipe(process.stdout);
p.stderr.pipe(log);
p.stderr.pipe(process.stderr);

fs.writeFileSync(path.join(__dirname, 'emulator-pid.json'), JSON.stringify({ pid: p.pid }));

p.on('exit', (code, signal) => {
  log.end(JSON.stringify({ code, signal }));
  console.log('Emulator harness exited:', JSON.stringify({ code, signal }));
});
