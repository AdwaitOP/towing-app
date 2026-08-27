'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repositoryRoot = path.resolve(__dirname, '..');
const testRoot = path.join(repositoryRoot, 'tests', 'phase3');
const tests = findTests(testRoot);
if (tests.length === 0) throw new Error('No Phase 3 tests were found');

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: repositoryRoot,
  stdio: 'inherit',
});
process.exitCode = result.status ?? 1;

function findTests(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? findTests(fullPath) : [fullPath];
    })
    .filter(file => file.endsWith('.test.js'))
    .sort();
}
