'use strict';
// NAV (docs/implemented/NAV-v1.md): the one movement planner. A* over feet cells with the moves a player makes, each with a cost, so that the cheapest way is taken and a block is
// placed only where nothing else gets the bot there (owner 2026-11-14: "blocks placed for no reason", "went up or down for no reason": the learned walk and five fallbacks did that).
//   walk / diag   one cell across (diagonal only between two open sides)         1 / 1.41
//   up            one cell up onto ground (jump), head room over the start       1.3
//   drop          walk off an edge onto ground 1..3 below                        1 + 0.3 per block
//   swim          the water surface band (the action layer's walk swims)         2.5 per cell
//   climb         ladders and vines                                              1.5
//   dig           a body cell in the way is broken first (tunnel, step up through rock, a staircase down)   per block: 3 + hardness (unsafe cells: never)
//   digdown       break the floor and drop onto the cell below (no deeper fall than 3)                       1.5 + hardness
//   pillar        place a block in the feet cell and stand on it, in open air only                          PILLAR (10; through rock the staircase is the way up)
//   bridge        place a block under the next cell (no ground within 3 below) and step on                   BRIDGE (12)
//   descend       on a block this bot placed (a pillar's last block, a bridge block): put one under it, break the one under the feet, drop  DESCEND (5 a level)
//                 (2026-11-18: with no way down a builder on a high temporary block stayed there; the reverse of a pillar, moves.js `descend`)
// Pure: the world comes in as world.js's interface (kindAt, nameAt); `o.dig(name)` says whether and how hard a block is to break with the pack the bot has (null = never).
// The plan does not model its own changes beyond the node it makes (a pillar or bridge node stands on its placed block), the way Baritone's movements do; the walker replans every segment.
const { passable, swimmable, climbable } = require('../skills/world');

const PILLAR = 10, BRIDGE = 12, DESCEND = 5, SWIM = 2.5, CLIMB = 1.5, MAX_DROP = 3;
const CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]], DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const FLUIDS = new Set(['water', 'liquid', 'danger']);
const FALLING = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|[a-z_]+_concrete_powder|pointed_dripstone|anvil|chipped_anvil|damaged_anvil|scaffolding|dragon_egg)$/;

class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) { const a = this.a; a.push(x); for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; } }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) { a[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && a[l].f < a[m].f) m = l; if (r < a.length && a[r].f < a[m].f) m = r; if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m; } }
        return top;
    }
}

/** The view of the world one search uses: cell kinds, what may be broken and at what cost, and the cells a node stands on although they are air in the world (placed by the plan). */
function view(w, o = {}) {
    const dig = o.dig || null, protectedCell = o.protectedCell || (() => false), box = o.within || null;
    const kind = (x, y, z) => w.kindAt(x, y, z);
    const name = (x, y, z) => String((w.nameAt && w.nameAt(x, y, z)) || '').replace(/^minecraft:/, '');
    /** The cost of breaking (x, y, z) so that the body passes, or null when it must not be broken: not loaded, a fluid beside it (it would flood the way), a fixture, unbreakable. */
    const digCost = (x, y, z) => {
        if (!dig || o.noDig) return null;
        const k = kind(x, y, z);
        if (k !== 'solid' && k !== 'partial') return null;
        if (protectedCell(x, y, z)) return null;
        const c = dig(name(x, y, z));
        if (c === null || c === undefined) return null;
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, -1]]) { const kk = kind(x + dx, y + dy, z + dz); if (FLUIDS.has(kk) || kk === 'unknown') return null; }
        return 3 + c + (FALLING.test(name(x, y + 1, z)) ? 4 : 0);              // 3: a block is broken only to save more than a few steps (the world is left as it was where walking round works)
    };
    /** The cost of making a body cell passable: 0 when it is, the dig cost when it can be dug, null when neither. */
    const clear = (x, y, z) => { const k = kind(x, y, z); if (passable(k) || k === 'water') return 0; return digCost(x, y, z); };            // water: the body passes (swimming); whether it can be held there is the node's business
    const maxDrop = o.maxDrop || (w.maxDrop && w.maxDrop()) || MAX_DROP;        // a job that works high up (a build in the sky) raises it for its bot: bot.__maxDrop
    return { kind, name, digCost, clear, within: box, maxDrop };
}

const solid = (V, x, y, z) => V.kind(x, y, z) === 'solid';
const nodeKindOf = (V, x, y, z, placed) => {
    const k = V.kind(x, y, z), h = V.kind(x, y + 1, z);
    if (passable(k) && passable(h) && (placed || solid(V, x, y - 1, z))) return 'stand';
    if (swimmable({ kindAt: V.kind }, x, y, z)) return 'swim';
    if (climbable({ kindAt: V.kind }, x, y, z)) return 'climb';
    return null;
};

/** The cells the way to `n` has dug (the node and its last 16 ancestors): they are air for the moves out of `n` (a staircase that turns must not stand on the step it dug away). */
function dugOf(n) {
    let set = null;
    for (let m = n, i = 0; m && i < 16; m = m.parent, i++) if (m.dig && m.dig.length) { set = set || new Set(); for (const c of m.dig) set.add(`${c.x},${c.y},${c.z}`); }
    return set;
}
function overlay(V, dug) {
    const k = (x, y, z) => `${x},${y},${z}`;
    const kind = (x, y, z) => (dug.has(k(x, y, z)) ? 'air' : V.kind(x, y, z));
    return { ...V, kind, digCost: (x, y, z) => (dug.has(k(x, y, z)) ? null : V.digCost(x, y, z)), clear: (x, y, z) => (dug.has(k(x, y, z)) ? 0 : V.clear(x, y, z)) };
}

/** The moves out of node `n`: [{x, y, z, kind, move, cost, dig: [cells], place: cell|null}]. */
function moves(V0, n, o) {
    const dug = dugOf(n), V = dug ? overlay(V0, dug) : V0;
    const out = [], x = n.x, y = n.y, z = n.z, here = n.kind;
    const keep = o.keep || null;                                    // cells a temporary block must not go into (the structure being built)
    const add = (m) => { if (o.noPlace && m.place) return; if (keep && m.place && keep(m.place.x, m.place.y, m.place.z)) return; out.push(m); };
    for (const [dx, dz] of CARD) {
        const X = x + dx, Z = z + dz;
        const c0 = V.clear(X, y, Z), c1 = V.clear(X, y + 1, Z);
        // across at the same level (dig the two body cells if needed)
        if (c0 !== null && c1 !== null) {
            const dig = []; if (c0) dig.push({ x: X, y, z: Z }); if (c1) dig.push({ x: X, y: y + 1, z: Z });
            const k = V.kind(X, y - 1, Z);
            const target = nodeKindOf(V, X, y, Z, false) || (dig.length && solid(V, X, y - 1, Z) ? 'stand' : null);
            if (target) add({ x: X, y, z: Z, kind: target, move: dig.length ? 'dig' : 'walk', cost: (target === 'swim' || here === 'swim' ? SWIM : 1) + c0 + c1, dig });
            else if (!dig.length && here !== 'swim' && passable(k)) {
                // off an edge: the first floor within MAX_DROP, a water surface, or a bridge block when there is nothing
                let landed = false;
                for (let d = 1; d <= V.maxDrop + 5; d++) {
                    const kk = V.kind(X, y - d, Z);
                    if (kk === 'water') { if (swimmable({ kindAt: V.kind }, X, y - d, Z)) { add({ x: X, y: y - d, z: Z, kind: 'swim', move: 'drop', cost: 1 + 0.2 * d, dig }); } landed = true; break; }
                    if (d <= V.maxDrop && solid(V, X, y - d - 1, Z) && passable(kk)) { add({ x: X, y: y - d, z: Z, kind: 'stand', move: 'drop', cost: 1 + 0.3 * d, dig }); landed = true; break; }
                    if (!passable(kk)) { landed = true; break; }
                }
                if (!landed && k === 'air' && (here === 'stand' || here === 'bridge' || n.placed) && !o.noPlace) add({ x: X, y, z: Z, kind: 'stand', move: 'bridge', cost: BRIDGE, dig: [], place: { x: X, y: y - 1, z: Z }, placed: true });
            }
        }
        // one up (jump onto the next cell's top), digging the head room and the two body cells if needed
        if (here !== 'swim' || V.kind(x, y - 1, z) === 'solid') {
            const h = V.clear(x, y + 2, z), b0 = V.clear(X, y + 1, Z), b1 = V.clear(X, y + 2, Z);
            if (h !== null && b0 !== null && b1 !== null && solid(V, X, y, Z) && V.kind(X, y + 1, Z) !== 'water') {
                const dig = []; if (h) dig.push({ x, y: y + 2, z }); if (b0) dig.push({ x: X, y: y + 1, z: Z }); if (b1) dig.push({ x: X, y: y + 2, z: Z });
                add({ x: X, y: y + 1, z: Z, kind: 'stand', move: dig.length ? 'dig' : 'up', cost: 1.3 + h + b0 + b1, dig });
            }
        }
        // one down by a staircase step dug into the ground (the cell ahead and the one under it)
        if (here === 'stand') {
            const a = V.clear(X, y + 1, Z), b = V.clear(X, y, Z), c = V.clear(X, y - 1, Z);
            if (a !== null && b !== null && c !== null && (b || c) && solid(V, X, y - 2, Z)) {
                const dig = []; if (a) dig.push({ x: X, y: y + 1, z: Z }); if (b) dig.push({ x: X, y, z: Z }); if (c) dig.push({ x: X, y: y - 1, z: Z });
                add({ x: X, y: y - 1, z: Z, kind: 'stand', move: 'dig', cost: 1.3 + a + b + c, dig });
            }
        }
    }
    for (const [dx, dz] of DIAG) {
        const X = x + dx, Z = z + dz;
        const k = nodeKindOf(V, X, y, Z, false);
        if (!k) continue;
        const open = (a, b, c) => { const kk = V.kind(a, b, c); return passable(kk) || kk === 'water'; };
        if (!(open(X, y, z) && open(X, y + 1, z) && open(x, y, Z) && open(x, y + 1, Z))) continue;
        add({ x: X, y, z: Z, kind: k, move: 'walk', cost: Math.SQRT2 * (k === 'swim' || here === 'swim' ? SWIM : 1), dig: [] });
    }
    // straight up on a placed block (pillar), digging the cell over the head if needed
    // only in open air (the head room free) and only from a full block or the last pillar block: through rock the staircase is the way up (T26 move_b: pillars "stuck" and "nothing solid
    // under the feet" in caves, where the start stood on a partial block or the head room had to be dug at every level)
    if (here === 'stand' && !o.noPlace && (n.placed || solid(V, x, y - 1, z))) {
        const h = V.clear(x, y + 2, z);
        if (h === 0) add({ x, y: y + 1, z, kind: 'stand', move: 'pillar', cost: PILLAR, dig: [], place: { x, y, z }, placed: true });
    }
    // straight down on a block this bot placed: one under it, then the one under the feet is broken (a descent of any height, no fall longer than a block)
    if (here === 'stand' && !o.noPlace && (n.placed || (o.isTemp && o.isTemp(x, y - 1, z)))) {
        const k2 = V.kind(x, y - 2, z);
        if (k2 === 'air') add({ x, y: y - 1, z, kind: 'stand', move: 'descend', cost: DESCEND, dig: [], place: { x, y: y - 2, z }, placed: true });
        else if (k2 === 'solid') add({ x, y: y - 1, z, kind: 'stand', move: 'descend', cost: 1.5, dig: [], place: null, placed: false });
    }
    // straight down: break the floor, land on the next floor within MAX_DROP (never into a fluid)
    if (here === 'stand' && !n.placed) {
        const c = V.digCost(x, y - 1, z);
        if (c !== null) {
            for (let d = 2; d <= (V.maxDrop === MAX_DROP ? MAX_DROP : 3) + 1; d++) {
                const kk = V.kind(x, y - d, z);
                if (kk === 'solid') { add({ x, y: y - d + 1, z, kind: 'stand', move: 'digdown', cost: 1.5 + c + 0.3 * (d - 2), dig: [{ x, y: y - 1, z }] }); break; }
                if (!passable(kk)) break;
            }
        }
    }
    // ladders and water columns
    if (climbable({ kindAt: V.kind }, x, y + 1, z) && passable(V.kind(x, y + 2, z))) out.push({ x, y: y + 1, z, kind: 'climb', move: 'climb', cost: CLIMB, dig: [] });
    if (here === 'climb') { const k = nodeKindOf(V, x, y - 1, z, false); if (k === 'climb' || k === 'stand') out.push({ x, y: y - 1, z, kind: k, move: 'climb', cost: CLIMB, dig: [] }); }
    if (here === 'swim') for (const dy of [1, -1]) if (swimmable({ kindAt: V.kind }, x, y + dy, z)) out.push({ x, y: y + dy, z, kind: 'swim', move: 'swim', cost: 1, dig: [] });
    return out;
}

/**
 * Search from `start` for a node that satisfies `goal.is(node)`, guided by `goal.h(node)`. `o`: { dig(name) -> hardness-like cost or null, protectedCell(x, y, z), noPlace, noDig,
 * maxNodes (default 16000), slice (yield every n expansions), score(node) (which expanded node is the best partial end: default the lowest h), radius (across from the start) }.
 * Returns { path: [{x, y, z, kind, move, dig, place}] (start first), partial, expanded } or null when the start is no node.
 */
function* searchSteps(w, start, goal, o = {}) {
    const V = view(w, o), maxNodes = o.maxNodes || 16000, slice = o.slice || 700, R = o.radius || 96, W = o.weight || 1.5;          // weighted A*: a way within 1.5 x the cheapest, found in a fraction of the cells (a tunnel costs ~4 a block, the estimate 1)
    const k0 = nodeKindOf(V, start.x, start.y, start.z, !!start.placed) || (solid(V, start.x, start.y - 1, start.z) || start.ground ? 'stand' : null);
    if (!k0) return null;
    const key = (c) => `${c.x},${c.y},${c.z}`;
    const open = new Heap(), seen = new Map(), score = o.score || goal.h;
    const s = { x: start.x, y: start.y, z: start.z, kind: k0, move: 'start', dig: [], g: 0, f: W * goal.h(start), parent: null, placed: !!start.placed };
    seen.set(key(s), s); open.push(s);
    let best = s, bestScore = score(s), expanded = 0;
    while (open.size && expanded < maxNodes) {
        const n = open.pop();
        if (n.closed) continue;
        n.closed = true; expanded++;
        if (expanded % slice === 0) yield expanded;
        if (goal.is(n)) return { path: unwind(n), partial: false, expanded };
        const sc = score(n); if (sc < bestScore) { best = n; bestScore = sc; }
        for (const m of moves(V, n, o)) {
            if (Math.abs(m.x - start.x) > R || Math.abs(m.z - start.z) > R) continue;
            // a pillar or bridge block each: never more than the pack holds (T26 move_b: a pillar of 85 levels was planned with 64 blocks)
            const pc = (n.pc || 0) + (m.place ? 1 : 0); if (m.place && Number.isFinite(o.blocks) && pc > o.blocks) continue; m.pc = pc;
            if (V.kind(m.x, m.y, m.z) === 'unknown' || V.kind(m.x, m.y + 1, m.z) === 'unknown') continue;
            const g = n.g + m.cost, k = key(m), old = seen.get(k);
            if (old && (old.closed || old.g <= g)) continue;
            const node = { ...m, g, f: g + W * goal.h(m), parent: n };
            seen.set(k, node); open.push(node);
        }
    }
    return { path: unwind(best), partial: true, expanded };
}

function unwind(n) {
    const out = [];
    for (; n; n = n.parent) out.push({ x: n.x, y: n.y, z: n.z, kind: n.kind, move: n.move, dig: n.dig || [], place: n.place || null, placed: !!n.placed, g: Math.round(n.g * 10) / 10 });
    return out.reverse();
}

function search(w, start, goal, o = {}) { const it = searchSteps(w, start, goal, o); for (;;) { const r = it.next(); if (r.done) return r.value; } }
async function searchAsync(w, start, goal, o = {}) { const it = searchSteps(w, start, goal, o); for (;;) { const r = it.next(); if (r.done) return r.value; await new Promise((res) => setImmediate(res)); } }

/**
 * The plan the walker uses: first on foot only (no dig, no block placed, exact A*), and only when that cannot reach the goal, with every move (weighted). A human walks where walking
 * works; the full search with its inflated estimates would otherwise prefer a pillar in a cave that has a way out on foot.
 */
async function planAsync(w, start, goal, o = {}) {
    const foot = await searchAsync(w, start, goal, { ...o, noDig: true, noPlace: true, weight: 1, maxNodes: Math.min(o.maxNodes || 16000, 9000) });
    if (foot && !foot.partial) return { ...foot, foot: true };
    if (o.noDig && o.noPlace) return foot;
    const all = await searchAsync(w, start, goal, o);
    if (!all) return foot;
    // beyond the loaded chunks both are partial: on foot when it gets about as far
    if (all.partial && foot && foot.partial) { const sc = o.score || goal.h, a = sc(all.path[all.path.length - 1]), f = sc(foot.path[foot.path.length - 1]); if (f <= a + 4) return { ...foot, foot: true }; }
    return all;
}
function plan(w, start, goal, o = {}) {
    const foot = search(w, start, goal, { ...o, noDig: true, noPlace: true, weight: 1, maxNodes: Math.min(o.maxNodes || 16000, 9000) });
    if (foot && !foot.partial) return { ...foot, foot: true };
    if (o.noDig && o.noPlace) return foot;
    const all = search(w, start, goal, o);
    if (!all) return foot;
    if (all.partial && foot && foot.partial) { const sc = o.score || goal.h, a = sc(all.path[all.path.length - 1]), f = sc(foot.path[foot.path.length - 1]); if (f <= a + 4) return { ...foot, foot: true }; }
    return all;
}

/** Every cell from (x, y + 1, z) to the top of the column lets the sky through (air, plants, glass), read from the loaded chunk: the server's can_see_sky as far as the bot can know it. */
function seesSky(w, x, y, z, top = 319) {
    for (let yy = y + 1; yy <= top; yy++) {
        const k = w.kindAt(x, yy, z);
        if (k === 'unknown') return yy > y + 1;
        if (k !== 'air') return false;
        const n = String((w.nameAt && w.nameAt(x, yy, z)) || '');
        if (/leaves|water|cobweb/.test(n)) return false;
    }
    return true;
}

/** Goals. A cell: within `near` across and `nearY` up or down. A column at any level (y undefined). The surface: a standing node that sees the sky. */
function cellGoal(t, { near = 1, nearY = 1 } = {}) {
    const hasY = Number.isInteger(t.y);
    return {
        is: (n) => Math.abs(n.x - t.x) <= near && Math.abs(n.z - t.z) <= near && (!hasY || Math.abs(n.y - t.y) <= nearY) && n.kind !== 'climb',
        h: (n) => Math.max(0, Math.hypot(n.x - t.x, n.z - t.z) - near) + (hasY ? Math.max(0, Math.abs(n.y - t.y) - nearY) + 3 * Math.max(0, t.y - n.y - nearY) : 0),          // a level up costs more than a level down (a pillar, a step): the search goes up first and does not fan out over the whole deck
    };
}
/** The lowest level at which the column (x, z) sees the sky, from `y` up (the surface over a cave), or null when the column is not loaded that far. */
function skyLevel(w, x, y, z, top = 319) {
    for (let yy = y; yy <= top; yy++) { const k = w.kindAt(x, yy, z); if (k === 'unknown') return null; if (seesSky(w, x, yy, z)) return yy; }
    return null;
}
/** The surface goal. The estimate weighs a level 9 (x 1.5 = what a level dug up through rock costs, ~12.5; walked up it is about 1.3): inflated on purpose, so that the search goes up, not round. */
function surfaceGoal(w, from) {
    const S = from.surfaceY || skyLevel(w, from.x, from.y, from.z) || from.y + 16;
    return { is: (n) => n.kind === 'stand' && seesSky(w, n.x, n.y, n.z), h: (n) => Math.max(0, S - n.y) * 9 };
}

module.exports = { plan, planAsync, search, searchAsync, searchSteps, moves, view, cellGoal, surfaceGoal, seesSky, skyLevel, nodeKindOf, PILLAR, BRIDGE, DESCEND, MAX_DROP, FALLING };
