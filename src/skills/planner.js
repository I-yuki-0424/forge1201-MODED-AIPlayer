'use strict';
// A* over body cells (integer feet positions). Pure: the world comes in as the interface of world.js.
// A node is a cell where the body can be held: standing (solid below), swimming at the surface (world.swimmable), or hanging
// on a ladder/vine (world.climbable). Moves, all of them things a player does with forward + jump (+ nothing):
//   walk      to one of the 8 neighbours at the same height (diagonals only when both side cells are open, no corner
//             clipping); into, out of and through water and climbable cells too (swimming costs SWIM per block)
//   up        one block up onto ground, cardinal only, with head room above the start (from ground, water or a ladder top)
//   drop      walk off an edge and fall 1..MAX_DROP blocks onto ground, or up to MAX_DROP_WATER into water or onto a
//             ladder/vine (which catches the fall), cardinal only
//   climb     one cell up a ladder/vine (hold jump), descend one cell down it (nothing held: the client slides down)
//   swim      one cell up or down inside the surface band of a water column
// No digging, no placing, no diving, no parkour: a target that needs them is reported unreachable.
const { standable, swimmable, climbable, passable } = require('./world');

const MAX_DROP = 3, MAX_DROP_WATER = 8;
const SWIM = 2.5, CLIMB = 1.5;      // costs per block relative to walking (water and ladders are 2-4 times slower)
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(x) {
        const a = this.a; a.push(x);
        for (let i = a.length - 1; i > 0;) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
    }
    pop() {
        const a = this.a, top = a[0], last = a.pop();
        if (a.length) {
            a[0] = last;
            for (let i = 0; ;) {
                const l = 2 * i + 1, r = l + 1; let m = i;
                if (l < a.length && a[l].f < a[m].f) m = l;
                if (r < a.length && a[r].f < a[m].f) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]]; i = m;
            }
        }
        return top;
    }
}

const free = (w, x, y, z) => passable(w.kindAt(x, y, z));
// The body can be moved through the cell (air, ladder, or water: water slows but does not block).
const open = (w, x, y, z) => { const k = w.kindAt(x, y, z); return passable(k) || k === 'water'; };

/** What holds the body in this cell: 'stand', 'swim', 'climb', or null (no node). */
function nodeKind(w, x, y, z) {
    if (standable(w, x, y, z)) return 'stand';
    if (swimmable(w, x, y, z)) return 'swim';
    if (climbable(w, x, y, z)) return 'climb';
    return null;
}

/** Neighbour nodes of a node with their move kind and cost. */
function neighbours(w, n) {
    const out = [];
    const here = n.kind || nodeKind(w, n.x, n.y, n.z);
    const push = (x, y, z, kind, move, cost) => out.push({ x, y, z, kind, move, cost: kind === 'swim' || here === 'swim' ? cost * SWIM : cost });
    for (const [dx, dz] of DIRS) {
        const x = n.x + dx, z = n.z + dz, diag = dx && dz;
        const k = nodeKind(w, x, n.y, z);
        if (k) {
            if (diag && !(open(w, n.x + dx, n.y, n.z) && open(w, n.x + dx, n.y + 1, n.z) && open(w, n.x, n.y, n.z + dz) && open(w, n.x, n.y + 1, n.z + dz))) continue;
            push(x, n.y, z, k, 'walk', diag ? Math.SQRT2 : 1);
            continue;
        }
        if (diag) continue;
        if (standable(w, x, n.y + 1, z) && open(w, n.x, n.y + 2, n.z)) { push(x, n.y + 1, z, 'stand', 'up', 2); continue; }
        if (here !== 'swim' && free(w, x, n.y, z) && free(w, x, n.y + 1, z)) {
            for (let d = 1; d <= MAX_DROP_WATER; d++) {
                if (d <= MAX_DROP && standable(w, x, n.y - d, z)) { push(x, n.y - d, z, 'stand', 'drop', 1 + 0.5 * d); break; }
                if (swimmable(w, x, n.y - d, z)) { push(x, n.y - d, z, 'swim', 'drop', 1 + 0.2 * d); break; }
                if (climbable(w, x, n.y - d, z)) { push(x, n.y - d, z, 'climb', 'drop', 1 + 0.5 * d); break; }   // caught by a ladder
                if (!free(w, x, n.y - d, z)) break;
            }
        }
    }
    // Vertical: up a ladder (from the ladder, the ground at its foot, or the water at its foot), down a ladder, inside the
    // surface band of a water column.
    if (climbable(w, n.x, n.y + 1, n.z) && open(w, n.x, n.y + 2, n.z)) push(n.x, n.y + 1, n.z, 'climb', 'climb', CLIMB);
    if (here === 'climb') {
        const k = nodeKind(w, n.x, n.y - 1, n.z);
        if (k === 'climb' || k === 'stand') out.push({ x: n.x, y: n.y - 1, z: n.z, kind: k, move: 'descend', cost: CLIMB });
    }
    if (here === 'swim') {
        for (const dy of [1, -1]) if (swimmable(w, n.x, n.y + dy, n.z)) out.push({ x: n.x, y: n.y + dy, z: n.z, kind: 'swim', move: 'swim', cost: 1 });
    }
    return out;
}

/**
 * Plan from `start` (a standing cell) to the nearest cell satisfying `isGoal(cell)`, guided by the admissible-ish
 * estimate `h(cell)`. Returns {path: [cells from start to goal, each with .move], partial, expanded}; when the goal is
 * not found within `maxNodes`, `path` leads to the expanded cell with the lowest h and `partial` is true.
 * Returns null when start itself is no node (not standing, swimming or climbing).
 */
function plan(w, start, isGoal, h, { maxNodes = 20000 } = {}) {
    const k0 = nodeKind(w, start.x, start.y, start.z);
    if (!k0) return null;
    const key = (c) => `${c.x},${c.y},${c.z}`;
    const open = new Heap(), seen = new Map();
    const s = { x: start.x, y: start.y, z: start.z, kind: k0, g: 0, f: h(start), parent: null, move: 'start' };
    seen.set(key(s), s); open.push(s);
    let best = s, expanded = 0;
    while (open.size && expanded < maxNodes) {
        const n = open.pop();
        if (n.closed) continue;
        n.closed = true; expanded++;
        if (isGoal(n)) return { path: unwind(n), partial: false, expanded };
        if (n.f - n.g < best.f - best.g) best = n;
        for (const m of neighbours(w, n)) {
            const g = n.g + m.cost, k = key(m), old = seen.get(k);
            if (old && (old.closed || old.g <= g)) continue;
            const node = { ...m, g, f: g + h(m), parent: n };
            seen.set(k, node); open.push(node);
        }
    }
    return { path: unwind(best), partial: true, expanded };
}

function unwind(n) {
    const out = [];
    for (; n; n = n.parent) out.push({ x: n.x, y: n.y, z: n.z, kind: n.kind, move: n.move });
    return out.reverse();
}

/**
 * Every node reachable from `start` within `maxNodes` expansions and `radius` blocks (Dijkstra over the same moves as plan):
 * {has(x, y, z), cells: [[x, y, z, cost], ...]}. What the RL candidate list uses to leave out targets the walker cannot reach.
 */
function reachable(w, start, { maxNodes = 1500, radius = 20 } = {}) {
    const R = radius, side = 2 * R + 1;
    const key = (x, y, z) => ((x - start.x + R) * side + (z - start.z + R)) * 1024 + (y - start.y + 512);
    const inside = (x, y, z) => Math.abs(x - start.x) <= R && Math.abs(z - start.z) <= R && Math.abs(y - start.y) < 512;
    const done = new Map(), cells = [];
    const k0 = nodeKind(w, start.x, start.y, start.z);
    if (k0) {
        const open = new Heap();
        open.push({ x: start.x, y: start.y, z: start.z, kind: k0, f: 0 });
        while (open.size && cells.length < maxNodes) {
            const c = open.pop(), k = key(c.x, c.y, c.z);
            if (done.has(k)) continue;
            done.set(k, c.f); cells.push([c.x, c.y, c.z, c.f]);
            for (const m of neighbours(w, c)) if (inside(m.x, m.y, m.z) && !done.has(key(m.x, m.y, m.z))) { m.f = c.f + m.cost; open.push(m); }
        }
    }
    return { has: (x, y, z) => inside(x, y, z) && done.has(key(x, y, z)), cells };
}

module.exports = { plan, neighbours, reachable, nodeKind, MAX_DROP, MAX_DROP_WATER };
