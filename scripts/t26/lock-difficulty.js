// node scripts/t26/lock-difficulty.js LEVEL_DAT [--check]   sets Data.DifficultyLocked = 1 in a stopped world's level.dat (gzip NBT); --check prints locked|unlocked.
// Used by scripts/t26/survival.sh: a dedicated server has no server.properties key for the lock (owner 2026-11-27: survival "locked to Hard").
'use strict';
const fs = require('fs'), zlib = require('zlib'), nbt = require('prismarine-nbt');
const [file, flag] = process.argv.slice(2);
const parsed = nbt.parseUncompressed(zlib.gunzipSync(fs.readFileSync(file)), 'big');
const data = parsed.value.Data && parsed.value.Data.value;
if (!data) { console.error('no Data compound in ' + file); process.exit(2); }
const locked = data.DifficultyLocked && data.DifficultyLocked.value === 1;
if (flag === '--check') { console.log(locked ? 'locked' : 'unlocked'); process.exit(0); }
if (locked) process.exit(0);
data.DifficultyLocked = { type: 'byte', value: 1 };
const out = zlib.gzipSync(nbt.writeUncompressed(parsed, 'big'));
fs.writeFileSync(file + '.tmp', out); fs.renameSync(file + '.tmp', file);
console.log('locked ' + file);
