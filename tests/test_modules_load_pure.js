'use strict';
// Every module of the builder and the work console's service loads (a file that does not parse took the three consoles down for half an hour, 2026-11-22; the unit tests had not loaded it).
const fs = require('fs'), path = require('path');
let n = 0;
for (const dir of ['src/build', 'src/work/service', 'src/work/jobs', 'src/rl']) {
    for (const f of fs.readdirSync(path.join(__dirname, '..', dir))) if (f.endsWith('.js')) { require(path.join(__dirname, '..', dir, f)); n++; }
}
console.log(`test_modules_load_pure: ${n} modules loaded`);
