'use strict';
// Long walks in legs (owner 2026-11-08: "beyond a certain distance the pathfinder says no path found; if that is not realistic, split the trip like the old
// system: the first leg as long as it can be, decide the next after arriving, as often as needed").
// Why the plain move_to fails far away (read from the code, 2026-11-09): it needs the target's chunk (`blockAt` is null outside the loaded chunks; the work bots
// use view distance 4 = about 56 blocks around them) and the planner gives up after `planNodes` cells (6000 in the work layer). So a far target is not unreachable,
// it is out of sight. A leg ends on a standable cell inside the loaded area toward the target; the chunks around it load while the bot walks, and the next leg is
// chosen from where it stands. A failed leg is tried shorter and to either side before the walk gives up.
// Pure apart from `env.exec` (a command of the action layer) and `env.here`/`env.w` (reads): the tests drive it with a fake world.
const { surface } = require('../../skills/intents');

const LEG = 40;                    // blocks per leg: inside the loaded area (4 chunks = 64 blocks radius, less the offset in the chunk)
const NEAR = 3;                    // a walk ends within this many blocks of the target (the last, exact move_to follows)
const MAX_LEGS = 80;               // 80 legs of 40 = 3,200 blocks
const MAX_DY = 24;                 // a leg ends no more than this far above or below where it starts (no walk down into the pit, no climb of a cliff by the planner's choice)

const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * The standable cells to try for the next leg, best first: the exact target when it is close enough, else points on the straight line at 100 %, 75 %, 50 % and 30 %
 * of the leg length, then to either side of the line (so a lake or a cliff on it is gone round). Each is a surface cell of a loaded column near the heading.
 */
function legCandidates(world, from, to, { leg = LEG } = {}) {
    const d = hd(from, to), out = [], seen = new Set();
    const add = (x, z, why) => {
        x = Math.round(x); z = Math.round(z);
        const y = surface(world, x, z, from.y + 8);
        if (y === null || Math.abs(y - from.y) > MAX_DY) return;
        const k = `${x},${y},${z}`; if (seen.has(k)) return;
        seen.add(k); out.push({ x, y, z, why });
    };
    if (d <= leg) {
        if (Number.isInteger(to.y)) {                                                  // the exact cell, when it can be stood in
            const kind = world.kindAt(to.x, to.y, to.z);
            if (kind !== 'unknown') out.push({ x: to.x, y: to.y, z: to.z, why: 'target' });
        }
        add(to.x, to.z, 'target column');
    }
    const ux = (to.x - from.x) / (d || 1), uz = (to.z - from.z) / (d || 1);
    for (const f of [1, 0.75, 0.5, 0.3]) { const l = Math.min(d, leg) * f; add(from.x + ux * l, from.z + uz * l, `${Math.round(f * 100)} %`); }
    for (const side of [10, -10, 20, -20]) { const l = Math.min(d, leg) * 0.7; add(from.x + ux * l - uz * side, from.z + uz * l + ux * side, `side ${side}`); }
    return out;
}

/**
 * Walk to `to` {x, z, y?} in legs. `env`: exec(name, args) -> {ok, reason, detail}, here() -> feet cell, w (world model), cancel? {cancelled}.
 * Returns {ok: true, legs, walked} or {ok: false, reason, detail: {legs, at, remaining}}; `reason` is the last leg's, or 'stuck' when three legs in a row brought the bot
 * less than 2 blocks closer.
 */
async function travel(env, to, { leg = LEG, near = NEAR, maxLegs = MAX_LEGS } = {}) {
    let legs = 0, slow = 0, last = null;
    const start = env.here();
    for (; legs < maxLegs; legs++) {
        if (env.cancel && env.cancel.cancelled) return { ok: false, reason: 'cancelled', detail: { legs } };
        const here = env.here(), d = hd(here, to);
        if (d <= near) {
            if (Number.isInteger(to.y) && (here.y !== to.y || d > 0.5)) { const r = await env.exec('move_to', { x: to.x, y: to.y, z: to.z }); if (!r.ok) return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), legs, stage: 'last step' } }; }
            return { ok: true, legs, walked: Math.round(hd(start, env.here())) };
        }
        let moved = false;
        for (const c of legCandidates(env.w, here, to, { leg })) {
            const r = await env.exec('move_to', { x: c.x, y: c.y, z: c.z });
            if (r.ok) { moved = true; break; }
            last = { reason: r.reason, detail: r.detail, tried: c };
            if (['died', 'disconnected', 'cancelled'].includes(r.reason)) return { ok: false, reason: r.reason, detail: { legs } };
        }
        if (!moved) return { ok: false, reason: (last && last.reason) || 'unreachable', detail: { ...(last && last.detail ? last.detail : {}), legs, at: env.here(), remaining: Math.round(d), why: 'no leg of any length or side could be walked' } };
        const gained = d - hd(env.here(), to);
        slow = gained < 2 ? slow + 1 : 0;
        if (slow >= 3) return { ok: false, reason: 'stuck', detail: { legs: legs + 1, at: env.here(), remaining: Math.round(hd(env.here(), to)), why: 'three legs in a row brought the bot less than 2 blocks closer' } };
    }
    return { ok: false, reason: 'timeout', detail: { legs, at: env.here(), remaining: Math.round(hd(env.here(), to)), why: `more than ${maxLegs} legs` } };
}

/** The distance beyond which a walk is split (a move_to this far usually fails for want of loaded chunks). */
const FAR = 56;

module.exports = { travel, legCandidates, LEG, NEAR, FAR, MAX_LEGS };
