'use strict';
// Movement and command traces (TASK-20261125-076; the format is shared with TASK-20261125-078's simulator parity, docs/proposed/NATIVE-v1.md "Trace format").
// A trace is JSON Lines: one header, then one line per event in tick order.
//
//   {"format":"forgeaip-trace","v":1,"mc":"1.21.1","dataVersion":3955,"source":"carpet-fake-player"|"bot"|"generated:<how>","player":"Nm7",
//    "region":{"min":[x,y,z],"size":[sx,sy,sz],"palette":["minecraft:stone","minecraft:oak_slab[type=bottom,waterlogged=false]"],"cells":[0,0,1,...]},
//    "start":{"pos":[x,y,z],"vel":[x,y,z],"yaw":deg,"pitch":deg,"onGround":true,"pose":"standing","fallDistance":0},
//    "player_state":{"attr":{"movementSpeed":0.1,...},"food":20,"effects":{...},"feet":"leather_boots"|null}}
//   {"k":"t","t":0,"in":{"keys":"F...S.."} | {"imp":{"xxa":0,"zza":1,"jumping":false,"sneak":false,"sprinting":true}},"yaw":deg,"pitch":deg,
//    "pos":[x,y,z],"vel":[x,y,z],"onGround":bool}                   the state AFTER the tick (pos/vel as the source saw them)
//   {"k":"e","t":5,"type":"block","pos":[x,y,z],"state":"minecraft:air"}                                 a world change before tick 5
//   {"k":"e","t":9,"type":"velocity","vel":[x,y,z]} | {"type":"teleport","pos":[x,y,z]} | {"type":"attr", ...} | {"type":"effect", ...}
//   {"k":"c","t":0,"name":"mine","args":{...},"end":42,"result":{"ok":true,"reason":null},"outcome":{...}}   a command and its server-observed outcome (078)
//
// Region cells: x fastest, then z, then y (as Litematica), indexes into `palette` (block states in the game's own syntax). Keys: the 7 movement keys as
// in src/skills/runner.js' keyBits ('FBLRJSN', '.' = up). `imp` holds the impulses BEFORE LivingEntity.aiStep's x0.98.
const Vec3 = require('vec3');

const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];

function parse(text) {
    const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l, i) => { try { return JSON.parse(l); } catch (e) { throw new Error(`trace line ${i + 1}: ${e.message}`); } });
    const [header, ...rest] = lines;
    validateHeader(header);
    let last = -1;
    for (const r of rest) {
        if (!['t', 'e', 'c'].includes(r.k)) throw new Error(`trace: unknown line kind ${JSON.stringify(r.k)}`);
        if (!Number.isInteger(r.t) || r.t < 0) throw new Error('trace: every line needs a tick number t >= 0');
        if (r.t < last) throw new Error(`trace: lines out of tick order at t=${r.t}`);
        last = r.t;
        if (r.k === 't' && !(Array.isArray(r.pos) && r.pos.length === 3)) throw new Error(`trace: tick ${r.t} has no pos`);
    }
    return { header, ticks: rest.filter((r) => r.k === 't'), events: rest.filter((r) => r.k === 'e'), commands: rest.filter((r) => r.k === 'c') };
}

function validateHeader(h) {
    if (!h || h.format !== 'forgeaip-trace' || h.v !== 1) throw new Error('trace: header must have format "forgeaip-trace" and v 1');
    if (typeof h.mc !== 'string' || !Number.isInteger(h.dataVersion)) throw new Error('trace: header needs mc and dataVersion');
    const r = h.region;
    if (!r || !Array.isArray(r.min) || !Array.isArray(r.size) || !Array.isArray(r.palette) || !Array.isArray(r.cells)) throw new Error('trace: header needs region {min, size, palette, cells}');
    if (r.cells.length !== r.size[0] * r.size[1] * r.size[2]) throw new Error(`trace: region has ${r.cells.length} cells for size ${r.size.join('x')}`);
    if (r.cells.some((c) => !Number.isInteger(c) || c < 0 || c >= r.palette.length)) throw new Error('trace: region cell outside the palette');
    if (!h.start || !Array.isArray(h.start.pos)) throw new Error('trace: header needs start.pos');
}

/** "minecraft:oak_slab[type=bottom]" -> { name, props } */
function parseState(s) {
    const m = /^([a-z0-9_.-]+:)?([a-z0-9_/.-]+)(?:\[(.*)\])?$/.exec(String(s));
    if (!m) throw new Error(`trace: bad block state ${s}`);
    const props = {};
    if (m[3]) for (const kv of m[3].split(',')) { const [k, v] = kv.split('='); props[k.trim()] = String(v).trim(); }
    return { name: m[2], props };
}

/** The region as a world for the physics (prismarine interface), with the trace's block events applied as they come (`apply(t)`). Outside the region: air. */
function regionWorld(header, registry) {
    const Block = require('prismarine-block')(registry);
    const sidOf = new Map();
    const sid = (state) => {
        if (sidOf.has(state)) return sidOf.get(state);
        const { name, props } = parseState(state);
        const b = registry.blocksByName[name];
        if (!b) throw new Error(`trace: block ${name} is not in ${registry.version.minecraftVersion}`);
        let id = b.defaultState;
        if (Object.keys(props).length) {
            id = null;
            for (let i = b.minStateId; i <= b.maxStateId && id === null; i++) { const p = Block.fromStateId(i, 0).getProperties(); if (Object.entries(props).every(([k, v]) => String(p[k]) === v)) id = i; }
            if (id === null) throw new Error(`trace: no state ${state}`);
        }
        sidOf.set(state, id);
        return id;
    };
    const r = header.region, [sx, sy, sz] = r.size, [ox, oy, oz] = r.min;
    const pal = r.palette.map(sid), cells = new Map(), air = sid('minecraft:air');
    const key = (x, y, z) => `${x},${y},${z}`;
    for (let y = 0, i = 0; y < sy; y++) for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++, i++) cells.set(key(ox + x, oy + y, oz + z), pal[r.cells[i]]);
    return {
        getBlock(p) {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const b = Block.fromStateId(cells.has(key(x, y, z)) ? cells.get(key(x, y, z)) : air, 0);
            b.position = new Vec3(x, y, z);
            return b;
        },
        set(pos, state) { cells.set(key(pos[0], pos[1], pos[2]), sid(state)); },
    };
}

const keysOf = (s) => Object.fromEntries(KEYS.map((k, i) => [k, typeof s === 'string' ? s[i] !== '.' && s[i] !== undefined : !!(s && s[k])]));

/**
 * Replay the trace's inputs through the native physics (`Physics` of src/native/physics) over its region, tick by tick, and compare each tick's position
 * (and velocity where the trace has one). Returns { ticks, worst: {t, dpos, dvel}, firstOff: tick where |dpos| > tol (or null), rows }.
 */
function replay(trace, { tol = 1e-5, registry } = {}) {
    const { Physics } = require('./physics');
    const { fresh } = require('./physics/player');
    const reg = registry || require('prismarine-registry')(trace.header.mc);
    const w = regionWorld(trace.header, reg), ph = Physics(reg);
    const st = trace.header.start, ps = trace.header.player_state || {};
    const s = fresh({ x: st.pos[0], y: st.pos[1], z: st.pos[2], vx: (st.vel || [0, 0, 0])[0], vy: (st.vel || [0, 0, 0])[1], vz: (st.vel || [0, 0, 0])[2],
        yaw: st.yaw || 0, pitch: st.pitch || 0, onGround: !!st.onGround, pose: st.pose || 'standing', fallDistance: st.fallDistance || 0, food: ps.food ?? 20, walksOnPowderSnow: ps.feet === 'leather_boots' });
    Object.assign(s.attr, ps.attr || {});
    Object.assign(s.effects, ps.effects || {});
    const ev = [...trace.events];
    const rows = [];
    let worst = { t: -1, dpos: 0, dvel: 0 }, firstOff = null;
    for (const tk of trace.ticks) {
        while (ev.length && ev[0].t <= tk.t) {
            const e = ev.shift();
            if (e.type === 'block') w.set(e.pos, e.state);
            else if (e.type === 'velocity') { [s.vx, s.vy, s.vz] = e.vel; }
            else if (e.type === 'teleport') { [s.x, s.y, s.z] = e.pos; }
            else if (e.type === 'attr') Object.assign(s.attr, e.attr || {});
            else if (e.type === 'effect') Object.assign(s.effects, e.effects || {});
        }
        if (tk.yaw !== undefined) s.yaw = tk.yaw;
        if (tk.pitch !== undefined) s.pitch = tk.pitch;
        if (tk.in && tk.in.imp) s.imp = tk.in.imp; else { s.imp = null; s.keys = keysOf(tk.in && tk.in.keys); }
        ph.step(s, w);
        const dpos = Math.hypot(s.x - tk.pos[0], s.y - tk.pos[1], s.z - tk.pos[2]);
        const dvel = Array.isArray(tk.vel) ? Math.hypot(s.vx - tk.vel[0], s.vy - tk.vel[1], s.vz - tk.vel[2]) : 0;
        rows.push({ t: tk.t, pos: [s.x, s.y, s.z], dpos, dvel, onGround: s.onGround });
        if (dpos > worst.dpos) worst = { t: tk.t, dpos, dvel };
        if (firstOff === null && dpos > tol) firstOff = tk.t;
    }
    return { ticks: rows.length, worst, firstOff, rows };
}

/** Write a trace (header + lines) as JSON Lines. */
const format = (header, lines) => [header, ...lines].map((l) => JSON.stringify(l)).join('\n') + '\n';

module.exports = { parse, validateHeader, parseState, regionWorld, replay, format, keysOf, KEYS };
