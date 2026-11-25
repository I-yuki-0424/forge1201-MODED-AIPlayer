'use strict';
// Tick-level movement traces for the native physics (TASK-20261125-076) in the trace format TASK-20261125-078 put on main (docs/implemented/SIM-PARITY-v1.md
// section 5, writer scripts/sim/record.js, format 1): one JSONL file per player, lines told apart by `t`. The world lines are 078's:
//   {"t":"hello","format":1,"recorder":..,"bot":..,"version":"1.21.1","minY":..,"height":..,"dim":..,...,"ms":..}
//   {"t":"st","id":<state id of that version>,"n":<block name>,"p":{properties}}
//   {"t":"chunk","ms":..,"tick":..,"cx":..,"cz":..,"minY":..,"height":..,"enc":"u16le-deflate-b64","cells":..}   index ((y - minY) * 16 + z) * 16 + x
//   {"t":"blk","ms":..,"tick":..,"p":[x,y,z],"s":<state id>}
// and this task adds the `tick` line (proposed in that section; documented in docs/proposed/NATIVE-v1.md "Trace format"):
//   {"t":"tick","ms":..,"tick":n,"row":[t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, slot]}
// `row` has the shape of the runner's per-tick rows (src/skills/runner.js): keys 'FBLRJSNAU' ('.' = up, then Q / X), yaw / pitch in mineflayer's radians,
// onGround 0/1. Unlike the runner's rows (state BEFORE the tick, rounded to 1e-3), a `tick` line holds the state AFTER the physics tick that ran with
// `keys`, unrounded. The first `tick` line is the start state (its keys are not replayed); fall distance 0, standing pose and no sprint are assumed there,
// so a trace starts from a body standing still or in free fall from rest.
const zlib = require('zlib');
const Vec3 = require('vec3');

const FORMAT = 1;
const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
const RAD = 180 / Math.PI;

function parse(text) {
    const out = { hello: null, states: new Map(), chunks: [], blks: [], ticks: [] };
    String(text).split('\n').forEach((l, i) => {
        if (!l.trim()) return;
        let o; try { o = JSON.parse(l); } catch (e) { throw new Error(`trace line ${i + 1}: ${e.message}`); }
        if (o.t === 'hello') { if (out.hello) return; if (o.format !== FORMAT) throw new Error(`trace: format ${o.format}, this reader knows ${FORMAT}`); out.hello = o; }
        else if (o.t === 'st') out.states.set(o.id, { n: o.n, p: o.p || {} });
        else if (o.t === 'chunk') { if (o.enc !== 'u16le-deflate-b64') throw new Error(`trace: chunk encoding ${o.enc}`); out.chunks.push(o); }
        else if (o.t === 'blk') out.blks.push(o);
        else if (o.t === 'tick') { if (!Array.isArray(o.row) || o.row.length < 12) throw new Error(`trace line ${i + 1}: a tick row has 13 fields`); out.ticks.push(o); }
        // cmd / res / spawn / death: the command-level lines of 078, not needed for movement
    });
    if (!out.hello) throw new Error('trace: no hello line');
    if (!out.hello.version) throw new Error('trace: hello has no version');
    return out;
}

const decodeCells = (c) => new Uint16Array(new Uint8Array(zlib.inflateSync(Buffer.from(c.cells, 'base64'))).buffer);
const encodeCells = (u16) => zlib.deflateSync(Buffer.from(u16.buffer, u16.byteOffset, u16.byteLength), { level: 1 }).toString('base64');

/**
 * The traced world for the physics (prismarine interface: getBlock(Vec3) -> Block, null outside the recorded chunks), with block updates applied up to
 * a tick by `until(tick)`. State ids are checked against the `st` names (a trace of another version or registry is refused, not misread).
 */
function traceWorld(tr, registry) {
    const Block = require('prismarine-block')(registry);
    for (const [id, s] of tr.states) {
        const b = registry.blocksByStateId[id];
        if (s.n && (!b || b.name !== s.n)) throw new Error(`trace: state ${id} is ${s.n} in the trace but ${b ? b.name : 'unknown'} in ${registry.version.minecraftVersion}`);
    }
    const cols = new Map(), over = new Map();
    for (const c of tr.chunks) cols.set(`${c.cx},${c.cz}`, { minY: c.minY, height: c.height, cells: decodeCells(c) });
    const blks = [...tr.blks];
    const sidAt = (x, y, z) => {
        const k = `${x},${y},${z}`;
        if (over.has(k)) return over.get(k);
        const c = cols.get(`${x >> 4},${z >> 4}`);
        if (!c || y < c.minY || y >= c.minY + c.height) return null;
        return c.cells[((y - c.minY) * 16 + (z & 15)) * 16 + (x & 15)];
    };
    return {
        getBlock(p) {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z), s = sidAt(x, y, z);
            if (s === null) return null;
            const b = Block.fromStateId(s, 0); b.position = new Vec3(x, y, z); return b;
        },
        until(tick) { while (blks.length && blks[0].tick <= tick) { const e = blks.shift(); over.set(e.p.join(','), e.s); } },
    };
}

const keysOf = (s) => Object.fromEntries(KEYS.map((k, i) => [k, typeof s === 'string' && s[i] !== undefined && s[i] !== '.']));

/**
 * Replay the trace's keys through the native physics over its world and compare every tick's position (and velocity) with the trace.
 * Returns { ticks, worst: {tick, dpos, dvel}, firstOff (tick whose position is off by more than `tol`, or null), rows }.
 */
function replay(tr, { tol = 1e-5, registry } = {}) {
    const { Physics } = require('./physics');
    const { fresh } = require('./physics/player');
    const reg = registry || require('prismarine-registry')(tr.hello.version);
    const w = traceWorld(tr, reg), ph = Physics(reg);
    if (tr.ticks.length < 2) return { ticks: 0, worst: { tick: -1, dpos: 0, dvel: 0 }, firstOff: null, rows: [] };
    const r0 = tr.ticks[0].row;
    const s = fresh({ x: r0[3], y: r0[4], z: r0[5], vx: r0[6], vy: r0[7], vz: r0[8], onGround: !!r0[11], minY: tr.hello.minY ?? -64, food: 20 });
    const rows = [];
    let worst = { tick: -1, dpos: 0, dvel: 0 }, firstOff = null;
    for (const tk of tr.ticks.slice(1)) {
        const r = tk.row;
        w.until(tk.tick);
        s.yaw = Math.fround((Math.PI - r[9]) * RAD); s.pitch = Math.fround(-r[10] * RAD);
        s.keys = keysOf(r[2]);
        ph.step(s, w);
        const dpos = Math.hypot(s.x - r[3], s.y - r[4], s.z - r[5]), dvel = Math.hypot(s.vx - r[6], s.vy - r[7], s.vz - r[8]);
        rows.push({ tick: tk.tick, pos: [s.x, s.y, s.z], dpos, dvel, onGround: s.onGround });
        if (dpos > worst.dpos) worst = { tick: tk.tick, dpos, dvel };
        if (firstOff === null && dpos > tol) firstOff = tk.tick;
    }
    return { ticks: rows.length, worst, firstOff, rows };
}

const lines = (objs) => objs.map((o) => JSON.stringify(o)).join('\n') + '\n';

module.exports = { FORMAT, KEYS, parse, traceWorld, replay, keysOf, decodeCells, encodeCells, lines };
