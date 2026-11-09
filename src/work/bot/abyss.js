'use strict';
// Where the floor is an abyss (owner 2026-11-09: End islands, a Nether lava sea, a dimension nobody has seen). Placing a block and breaking it again never ends there (the block you break is
// the one you stand next to, so the next one must be placed, broken ...), so the method is a BRIDGE: temporary blocks laid out from a safe cell to the cell beside the work, the work,
// then the walk back along the bridge to the safe cell, and the job is done (bridge.js does it; this file only reads the world and plans). The bridge stays; nobody breaks it from the far end.
// Pure: `w` is the world model (kindAt: air | solid | partial | water | liquid | danger | climb | unknown).

const BELOW_MAX = 320;

/**
 * What is under (x, y, z), looking down from the cell below it to `minY`:
 *   floor    a solid (or partial: slab, fence) block at `y` : something to stand on, not an abyss
 *   hazard   lava, fire, a bubble column ... before any floor
 *   water    water before any floor (a drop into water is survivable; it is still not a floor to build on)
 *   unknown  a chunk that is not loaded before any floor: no verdict
 *   abyss    nothing at all down to `minY`: a fall is the end
 */
function below(w, x, y, z, minY) {
    for (let yy = y - 1, n = 0; yy >= minY && n < BELOW_MAX; yy--, n++) {
        const k = w.kindAt(x, yy, z);
        if (k === 'unknown') return { kind: 'unknown', y: yy };
        if (k === 'solid' || k === 'partial') return { kind: 'floor', y: yy };
        if (k === 'danger' || k === 'liquid') return { kind: 'hazard', y: yy };
        if (k === 'water') return { kind: 'water', y: yy };
    }
    return { kind: 'abyss', y: minY };
}

/** Is the cell over an abyss (the bot must not step into it, and must not dig the block under its feet)? */
const over = (w, c, minY) => below(w, c.x, c.y, c.z, minY).kind === 'abyss';

const FREE = new Set(['air', 'climb']);

/** The cells of the walk from `from` to `to`, x first, then z, on `from`'s level; `from` excluded, `to` included. */
function line(from, to) {
    const out = []; let x = from.x, z = from.z;
    while (x !== to.x) { x += Math.sign(to.x - x); out.push({ x, z }); }
    while (z !== to.z) { z += Math.sign(to.z - z); out.push({ x, z }); }
    return out;
}

/**
 * The bridge from a safe feet cell `from` {x, y, z} to the feet cell `to` {x, z} on the same level.
 * Returns { ok: true, path: [{x, z}...], place: [{x, y, z}...] (block cells at y-1 that are air: they get a block), segments: [{dir: [dx, dz], cells: [{x, z}]}], length }
 * or { ok: false, reason, detail } with `reason` from the action layer's taxonomy:
 *   invalid_target  the start has no solid floor, or the level of `to` is not the level of `from`
 *   unreachable     a cell of the way is not loaded, or the bridge would be longer than `maxLen` placed blocks
 *   invalid_target  a cell on the way is blocked (feet or head cell not air), or has lava / water / a fluid in the walking layer
 */
function plan(w, from, to, { maxLen = 40 } = {}) {
    if (!from || !to) return { ok: false, reason: 'invalid_args', detail: { why: 'from and to needed' } };
    if (Number.isInteger(to.y) && to.y !== from.y) return { ok: false, reason: 'invalid_target', detail: { why: `a bridge is level: the start is at y ${from.y}, the end at y ${to.y}` } };
    if (w.kindAt(from.x, from.y - 1, from.z) !== 'solid') return { ok: false, reason: 'invalid_target', detail: { why: 'the start of a bridge needs a solid floor (a safe cell)', cell: { x: from.x, y: from.y - 1, z: from.z } } };
    const path = line(from, to), place = [], segments = [];
    let prev = { x: from.x, z: from.z };
    for (const p of path) {
        const floor = w.kindAt(p.x, from.y - 1, p.z), feet = w.kindAt(p.x, from.y, p.z), head = w.kindAt(p.x, from.y + 1, p.z);
        if (floor === 'unknown' || feet === 'unknown' || head === 'unknown') return { ok: false, reason: 'unreachable', detail: { why: 'the way is not loaded', cell: { x: p.x, y: from.y, z: p.z } } };
        if (!FREE.has(feet) || !FREE.has(head)) return { ok: false, reason: 'invalid_target', detail: { why: `${feet === 'air' ? head : feet} in the way at the walking level`, cell: { x: p.x, y: from.y, z: p.z } } };
        if (floor === 'air') place.push({ x: p.x, y: from.y - 1, z: p.z });
        else if (floor !== 'solid') return { ok: false, reason: 'invalid_target', detail: { why: `${floor} where the bridge must lie`, cell: { x: p.x, y: from.y - 1, z: p.z } } };
        const dir = [p.x - prev.x, p.z - prev.z], last = segments[segments.length - 1];
        if (last && last.dir[0] === dir[0] && last.dir[1] === dir[1]) last.cells.push(p); else segments.push({ dir, cells: [p] });
        prev = p;
    }
    if (place.length > maxLen) return { ok: false, reason: 'unreachable', detail: { why: `${place.length} blocks is more than a bridge of ${maxLen}` } };
    return { ok: true, path, place, segments, length: path.length };
}

/**
 * The feet cells beside a work cell from which it can be reached, nearest to `from` first: the four neighbours of the work cell's column on `from`'s level (feet and head free, or a
 * floor to place). The work cell itself is never a stand cell. `reach`: the largest vertical distance from those feet to the work cell (the eye is 1.6 up).
 */
function standCells(w, work, from, { reach = 3 } = {}) {
    const out = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const c = { x: work.x + dx, y: from.y, z: work.z + dz };
        if (Math.abs(work.y - c.y) > reach) continue;
        if (!FREE.has(w.kindAt(c.x, c.y, c.z)) || !FREE.has(w.kindAt(c.x, c.y + 1, c.z))) continue;
        out.push({ ...c, d: Math.abs(c.x - from.x) + Math.abs(c.z - from.z) });
    }
    return out.sort((a, b) => a.d - b.d).map(({ x, y, z }) => ({ x, y, z }));
}

module.exports = { below, over, line, plan, standCells };
