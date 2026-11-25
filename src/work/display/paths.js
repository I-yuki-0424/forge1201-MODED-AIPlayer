'use strict';
// How long a bot's path is drawn (owner 2026-11-25, list 5 Small 1: "the route display is temporary and disappears at once: keep drawing it as long as it is valid").
// A path is valid while the bot walks it: from the walk phase that planned it until the bot is at its end, has left it, or has not got further along it for a long time
// (or the bot stops working, or a newer path replaces it: service/display.js). Before this a path was dropped 25 s after it was planned, mid-walk on a long way, and its
// pieces were keyed by where they lay, so the first piece was killed and summoned again at every cell. Pure: the state lives on the path object.
//   path = { cells: [[x, y, z], ...], at, serial, idx?, gainAt?, offAt? }   idx = the cell the bot has reached (it only grows)

const REACH = 0.75;         // blocks (X-Z) from a cell's centre that count as being in it (feet within 1.25 of its y: a step, a jump)
const WINDOW = 12;          // cells ahead of idx that are searched for the bot (a replanned shortcut or a fall skips a few)
const OFF_DIST = 4;         // farther than this from every cell of the window: off the path ...
const OFF_MS = 3000;        // ... for this long: the path is no longer the bot's
const STALL_MS = 90000;     // no progress along the path for this long: the walk has ended without a new phase (waiting, working beside it)
const MAX_MS = 15 * 60000;  // a hard ceiling

const centre = (c) => [c[0] + 0.5, c[1], c[2] + 0.5];
const dist = (c, p) => { const [x, y, z] = centre(c); return Math.hypot(x - p.x, y - p.y, z - p.z); };
const at = (c, p) => { const [x, y, z] = centre(c); return Math.hypot(x - p.x, z - p.z) <= REACH && Math.abs(y - p.y) <= 1.25; };

/**
 * Move the path's progress to where the bot is and say whether it is still valid. `pos` is the bot's position, `now` the clock.
 * Returns { valid, idx, why } (why: arrived, off, stalled, old, empty).
 */
function advance(path, pos, now = Date.now()) {
    const n = path && Array.isArray(path.cells) ? path.cells.length : 0;
    if (!n || !pos) return { valid: false, idx: 0, why: 'empty' };
    if (now - (path.at || now) > MAX_MS) return { valid: false, idx: path.idx || 0, why: 'old' };
    if (path.idx === undefined) { path.idx = 0; path.gainAt = path.at || now; }
    let best = Infinity, bi = -1;
    for (let j = path.idx; j < Math.min(n, path.idx + WINDOW); j++) { const d = dist(path.cells[j], pos); if (d < best) { best = d; bi = j; } }
    if (bi > path.idx && at(path.cells[bi], pos)) { path.idx = bi; path.gainAt = now; }
    if (best > OFF_DIST) { if (path.offAt === undefined) path.offAt = now; } else path.offAt = undefined;
    if (path.idx >= n - 1 && at(path.cells[n - 1], pos)) return { valid: false, idx: path.idx, why: 'arrived' };
    if (path.offAt !== undefined && now - path.offAt > OFF_MS) return { valid: false, idx: path.idx, why: 'off' };
    if (now - path.gainAt > STALL_MS) return { valid: false, idx: path.idx, why: 'stalled' };
    return { valid: true, idx: path.idx, why: null };
}

/**
 * The runs of a whole path (straight stretches, shapes.runs) with the cell index each one starts and ends at, computed once per path. The display shows the runs that are
 * still ahead, the first one cut at the bot's cell, so a run keeps its identity (and its entity) from the moment it is drawn until the bot has passed it.
 */
function runsOf(path) {
    if (path.__runs) return path.__runs;
    const out = [], cs = path.cells;
    let start = 0, dir = null;
    for (let i = 1; i < cs.length; i++) {
        const p = cs[i - 1], q = cs[i], d = [Math.sign(q[0] - p[0]), Math.sign(q[1] - p[1]), Math.sign(q[2] - p[2])];
        if (dir && d[0] === dir[0] && d[1] === dir[1] && d[2] === dir[2]) { out[out.length - 1].j = i; continue; }
        start = i - 1; dir = d; out.push({ i: start, j: i });
    }
    Object.defineProperty(path, '__runs', { value: out, enumerable: false });
    return out;
}

/** The runs still ahead of cell `idx`: [{ n (run number, its identity), i, j }] with i clipped to idx. */
function runsAhead(path, idx) {
    return runsOf(path).map((r, n) => ({ n, i: Math.max(r.i, idx), j: r.j })).filter((r) => r.j > r.i);
}

module.exports = { advance, runsOf, runsAhead, REACH, OFF_MS, STALL_MS, MAX_MS };
