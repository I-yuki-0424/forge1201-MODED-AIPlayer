'use strict';
// A* over standing cells (integer feet positions). Pure: the world comes in as the interface of world.js.
// Moves, all of them things a walking player does with forward + jump:
//   walk      to one of the 8 neighbours at the same height (diagonals only when both side cells are free, no corner clipping)
//   step up   one block, cardinal only, with head room above the start cell
//   drop      walk off an edge and fall 1..MAX_DROP blocks, cardinal only
// No digging, no placing, no swimming, no parkour: a target that needs them is reported unreachable.
const { standable } = require('./world');

const MAX_DROP = 3;
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

const free = (w, x, y, z) => w.kindAt(x, y, z) === 'air';

/** Neighbour cells of a standing cell with their move kind and cost. */
function neighbours(w, n) {
    const out = [];
    for (const [dx, dz] of DIRS) {
        const x = n.x + dx, z = n.z + dz, diag = dx && dz;
        if (standable(w, x, n.y, z)) {
            if (diag && !(free(w, n.x + dx, n.y, n.z) && free(w, n.x + dx, n.y + 1, n.z) && free(w, n.x, n.y, n.z + dz) && free(w, n.x, n.y + 1, n.z + dz))) continue;
            out.push({ x, y: n.y, z, move: 'walk', cost: diag ? Math.SQRT2 : 1 });
            continue;
        }
        if (diag) continue;
        if (standable(w, x, n.y + 1, z) && free(w, n.x, n.y + 2, n.z)) { out.push({ x, y: n.y + 1, z, move: 'up', cost: 2 }); continue; }
        if (free(w, x, n.y, z) && free(w, x, n.y + 1, z) && w.kindAt(x, n.y - 1, z) === 'air') {
            for (let k = 1; k <= MAX_DROP; k++) {
                if (standable(w, x, n.y - k, z)) { out.push({ x, y: n.y - k, z, move: 'drop', cost: 1 + 0.5 * k }); break; }
                if (!free(w, x, n.y - k, z)) break;
            }
        }
    }
    return out;
}

/**
 * Plan from `start` (a standing cell) to the nearest cell satisfying `isGoal(cell)`, guided by the admissible-ish
 * estimate `h(cell)`. Returns {path: [cells from start to goal, each with .move], partial, expanded}; when the goal is
 * not found within `maxNodes`, `path` leads to the expanded cell with the lowest h and `partial` is true.
 * Returns null when start itself is not standable.
 */
function plan(w, start, isGoal, h, { maxNodes = 20000 } = {}) {
    if (!standable(w, start.x, start.y, start.z)) return null;
    const key = (c) => `${c.x},${c.y},${c.z}`;
    const open = new Heap(), seen = new Map();
    const s = { x: start.x, y: start.y, z: start.z, g: 0, f: h(start), parent: null, move: 'start' };
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
    for (; n; n = n.parent) out.push({ x: n.x, y: n.y, z: n.z, move: n.move });
    return out.reverse();
}

module.exports = { plan, neighbours, MAX_DROP };
