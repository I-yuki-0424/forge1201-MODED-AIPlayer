'use strict';
// Water in a pit (owner 2026-11-06). Water is the weak point of every bot of this kind, so the rules are simple and in this order:
//   1. Avoid it: pit units fill fluid before they open a cell (pit.js sealPlan); gather never digs next to water.
//   2. If a bot is in it anyway: go for the surface and the nearest shore, nothing else (`shoreCell`, a breadth-first search through
//      water and air; the action layer's planner swims where it must).
//   3. Then stop it. Water that flows into the pit from OUTSIDE the mining area: plug the inflow, i.e. fill the fluid cells that touch
//      the open cells of the pit. Water whose source is INSIDE the mining area: fill it too, upstream of the face (same level or higher,
//      inside the box), so that it cannot run again; it would be dug out anyway. Fills go against something solid, below first.
// Pure given `env` ({w, here(), exec(name, args), have(item)}), tested without a server (tests/test_work_miner_pure.js).
const { orderFill, isFluid, SEAL_ITEMS } = require('../jobs/pit');

const D6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const wet = (w, x, y, z) => { const k = w.kindAt(x, y, z); return k === 'water' || k === 'liquid'; };
const roomy = (w, x, y, z) => { const k = w.kindAt(x, y, z); return k === 'air' || k === 'climb' || k === 'water' || k === 'liquid'; };
const key = (x, y, z) => `${x},${y},${z}`;

/** The feet or head cell holds water. */
const inWater = (w, f) => wet(w, f.x, f.y, f.z) || wet(w, f.x, f.y + 1, f.z);

/** Nearest cell (by steps) where a player can stand and breathe: air, air above, something solid below. Null when none within `R`. */
function shoreCell(w, f, R = 14) {
    const seen = new Set([key(f.x, f.y, f.z)]); let frontier = [{ x: f.x, y: f.y, z: f.z }];
    for (let d = 0; d <= R * 2 && frontier.length; d++) {
        const hits = frontier.filter((c) => w.kindAt(c.x, c.y, c.z) === 'air' && w.kindAt(c.x, c.y + 1, c.z) === 'air' && w.kindAt(c.x, c.y - 1, c.z) === 'solid');
        if (hits.length) return hits.sort((a, b) => a.y - b.y || (Math.abs(a.x - f.x) + Math.abs(a.z - f.z)) - (Math.abs(b.x - f.x) + Math.abs(b.z - f.z)))[0];
        const next = [];
        for (const c of frontier) for (const [a, b, e] of D6) {
            const n = { x: c.x + a, y: c.y + b, z: c.z + e }, k = key(n.x, n.y, n.z);
            if (seen.has(k) || Math.max(Math.abs(n.x - f.x), Math.abs(n.y - f.y), Math.abs(n.z - f.z)) > R || !roomy(w, n.x, n.y, n.z)) continue;
            seen.add(k); next.push(n);
        }
        frontier = next;
    }
    return null;
}

/**
 * What to fill so that no fluid runs into the open cells of the pit around `centre` (radius `R`, the layers just below and above it):
 * the fluid cells that touch an open cell of the box from the side or from above (the inflow faces), and, for faces inside the box,
 * the fluid upstream of them inside the box (same level or higher), up to `max` cells. Returns { fill: [cells in filling order],
 * unsupported: [cells with nothing solid to start from], outside: n, inside: n }.
 */
function floodPlan(w, box, centre, { R = 8, max = 48 } = {}) {
    const inBox = (x, z) => x >= box.x0 && x <= box.x1 && z >= box.z0 && z <= box.z1;
    const faces = new Map();
    for (let x = centre.x - R; x <= centre.x + R; x++) for (let z = centre.z - R; z <= centre.z + R; z++) {
        if (!inBox(x, z)) continue;
        for (let y = centre.y - 2; y <= centre.y + 3; y++) {
            if (w.kindAt(x, y, z) !== 'air') continue;
            for (const [a, b, e] of D6) {
                if (b === -1) continue;                       // fluid below a cell does not run into it
                const fx = x + a, fy = y + b, fz = z + e;
                if (isFluid(w, fx, fy, fz)) faces.set(key(fx, fy, fz), { x: fx, y: fy, z: fz });
            }
        }
    }
    const want = new Map(faces); let inside = 0, outside = 0;
    for (const f of faces.values()) if (inBox(f.x, f.z)) inside++; else outside++;
    // The source of a face inside the box: the fluid connected to it inside the box, same level or above.
    const queue = [...faces.values()].filter((f) => inBox(f.x, f.z));
    while (queue.length && want.size < max) {
        const c = queue.shift();
        for (const [a, b, e] of D6) {
            if (b === -1) continue;
            const n = { x: c.x + a, y: c.y + b, z: c.z + e }, k = key(n.x, n.y, n.z);
            if (want.has(k) || !inBox(n.x, n.z) || !isFluid(w, n.x, n.y, n.z)) continue;
            want.set(k, n); queue.push(n);
        }
    }
    const o = orderFill(w, [...want.values()].slice(0, max).sort((p, q) => p.y - q.y));   // low cells first: against the floor
    return { ...o, inside, outside };
}

/**
 * The rescue. `box` is the pit's box ({x0,z0,x1,z1,top,bottom}). Returns { ok, surfaced, filled, reason?, detail }; never throws.
 * It is safe to call at any time: with the bot dry and no fluid touching the pit around it, it does nothing and costs one scan.
 */
async function rescue(env, box, { why = null, maxFill = 48 } = {}) {
    const out = { ok: true, surfaced: false, filled: 0, why };
    const exec = env.execFree || env.exec;                // not the unit's cancel token: a bot that is drowning is exactly who needs these commands to run
    try {
        let f = env.here();
        if (inWater(env.w, f)) {
            const shore = shoreCell(env.w, f);
            out.surfaced = true;
            if (shore) { const m = await exec('move_to', shore); if (!m.ok && env.recover) await env.recover(2, m); }
            else if (env.recover) await env.recover(2, { reason: 'in_water' });
            f = env.here();
            // Swimming out did not work (a flooded pit bottom: no shore within reach): the server puts the bot on the nearest dry standable cell (env.lift), up to 14 blocks away.
            if (inWater(env.w, f) && env.lift) { const l = await env.lift(f, { radius: 14, down: 4, up: 12 }); out.lifted = !!l.ok; f = env.here(); }
            if (inWater(env.w, f)) return { ...out, ok: false, reason: 'stuck', detail: { why: 'still in water after the rescue', at: f, shore } };
        }
        for (let round = 0; round < 3; round++) {
            const plan = floodPlan(env.w, box, f, { max: maxFill });
            if (!plan.fill.length) break;
            let item = null;
            for (const c of plan.fill) {
                item = SEAL_ITEMS.find((n) => env.have(n) >= 1);
                if (!item) return { ...out, ok: false, reason: 'missing_item', detail: { why: 'no block to stop the water with', tried: SEAL_ITEMS } };
                const p = await exec('place', { x: c.x, y: c.y, z: c.z, item, fluid: true, temp: 'rescue' });
                if (!p.ok) { if (p.reason === 'died' || p.reason === 'disconnected' || p.reason === 'cancelled') return { ...out, ok: false, reason: p.reason, detail: p.detail }; continue; }
                out.filled++;
            }
            if (!plan.unsupported.length && !floodPlan(env.w, box, f, { max: maxFill }).fill.length) break;
        }
        return out;
    } catch (e) { return { ...out, ok: false, reason: 'internal', detail: { error: String(e && e.message || e).slice(0, 160) } }; }
}

module.exports = { inWater, shoreCell, floodPlan, rescue };
