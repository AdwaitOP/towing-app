const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pidFile = path.join(__dirname, 'emulator-pid.json');
if (!fs.existsSync(pidFile)) {
  console.log('No emulator-pid.json found.');
  process.exit(0);
}

const record = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
if (!Number.isSafeInteger(record.pid) || record.pid < 1) {
  throw new Error('Invalid recorded PID');
}

try {
  const result = execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(record.pid), '/T', '/F'], {
    encoding: 'utf8',
    windowsHide: true
  });
  console.log('Terminated emulator PID:', record.pid, result.trim());
} catch (e) {
  console.log('Process already stopped or error:', e.message);
}

try {
  fs.unlinkSync(pidFile);
} catch {}
