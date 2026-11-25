'use strict';
// npm test: runs every file listed in tests/suite.txt in its own node process, in order, and fails if any fails.
// One file per line keeps concurrent additions from colliding (the list used to be one long `&&` line in package.json).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = fs.readFileSync(path.join(__dirname, 'suite.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
const only = process.argv.slice(2);
const failed = [];
for (const f of only.length ? files.filter((x) => only.some((o) => x.includes(o))) : files) {
  const r = spawnSync(process.execPath, [f], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) failed.push(`${f} (exit ${r.status ?? r.signal})`);
}
if (failed.length) { console.error(`\nFAILED ${failed.length}:\n  ${failed.join('\n  ')}`); process.exit(1); }
console.log(`\nall ${files.length} test files passed`);
