'use strict';
// Leaving a pit (owner 2026-11-06). The old way was a staircase left standing along the edge (the haul road); the new way leaves nothing
// behind: stand at the edge of the box at the depth the bot works at, stack low-value blocks and break the one two below the feet while
// rising (moves.js pillar), step out onto the ground, take the last block away. A road, if the job has one, is simply walked first.
const { lineCells } = require('../jobs/pit');
const { finishPillar } = require('./moves');

const solid = (w, x, y, z) => w.kindAt(x, y, z) === 'solid';
const air = (w, x, y, z) => w.kindAt(x, y, z) === 'air';
const standable = (w, c) => solid(w, c.x, c.y - 1, c.z) && air(w, c.x, c.y, c.z) && air(w, c.x, c.y + 1, c.z);

/** The four sides of the box as { cell (inside, on the edge, at the bot's z or x), out: (x, z) just outside it }, nearest side first. */
function sides(box, f) {
    const clampX = Math.min(box.x1, Math.max(box.x0, f.x)), clampZ = Math.min(box.z1, Math.max(box.z0, f.z));
    const all = [
        { x: box.x0, z: clampZ, ox: box.x0 - 1, oz: clampZ }, { x: box.x1, z: clampZ, ox: box.x1 + 1, oz: clampZ },
        { x: clampX, z: box.z0, ox: clampX, oz: box.z0 - 1 }, { x: clampX, z: box.z1, ox: clampX, oz: box.z1 + 1 },
    ];
    return all.sort((a, b) => Math.abs(a.x - f.x) + Math.abs(a.z - f.z) - Math.abs(b.x - f.x) - Math.abs(b.z - f.z));
}

/**
 * The ground outside the box next to `side`: the highest cell a bot can stand on that is not the top of a tree (the box may start far above the
 * ground, and the ground at the rim is whatever it is: owner 2026-11-07, the old search looked at the box top and found nothing).
 */
function ground(w, box, side) {
    const TREE = /(_leaves|_log|_wood|_vines?|^vine)$/;
    const top = Math.min(319, box.top + 4);
    for (let y = top; y >= box.bottom; y--) {
        if (!standable(w, { x: side.ox, y, z: side.oz })) continue;
        if (TREE.test(String(w.nameAt(side.ox, y - 1, side.oz) || '').replace(/^minecraft:/, ''))) continue;           // a canopy is not the ground
        return { x: side.ox, y, z: side.oz };
    }
    return null;
}

/**
 * Bring the bot out of the pit. `env`: w, here(), exec(name, args), run(name, args) (the work layer's movements), have(item).
 * Returns { ok, how: 'already' | 'walked' | 'pillar', levels?, reason?, detail? }.
 */
async function leavePit(env, box, { corridorMax = 40 } = {}) {
    const f = env.here(), w = env.w;
    const order = sides(box, f);
    const rim = order.map((x) => ground(w, box, x)).filter(Boolean).reduce((m, g) => Math.max(m, g.y), -Infinity);
    if (f.y >= box.top + 1 || (Number.isFinite(rim) && f.y >= rim)) return { ok: true, how: 'already' };
    // 1. A way out on foot (the haul road): the planner finds it or does not.
    for (const s of order.slice(0, 2)) {
        const g = ground(w, box, s);
        if (g) { const m = await env.exec('move_to', g); if (m.ok) return { ok: true, how: 'walked' }; }
    }
    // 2. Pillar up at the edge of the nearest side. First get there at the bot's depth, digging the corridor if the layer is still closed
    // (those cells belong to the pit anyway).
    const s = order[0], g = ground(w, box, s);
    if (!g) return { ok: false, reason: 'unreachable', detail: { why: 'no ground to step onto next to the pit', side: s } };
    const at = { x: s.x, y: f.y, z: s.z };
    let dug = 0;
    for (let tries = 0; tries < corridorMax; tries++) {
        const here = env.here();
        if (here.x === at.x && here.z === at.z) break;
        if (standable(w, at)) { const m = await env.exec('move_to', at); if (m.ok) break; }
        const next = lineCells(here, at, here.y).find((c) => !air(w, c.x, c.y, c.z) || !air(w, c.x, c.y + 1, c.z));
        if (!next) break;
        for (const c of [next, { x: next.x, y: next.y + 1, z: next.z }]) if (!air(w, c.x, c.y, c.z)) {
            let r = await env.exec('mine', { ...c, collect: false });
            if (!r.ok && r.reason === 'missing_tool' && env.run) r = await env.run('mine_hand', { x: c.x, y: c.y, z: c.z });          // no usable tool: by hand, slowly
            if (!r.ok && !air(w, c.x, c.y, c.z)) return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), stage: 'corridor', cell: c } };
            dug++;
        }
        await env.exec('move_to', { x: next.x, y: next.y, z: next.z });
    }
    const here = env.here();
    if (here.x !== at.x || here.z !== at.z) return { ok: false, reason: 'unreachable', detail: { why: 'could not reach the edge of the pit at this depth', at, here, dug } };
    const levels = g.y - here.y;                                    // up to the ground outside, not to the top of the box
    if (levels < 1) return { ok: true, how: 'already' };
    const p = await env.run('pillar', { levels });
    if (!p.ok) return { ok: false, reason: p.reason, detail: { ...(p.detail || {}), stage: 'pillar', levels, dug } };
    const out = ground(w, box, s);
    const m = out && await env.exec('move_to', out);
    if (!m || !m.ok) return { ok: false, reason: (m && m.reason) || 'unreachable', detail: { why: 'could not step off the pillar', top: p.detail && p.detail.top } };
    await finishPillar(env, p.detail && p.detail.last);
    return { ok: true, how: 'pillar', levels, dug };
}

/** Is the bot below the rim of the pit (inside the box's column and lower than the ground around it)? Walking off for trees or chests from there is a climb. */
function inPit(env, box) {
    const f = env.here(), w = env.w;
    if (f.x < box.x0 - 1 || f.x > box.x1 + 1 || f.z < box.z0 - 1 || f.z > box.z1 + 1) return false;
    const rim = sides(box, f).map((x) => ground(w, box, x)).filter(Boolean).reduce((m, g) => Math.max(m, g.y), -Infinity);
    return Number.isFinite(rim) ? f.y < rim - 1 : f.y < box.top;
}

module.exports = { leavePit, inPit, sides, ground, standable };
