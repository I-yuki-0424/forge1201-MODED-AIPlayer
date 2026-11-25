'use strict';
// The ntrace logs of a fake_trace run (DIR/fake_meta.json, DIR/ntrace/<tag>.txt) -> tests/golden_native/srv_<case>.jsonl in the shared trace format
// (src/native/trace.js): the world lines describe the arena exactly (air but the case's blocks), the tick lines carry the server's state after each tick.
//   node scripts/native/fake_convert.js DIR VERSION
const fs = require('fs');
const path = require('path');
const trace = require('../../src/native/trace');
const { CASES } = require('./fake_cases');

const [dir, version] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(dir, 'fake_meta.json'), 'utf8'));
const registry = require('prismarine-registry')(version);
const Block = require('prismarine-block')(registry);
const sidOf = (st) => {
    const m = /^([a-z0-9_]+)(?:\[(.*)\])?$/.exec(st), b = registry.blocksByName[m[1]];
    const want = Object.fromEntries((m[2] || '').split(',').filter(Boolean).map((kv) => kv.split('=')));
    const full = { ...Block.fromStateId(b.defaultState, 0).getProperties(), ...want };
    for (let id = b.minStateId; id <= b.maxStateId; id++) { const p = Block.fromStateId(id, 0).getProperties(); if (Object.entries(full).every(([k, v]) => String(p[k]) === String(v))) return id; }
    throw new Error(`no state ${st}`);
};
const RAD = Math.PI / 180;
const MIN_Y = 192, HEIGHT = 32;
for (const c of meta.cases) {
    const file = path.join(dir, 'ntrace', `${c.tag}.txt`);
    if (!fs.existsSync(file)) { console.log('no log for', c.name); continue; }
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => l.trim().split(/\s+/));
    const spec = CASES.find((x) => x.name === c.name), O = c.origin;
    // the arena: air, the case's blocks, the barrier under an in-air start (gone at tick 0: a blk line)
    const cells = new Map(), put = (x, y, z, s) => cells.set(`${x},${y},${z}`, s);
    for (const [x0, y0, z0, x1, y1, z1, st] of spec.blocks) { const s = sidOf(st); for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) put(O.x + x, O.y + y, O.z + z, s); }
    if (c.inAir) put(c.feet.x, c.feet.y - 1, c.feet.z, sidOf('barrier'));
    const out = [{ t: 'hello', format: trace.FORMAT, recorder: 'scripts/native/fake_trace.js: carpet fake player (the server\'s own player physics), scarpet ntrace', bot: c.name, version, minY: MIN_Y, height: HEIGHT, dim: 'overworld', difficulty: null, gameMode: 'survival', world: meta.world, run: meta.run, speed: 1, ms: 0 }];
    const named = new Set(), air = sidOf('air');
    const name = (s) => { if (named.has(s)) return; named.add(s); out.push({ t: 'st', id: s, n: registry.blocksByStateId[s].name, p: Block.fromStateId(s, 0).getProperties() }); };
    name(air);
    for (let cx = (O.x - 16) >> 4; cx <= (O.x + 16) >> 4; cx++) for (let cz = (O.z - 16) >> 4; cz <= (O.z + 16) >> 4; cz++) {
        const u = new Uint16Array(16 * 16 * HEIGHT).fill(air);
        for (let y = MIN_Y; y < MIN_Y + HEIGHT; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) { const s = cells.get(`${cx * 16 + x},${y},${cz * 16 + z}`); if (s !== undefined) { u[((y - MIN_Y) * 16 + z) * 16 + x] = s; name(s); } }
        out.push({ t: 'chunk', ms: 0, tick: 0, cx, cz, minY: MIN_Y, height: HEIGHT, enc: 'u16le-deflate-b64', cells: trace.encodeCells(u) });
    }
    if (c.inAir) out.push({ t: 'blk', ms: 0, tick: 0, p: [c.feet.x, c.feet.y - 1, c.feet.z], s: air });
    // keys per tick from the program; log row k = the state after tick k - 1 (row 0 = the start)
    const keysAt = (t) => { let k = '.......'; for (const [pt, ks] of c.program) if (pt <= t) k = ks; return k + '..'; };
    const yaw = Math.PI - c.yaw * RAD, pitch = -c.pitch * RAD;
    for (const r of rows) {
        const k = Number(r[0]), v = r.slice(1, 7).map(Number), ground = Number(r[7]);
        out.push({ t: 'tick', ms: 50 * k, tick: k, row: [k, 'srv', k === 0 ? '.........' : keysAt(k - 1), v[0], v[1], v[2], v[3], v[4], v[5], yaw, pitch, ground, 0] });
    }
    const dest = path.join(__dirname, '../../tests/golden_native', `srv_${c.name}.jsonl`);
    fs.writeFileSync(dest, trace.lines(out));
    console.log(c.name, rows.length, 'ticks ->', path.basename(dest));
}
