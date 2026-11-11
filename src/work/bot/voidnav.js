'use strict';
// Walking where there is no ground (the End's void, an abyss), planned instead of learned. A* over exactly the moves the action layer has: walk (flat, step up 1, drop up to 3), BRIDGE (a block
// under the next cell at the same level, bot/bridge.js), PILLAR (up one level on the own column, moves.js). The plan is executed run by run with the action layer's own commands (`move_to`
// for walks, `bridge` for same-level runs with a gap in them, `pillar` for climbs) and made again from where the bot stands when a run does not end where it should.
// Why: the learned walk (src/experts/move3) was trained on grounded pits; on the copy of the play world its End-pit station walks failed 40-55 % of the time, wandering down islands and
// giving up after 60 decisions (docs/implemented/REAL-WORLD-VERIFICATION-v1.md). The moves it uses worked every time they were traced; its choice of moves did not.
// Pure apart from `env` (w, here, exec, run, cancel?, have?): the tests drive it with a fake world.
const { passable, standable } = require('../../skills/world');

const FATAL = new Set(['died', 'disconnected', 'cancelled', 'wrong_dimension']);
const COST = { walk: 1, step: 1.2, drop: 1.1, bridge: 3.5, pillar: 3 };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(k, v) { const a = this.a; a.push([k, v]); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() { const a = this.a, top = a[0], last = a.pop(); if (a.length) { a[0] = last; let i = 0; for (;;) { let l = 2 * i + 1, r = l + 1, m = i; if (l < a.length && a[l][0] < a[m][0]) m = l; if (r < a.length && a[r][0] < a[m][0]) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } } return top; }
}

/**
 * The cheapest sequence of moves from the feet cell `from` to the feet cell `to` (both {x, y, z}), or {ok: false, why}.
 * Returns { ok: true, path: [{x, y, z, how: 'walk'|'step'|'drop'|'bridge'|'pillar'}] (from excluded, to included), placed (blocks to lay), expanded }.
 * `opt`: maxNodes (default 60000), margin (blocks around the two cells searched, default 14), blocks (how many blocks the pack holds: plans needing more are refused, default infinity).
 */
function plan(w, from, to, opt = {}) {
    const margin = opt.margin ?? 14, maxNodes = opt.maxNodes ?? 60000, blocks = opt.blocks ?? Infinity;
    const x0 = Math.min(from.x, to.x) - margin, x1 = Math.max(from.x, to.x) + margin, z0 = Math.min(from.z, to.z) - margin, z1 = Math.max(from.z, to.z) + margin;
    const y0 = Math.min(from.y, to.y) - 4, y1 = Math.max(from.y, to.y) + 6, nx = x1 - x0 + 1, ny = y1 - y0 + 1, nz = z1 - z0 + 1;
    if (nx * ny * nz > 4_000_000) return { ok: false, why: 'search box too large' };
    const kind = (x, y, z) => w.kindAt(x, y, z), free = (x, y, z) => passable(kind(x, y, z));
    const id = (x, y, z) => ((x - x0) * ny + (y - y0)) * nz + (z - z0), inside = (x, y, z) => x >= x0 && x <= x1 && y >= y0 && y <= y1 && z >= z0 && z <= z1;
    const kindTo = kind(to.x, to.y, to.z);
    if (kindTo === 'unknown' || !free(to.x, to.y, to.z) || !free(to.x, to.y + 1, to.z)) return { ok: false, why: 'the target cell is not free (or not loaded)' };
    const h = (x, y, z) => Math.abs(x - to.x) + Math.abs(z - to.z) + Math.max(0, to.y - y);
    const g = new Map(), prev = new Map(), how = new Map(), open = new Heap(), done = new Set();
    const s = id(from.x, from.y, from.z); g.set(s, 0); open.push(h(from.x, from.y, from.z), [from.x, from.y, from.z, 0]);
    let expanded = 0, goal = -1;
    const relax = (x, y, z, c, hw, from_) => {
        if (!inside(x, y, z)) return;
        const k = id(x, y, z), ng = from_.g + c;
        if (g.has(k) && g.get(k) <= ng) return;
        g.set(k, ng); prev.set(k, from_.k); how.set(k, hw); open.push(ng + h(x, y, z), [x, y, z, ng]);
    };
    while (open.size && expanded < maxNodes) {
        const [, [x, y, z, gc]] = open.pop(), k = id(x, y, z);
        if (done.has(k) || gc > g.get(k) + 1e-9) continue;
        done.add(k); expanded++;
        if (x === to.x && y === to.y && z === to.z) { goal = k; break; }
        const me = { k, g: gc };
        for (const [dx, dz] of DIRS) {
            const ax = x + dx, az = z + dz;
            // walk: flat, one up (headroom above the origin), down up to three (the column the body falls through is free)
            if (standable(w, ax, y, az)) relax(ax, y, az, COST.walk, 'walk', me);
            if (standable(w, ax, y + 1, az) && free(x, y + 2, z)) relax(ax, y + 1, az, COST.step, 'step', me);
            for (let d = 1; d <= 3; d++) {
                if (!free(ax, y, az) || !free(ax, y + 1, az)) break;
                if (d > 1 && !free(ax, y - d + 2, az)) break;
                if (standable(w, ax, y - d, az)) { relax(ax, y - d, az, COST.drop + 0.1 * d, 'drop', me); break; }
            }
            // bridge: the next cell at the same level is free and has no floor (air; never water or lava)
            if (free(ax, y, az) && free(ax, y + 1, az) && kind(ax, y - 1, az) === 'air') relax(ax, y, az, COST.bridge, 'bridge', me);
        }
        // pillar: up one on the own column (the cell above the head is free too: the jump needs the room)
        if (free(x, y + 2, z) && free(x, y + 3, z)) relax(x, y + 1, z, COST.pillar, 'pillar', me);
    }
    if (goal < 0) return { ok: false, why: expanded >= maxNodes ? `no plan within ${maxNodes} nodes` : 'no way (walk, bridge, pillar) reaches the cell', expanded };
    const path = []; let k = goal;
    const cell = (kk) => { const yz = kk % (ny * nz), xx = Math.floor(kk / (ny * nz)) + x0, yy = Math.floor(yz / nz) + y0, zz = (yz % nz) + z0; return { x: xx, y: yy, z: zz }; };
    while (k !== s) { path.push({ ...cell(k), how: how.get(k) }); k = prev.get(k); }
    path.reverse();
    const placed = path.filter((p) => p.how === 'bridge' || p.how === 'pillar').length;
    if (placed > blocks) return { ok: false, why: `the plan needs ${placed} blocks, the pack holds ${blocks}`, expanded };
    return { ok: true, path, placed, expanded };
}

/** The runs of a plan: consecutive moves of one kind. Same-level moves with a bridge in them are one `bridge` run (walks inside it are cells that already have a floor), climbs one `pillar` run. */
function runs(path, from) {
    const out = []; let cur = null, prev = from;
    for (const p of path) {
        const kind = p.how === 'bridge' ? 'bridge' : p.how === 'pillar' ? 'pillar' : p.how === 'walk' && cur && cur.kind === 'bridge' && p.y === cur.y && cur.pendingBridge ? 'bridge' : 'walk';
        if (cur && cur.kind === kind && (kind !== 'pillar' || (p.x === prev.x && p.z === prev.z)) && (kind !== 'bridge' || p.y === cur.y)) { cur.cells.push(p); if (p.how === 'bridge') cur.pendingBridge = true; }
        else { cur = { kind, y: p.y, cells: [p], from: { ...prev }, pendingBridge: p.how === 'bridge' }; out.push(cur); }
        prev = p;
    }
    return out;
}

/**
 * Walk to the feet cell `to` {x, y, z} (an integer level) by the plan, run by run, planning again when a run does not end where the plan said (up to `replans` times).
 * `env`: w, here(), exec(name, args, opts), run(name, args), cancel?, have?(item) (blocks in the pack). Returns {ok: true, ...} or {ok: false, reason, detail}.
 */
async function walk(env, to, opt = {}) {
    const info = { replans: 0, runs: 0, placed: 0, expanded: 0 }, replans = opt.replans ?? 4, out = (r) => ({ ...r, voidnav: info });
    if (!Number.isInteger(to.y)) return out({ ok: false, reason: 'refused', detail: { why: 'voidnav needs the level of the target' } });
    const blocks = env.have ? ['cobblestone', 'end_stone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'blackstone', 'basalt'].reduce((n, b) => n + (env.have(b) || 0), 0) : Infinity;
    for (let attempt = 0; attempt <= replans; attempt++) {
        if (env.cancel && env.cancel.cancelled) return out({ ok: false, reason: 'cancelled' });
        if (env.wrongDim && env.wrongDim()) return out({ ok: false, reason: 'wrong_dimension' });
        const here = env.here();
        if (here.x === to.x && here.y === to.y && here.z === to.z) return out({ ok: true });
        const p = plan(env.w, here, to, { blocks });
        info.expanded += p.expanded || 0;
        if (!p.ok) return out({ ok: false, reason: 'unreachable', detail: { why: p.why, at: here, goal: to } });
        info.placed += p.placed;
        let broke = false;
        for (const r of runs(p.path, here)) {
            info.runs++;
            const last = r.cells[r.cells.length - 1];
            let res;
            if (r.kind === 'walk') res = await env.exec('move_to', { x: last.x, y: last.y, z: last.z }, { maxTicks: 200 });
            else if (r.kind === 'bridge') res = await env.run('bridge', { y: r.y, cells: r.cells.map((c) => ({ x: c.x, z: c.z })), road: true });
            else res = await env.run('pillar', { levels: r.cells.length });
            if (!res.ok && FATAL.has(res.reason)) return out({ ok: false, reason: res.reason, detail: res.detail });
            const at = env.here();
            if (at.x !== last.x || at.y !== last.y || at.z !== last.z) { broke = true; info.lastFail = res.ok ? 'ended elsewhere' : res.reason; break; }
        }
        if (!broke) { const at = env.here(); if (at.x === to.x && at.y === to.y && at.z === to.z) return out({ ok: true }); }
        info.replans = attempt + 1;
    }
    return out({ ok: false, reason: 'stuck', detail: { why: `${replans + 1} plans did not bring the bot to the cell (last: ${info.lastFail || 'ended elsewhere'})`, at: env.here(), goal: to } });
}

module.exports = { plan, runs, walk };
