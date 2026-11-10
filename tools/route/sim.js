'use strict';
// Training and evaluation simulator of the chunk-exit router (docs/implemented/ROUTE-v1.md). A height-field world with the obstacles the live bots meet (ridges with one gap, U-shaped
// traps, steep-banked lakes, canyons with one bridge, a deep pit with a haul road), the REAL path calculator (src/skills/planner.js, the budget the work layer gives it: 6000 cells, five
// re-plans after a partial path, exactly motion.js's walk loop) and the bot's own view limit (chunks within 4 of its chunk are known, the rest `unknown`). Nothing here is read by the bots.
const { plan } = require('../../src/skills/planner');
const { standable } = require('../../src/skills/world');

const PLAN_NODES = 6000, MAX_REPLANS = 5, VIEW = 4, SEA = 62;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const hash = (x, z, s) => { let h = Math.imul(x, 374761393) ^ Math.imul(z, 668265263) ^ Math.imul(s, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
function noise(x, z, scale, s) {
    const gx = Math.floor(x / scale), gz = Math.floor(z / scale), fx = x / scale - gx, fz = z / scale - gz, sm = (t) => t * t * (3 - 2 * t);
    const a = hash(gx, gz, s), b = hash(gx + 1, gz, s), c = hash(gx, gz + 1, s), d = hash(gx + 1, gz + 1, s), u = sm(fx), v = sm(fz);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const KINDS = ['open', 'ridge', 'ushape', 'lake', 'canyon', 'cliff', 'pit'];

/** A scenario: {H(u, v) height of the column in the local frame, start, target, kind}. Local frame: the target lies along +u. */
function scenario(seed, kind) {
    const r = rng(seed), D = 50 + Math.floor(r() * 200), hills = (u, v) => 64 + Math.round((noise(u, v, 26, seed) - 0.5) * 8 + (noise(u, v, 9, seed + 1) - 0.5) * 3);
    const feat = []; let start = { u: 0, v: 0 }, target = { u: D, v: Math.round((r() - 0.5) * 30) }, H = hills;
    const gap = (r() < 0.5 ? -1 : 1) * (15 + Math.floor(r() * 55));
    if (kind === 'ridge') {                                                           // a wall across the way with one gap of 4 blocks; the bot has to go along it
        const u0 = Math.floor(D * (0.3 + r() * 0.3)), w = 4, h = 36;
        H = (u, v) => (u >= u0 && u < u0 + w && !(v >= gap && v < gap + 4) && Math.abs(v) < 130 ? 64 + h : hills(u, v));
    } else if (kind === 'ushape') {                                                   // the start sits in a U that opens away from the target
        const arm = 25 + Math.floor(r() * 40), half = 12 + Math.floor(r() * 10), h = 36;
        H = (u, v) => { const inU = (u >= -arm && u <= 4 && Math.abs(v) <= half + 3) && (u >= 0 || Math.abs(v) >= half); return inU && !(u < 0 && Math.abs(v) < half) ? 64 + h : (u >= 0 && u <= 3 && Math.abs(v) <= half + 3 ? 64 + h : hills(u, v)); };
        start = { u: -Math.floor(arm / 2), v: 0 };
    } else if (kind === 'lake') {                                                     // a lake with steep banks (an 8-block drop into the water: it can be entered, not left)
        const cu = Math.floor(D * (0.4 + r() * 0.2)), rad = 20 + Math.floor(r() * 30), rv = rad * (0.6 + r() * 0.8);
        H = (u, v) => ((u - cu) ** 2 / (rad * rad) + v * v / (rv * rv) < 1 ? SEA - 6 : hills(u, v));
    } else if (kind === 'canyon') {                                                   // a ravine 30 deep and 10 wide with one bridge
        const u0 = Math.floor(D * (0.3 + r() * 0.3));
        H = (u, v) => (u >= u0 && u < u0 + 10 && Math.abs(v) < 140 ? (v >= gap && v < gap + 3 ? 64 : 34) : hills(u, v));
    } else if (kind === 'cliff') {                                                    // a plateau 14 above, a ramp 6 wide at one place
        const u0 = Math.floor(D * (0.3 + r() * 0.3));
        H = (u, v) => (u >= u0 && Math.abs(v) < 140 ? (v >= gap && v < gap + 6 && u < u0 + 14 ? 64 + Math.max(0, Math.min(14, u - u0 + 1)) : 78) : hills(u, v));
        target = { u: Math.max(D, u0 + 20), v: target.v };
    } else if (kind === 'pit') {                                                      // start on the floor of a deep pit, the target above ground: the haul road is the only way up
        const side = 40 + Math.floor(r() * 50), depth = Math.min(side - 4, 20 + Math.floor(r() * 70)), ex = side;           // pit box [0, side) x [-side/2, side/2); the road runs up the east edge (u = side - 1)
        const z0 = -Math.floor(side / 2), top = 64;
        H = (u, v) => {
            if (u >= 0 && u < side && v >= z0 && v < z0 + side) {
                if (u === ex - 1 && v - z0 < depth) return top - depth + (v - z0);
                return top - depth;
            }
            return hills(u, v);
        };
        start = { u: 5 + Math.floor(r() * 20), v: z0 + side - 6 - Math.floor(r() * 10) };
        target = { u: side + 20 + Math.floor(r() * 90), v: Math.round((r() - 0.5) * 60) };
    }
    void feat;
    return { kind, H, start, target, seed, sea: kind === 'lake' ? SEA : -999 };
}

/** The world a bot at `bot` {x, z} sees: kindAt over the scenario, `unknown` outside the chunks within VIEW of the bot's chunk. Frame: rotation k (quarter turns), mirror, offset. */
class SimWorld {
    constructor(sc, { rot = 0, mirror = false, ox = 0, oz = 0 } = {}) {
        Object.assign(this, { sc, rot, mirror, ox, oz }); this.cache = new Map(); this.bot = { x: 0, z: 0 };
    }
    // world (x, z) -> local (u, v) and back
    toLocal(x, z) { let u = x - this.ox, v = z - this.oz; for (let i = 0; i < this.rot; i++) [u, v] = [v, -u]; return this.mirror ? [u, -v] : [u, v]; }
    toWorld(u, v) { if (this.mirror) v = -v; for (let i = 0; i < this.rot; i++) [u, v] = [-v, u]; return { x: u + this.ox, z: v + this.oz }; }
    height(x, z) {
        const cx = x >> 4, cz = z >> 4, key = cx * 100003 + cz;
        let ch = this.cache.get(key);
        if (!ch) { ch = new Int16Array(256); for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) { const [u, v] = this.toLocal(cx * 16 + i, cz * 16 + j); ch[i * 16 + j] = this.sc.H(u, v); } this.cache.set(key, ch); }
        return ch[(x & 15) * 16 + (z & 15)];
    }
    known(x, z) { return Math.abs((x >> 4) - (this.bot.x >> 4)) <= VIEW && Math.abs((z >> 4) - (this.bot.z >> 4)) <= VIEW; }
    kindAt(x, y, z) {
        if (!this.known(x, z)) return 'unknown';
        if (y < -64) return 'solid';
        const h = this.height(x, z);
        if (y < h) return 'solid';
        return y < this.sc.sea ? 'water' : 'air';
    }
}

/** Placement of a scenario in the world: random quarter turn, mirror and a non-aligned offset. */
function place(sc, seed) {
    const r = rng(seed ^ 0x9e3779b9), w = new SimWorld(sc, { rot: Math.floor(r() * 4), mirror: r() < 0.5, ox: Math.floor((r() - 0.5) * 4000), oz: Math.floor((r() - 0.5) * 4000) });
    const s = w.toWorld(sc.start.u, sc.start.v), t = w.toWorld(sc.target.u, sc.target.v);
    const here = { x: s.x, z: s.z }; w.bot = here;
    here.y = standY(w, s.x, s.z); t.y = standY(w, t.x, t.z);
    return { world: w, here, target: t };
}
function standY(w, x, z) { const h = w.height(x, z); return h < w.sc.sea ? w.sc.sea - 1 : h; }          // feet in the surface water of a lake, else on top of the column

/** The bot of the simulation: position, the action layer's move_to (planner budget, re-plans) and the counters the cost is made of. */
class SimBot {
    constructor(placed) { this.w = placed.world; this.pos = { ...placed.here }; this.target = placed.target; this.c = { calls: 0, ok: 0, fail: 0, blocks: 0, expanded: 0, plans: 0, reasons: {} }; this.w.bot = this.pos; }
    here() { return { x: this.pos.x, y: this.pos.y, z: this.pos.z }; }
    async exec(name, a) {
        const c = this.c, w = this.w; c.calls++;
        const fail = (reason, detail = {}) => { c.fail++; c.reasons[reason] = (c.reasons[reason] || 0) + 1; return { ok: false, reason, detail }; };
        if (w.kindAt(a.x, a.y, a.z) === 'unknown') return fail('unreachable', { why: 'target chunk not loaded' });
        if (!standable(w, a.x, a.y, a.z)) return fail('invalid_target', { why: 'a player cannot stand there' });
        const goal = { isGoal: (q) => q.x === a.x && q.y === a.y && q.z === a.z, h: (q) => Math.hypot(q.x - a.x, q.z - a.z) + 0.5 * Math.abs(q.y - a.y) };
        for (let replans = 0; ; replans++) {
            const r = plan(w, this.here(), goal.isGoal, goal.h, { maxNodes: PLAN_NODES }); c.plans++;
            if (!r) return fail('unreachable', { why: 'start cell not standable' });
            c.expanded += r.expanded;
            if (r.partial && r.path.length === 1) return fail('unreachable', { expanded: r.expanded });
            let prev = r.path[0];
            for (const n of r.path.slice(1)) { c.blocks += Math.hypot(n.x - prev.x, n.z - prev.z) * (n.kind === 'swim' ? 2.5 : 1) + Math.abs(n.y - prev.y) * 0.5; prev = n; }
            const end = r.path[r.path.length - 1]; this.pos.x = end.x; this.pos.y = end.y; this.pos.z = end.z;
            if (!r.partial) { c.ok++; return { ok: true }; }
            if (replans + 1 > MAX_REPLANS) return fail('stuck', { why: 'replans' });
        }
    }
    env(extra = {}) { return { w: this.w, here: () => this.here(), exec: (n, a) => this.exec(n, a), cancel: { cancelled: false }, ...extra }; }
}

module.exports = { KINDS, scenario, place, SimWorld, SimBot, rng, PLAN_NODES, MAX_REPLANS, SEA };
