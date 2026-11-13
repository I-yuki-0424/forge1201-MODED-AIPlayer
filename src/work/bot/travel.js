'use strict';
// Long walks in legs (owner 2026-11-08: "beyond a certain distance the pathfinder says no path found; if that is not realistic, split the trip like the old
// system: the first leg as long as it can be, decide the next after arriving, as often as needed").
// Why the plain move_to fails far away (read from the code, 2026-11-09): it needs the target's chunk (`blockAt` is null outside the loaded chunks; the work bots
// use view distance 4 = about 56 blocks around them) and the planner gives up after `planNodes` cells (6000 in the work layer). So a far target is not unreachable,
// it is out of sight. A leg ends on a standable cell inside the loaded area toward the target; the chunks around it load while the bot walks, and the next leg is
// chosen from where it stands. A failed leg is tried shorter and to either side before the walk gives up.
// Pure apart from `env.exec` (a command of the action layer) and `env.here`/`env.w` (reads): the tests drive it with a fake world.
const { surface } = require('../../skills/intents');
const { reachableAsync } = require('../../skills/planner');
const { standable, swimmable } = require('../../skills/world');

const LEG = 40;                    // blocks per leg: inside the loaded area (4 chunks = 64 blocks radius, less the offset in the chunk)
const NEAR = 3.3;                  // a walk ends within this many blocks of the target (the last, exact move_to follows). 3.3 and not 3: the cells' centres are compared, the bot stands up to 0.7 off its own centre, so 3.3 is within 4 blocks of the target wherever in its cell it stands (acceptance world 1, 2026-11-13: the bot stood 3.16 cells from a target inside a hill, no standing cell near, and the walk went on until it had been dug away to 7)
const MAX_LEGS = 300;              // legs of 15 to 40 blocks (the reach-checked ones are at most 30, a detour is shorter): 2,000 blocks took 80+ (acceptance world 2, 2026-11-13: the way back stopped at 1,600 on the cap). A walk that does not get closer is ended by the `slow` rule, not by this
const MAX_DY = 24;                 // a leg ends no more than this far above or below where it starts (no walk down into the pit, no climb of a cliff by the planner's choice)

const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const DEEP = 10;                   // a leg that ends more than this far below its start is a last resort
const RANGE = 36;                  // radius of the planner's reach used to judge a leg's destination

/**
 * Is the place a descending leg would end in a dead end? The planner's reach from there (drops count one way, so a pit whose walls cannot be climbed is one region) either fills its whole budget or
 * runs out to the edge of the search area: the ground goes on. A reach that stays well inside the area is enclosed: a sinkhole, a ledge over one, a shaft. Acceptance world 1, 2026-11-13: legs went down into
 * a sinkhole 25 across, 17 levels deep, and the walk ended on its floor (twice, two runs); a guard on the depth alone let the first ledge through and trapped the bot there in the test.
 */
async function hasExit(env, c) {
    let r; try { r = await reachableAsync(env.w, { x: c.x, y: c.y, z: c.z }, { maxNodes: 3000, radius: RANGE }); } catch (_) { return true; }
    if (r.cells.length >= 3000) return true;
    const unknown = (x, y, z) => env.w.kindAt(x, y, z) === 'unknown';           // the edge of the loaded chunks is not a wall: the ground may go on beyond it
    return r.cells.some((q) => Math.max(Math.abs(q[0] - c.x), Math.abs(q[2] - c.z)) >= RANGE - 2 || unknown(q[0] + 1, q[1], q[2]) || unknown(q[0] - 1, q[1], q[2]) || unknown(q[0], q[1], q[2] + 1) || unknown(q[0], q[1], q[2] - 1));
}

const COMPASS = ['north', 'east', 'south', 'west'], AXIS = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };

/**
 * Out of an enclosed place (a basin, a sinkhole, a shaft) by digging: stair steps UP toward the target (the `tunnel` instruction, dy +1: a one-block rise per step through whatever is in the way), turning
 * to the next heading when a step is refused, until the reach from where the bot stands is no longer enclosed. Acceptance world 2, 2026-11-13: a basin 12 levels down ended the way back 515 blocks short;
 * no leg from its floor could be walked and the bot had the tools to dig. Returns {ok, steps} or {ok: false, reason, steps}.
 */
async function digOut(env, to, { maxSteps = 60 } = {}) {
    let fails = 0, steps = 0;
    const head = () => { const h = env.here(), dx = to.x - h.x, dz = to.z - h.z; return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? 1 : 3) : (dz > 0 ? 2 : 0); };
    let dir = head();
    while (steps < maxSteps) {
        if (env.cancel && env.cancel.cancelled) return { ok: false, reason: 'cancelled', steps };
        const h = env.here();
        if (await hasExit(env, h)) return { ok: true, steps };
        const r = await env.exec('tunnel', { dir: COMPASS[dir], dy: 1 });
        if (env.trace) env.trace(`dig out ${h.x},${h.y},${h.z} ${COMPASS[dir]}: ${r.ok ? 'ok' : r.reason}`);
        if (r.ok) { steps++; fails = 0; dir = head(); continue; }
        if (['died', 'disconnected', 'cancelled'].includes(r.reason)) return { ok: false, reason: r.reason, steps };
        if (++fails > 8) return { ok: false, reason: r.reason || 'stuck', steps };
        dir = (dir + 1) % 4;
    }
    return { ok: false, reason: 'timeout', steps };
}

/** The cell a leg can end in for the column x,z: the highest standing cell, else the surface of open water (the planner swims to it: a sea is crossed, not given up on). */
function top(world, x, z, cap) {
    const s = surface(world, x, z, cap);
    if (s !== null) return s;
    for (let y = Math.min(cap, 318); y > -64; y--) {
        const k = world.kindAt(x, y, z);
        if (k === 'unknown') return null;
        if (swimmable(world, x, y, z)) return y;
        if (k === 'solid') return null;
    }
    return null;
}

/**
 * The standable cells to try for the next leg, best first: the exact target when it is close enough, else points on the straight line at 100 %, 75 %, 50 % and 30 %
 * of the leg length, then to either side of the line (so a lake or a cliff on it is gone round). Each is a surface cell of a loaded column near the heading.
 */
function legCandidates(world, from, to, { leg = LEG, reach = null, visited = null } = {}) {
    const d = hd(from, to), out = [], seen = new Set();
    // On the surface a leg ends on the TRUE top of the column. The old rule (the highest standing cell at or below from.y + 8) was made for working underground and, on a hillside, returned the first
    // standable cell below the cap: a cave 28 levels under the ridge, 'unreachable' after 20,000 planner nodes (acceptance world 1, 2026-11-12: a 2000-block walk ended at 790). Underground
    // (the bot stands more than 2 cells below the top of its own column) the cap stays.
    const here = top(world, from.x, from.z, 318), onSurface = here !== null && here - from.y <= 2;
    const add = (x, z, why) => {
        x = Math.round(x); z = Math.round(z);
        const y = onSurface ? top(world, x, z, 318) : surface(world, x, z, from.y + 8);
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
    // With the planner's own reach (what it can walk to from here, inside the loaded area): the cells it cannot walk to are dropped (a goal 17 levels up a cliff cost 20,000 planner nodes and ended the walk),
    // and the FRONTIER of the reach is offered: the reachable cells nearest to the target that are not in a place the bot has already been (a cliff or a lake across the line is gone round, a dead end is
    // not walked into twice). Only the legs are chosen this way; the walking itself is the same move_to.
    if (!reach || reach.cells.length < 30) return out;
    const ok = out.filter((c) => hd(c, from) > 34 || reach.has(c.x, c.y, c.z));            // beyond the radius the search covered nothing is known: those stay
    const cell = (c) => `${Math.floor(c[0] / 8)},${Math.floor(c[2] / 8)}`, been = (c) => !!visited && visited.has(cell(c));
    const far = reach.cells.filter((c) => Math.hypot(c[0] - from.x, c[2] - from.z) >= 10 && Math.abs(c[1] - from.y) <= MAX_DY && (standable(world, c[0], c[1], c[2]) || swimmable(world, c[0], c[1], c[2])));
    const score = (c) => hd({ x: c[0], z: c[2] }, to) + (been(c) ? 30 : 0);
    const best = far.slice().sort((a, b) => score(a) - score(b)), picked = [], near = (c) => picked.some((p) => Math.hypot(p[0] - c[0], p[2] - c[2]) < 8);
    for (const c of best) { if (!near(c)) picked.push(c); if (picked.length >= 4) break; }
    for (const c of picked) if (!seen.has(`${c[0]},${c[1]},${c[2]}`)) ok.push({ x: c[0], y: c[1], z: c[2], why: 'frontier' });
    return ok;
}

/**
 * Walk to `to` {x, z, y?} in legs. `env`: exec(name, args) -> {ok, reason, detail}, here() -> feet cell, w (world model), cancel? {cancelled}.
 * Returns {ok: true, legs, walked} or {ok: false, reason, detail: {legs, at, remaining}}; `reason` is the last leg's, or 'stuck' when three legs in a row brought the bot
 * less than 2 blocks closer.
 */
async function travel(env, to, { leg = LEG, near = NEAR, maxLegs = MAX_LEGS } = {}) {
    let legs = 0, slow = 0, last = null;
    const start = env.here(), visited = new Set(), mark = (p) => visited.add(`${Math.floor(p.x / 8)},${Math.floor(p.z / 8)}`);
    mark(start);
    let best = hd(start, to);                                          // the closest the walk has been to the target
    for (; legs < maxLegs; legs++) {
        if (env.cancel && env.cancel.cancelled) return { ok: false, reason: 'cancelled', detail: { legs } };
        if (env.wrongDim && env.wrongDim()) return { ok: false, reason: 'wrong_dimension', detail: { legs, why: 'the bot is not in the dimension of the target (a respawn): the coordinates are not this dimension\'s' } };
        const here = env.here(), d = hd(here, to);
        if (d <= near) {
            if (Number.isInteger(to.y) && (here.y !== to.y || d > 0.5)) { const r = await env.exec('move_to', { x: to.x, y: to.y, z: to.z }); if (!r.ok) return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), legs, stage: 'last step' } }; }
            return { ok: true, legs, walked: Math.round(hd(start, env.here())) };
        }
        let moved = false;
        let reach = null; try { reach = await reachableAsync(env.w, { x: here.x, y: here.y, z: here.z }, { maxNodes: 3000, radius: 36 }); } catch (_) { /* a world without the readers: the straight-line candidates only */ }
        // Legs that go down more than DEEP levels are tried last: a sinkhole or a ravine lies across the line far more often than a cliff worth descending, and what is entered is left only by digging
        // (acceptance world 1, 2026-11-13: the 50 % leg went 17 levels into a crater, the frontier legs then wandered its floor; the same crater on three runs).
        const cands = legCandidates(env.w, here, to, { leg: reach ? Math.min(leg, 30) : leg, reach, visited }).map((c, i) => ({ c, i, deep: c.y < here.y - DEEP })).sort((a, b) => (a.deep - b.deep) || (a.i - b.i)).map((q) => q.c);
        for (const c of cands) {          // with the reach known a leg stays inside the area it was checked in
            if (c.y < here.y - 1 && !(await hasExit(env, c))) {
                last = { reason: 'unreachable', detail: { why: 'a dead end (a pit or a ledge over one): the ground does not go on from there' }, tried: c };
                if (env.trace) env.trace(`leg ${legs} ${here.x},${here.y},${here.z} -> ${c.x},${c.y},${c.z} (${c.why}) skipped: a dead end`);
                continue;
            }
            const r = await env.exec('move_to', { x: c.x, y: c.y, z: c.z });
            if (r.ok) { moved = true; if (env.trace) env.trace(`leg ${legs} ${here.x},${here.y},${here.z} -> ${c.x},${c.y},${c.z} (${c.why}) now ${JSON.stringify(env.here())}`); break; }
            if (env.trace) env.trace(`leg ${legs} ${here.x},${here.y},${here.z} -> ${c.x},${c.y},${c.z} (${c.why}) ${r.reason}`);
            last = { reason: r.reason, detail: r.detail, tried: c };
            if (['died', 'disconnected', 'cancelled'].includes(r.reason)) return { ok: false, reason: r.reason, detail: { legs } };
        }
        if (!moved && env.exec && !(await hasExit(env, here))) {                 // enclosed: no leg can leave it on foot; dig a staircase up and go on from the rim
            const d = await digOut(env, to);
            if (d.ok && d.steps > 0) { mark(env.here()); continue; }
        }
        if (!moved) return { ok: false, reason: (last && last.reason) || 'unreachable', detail: { ...(last && last.detail ? last.detail : {}), legs, at: env.here(), remaining: Math.round(d), why: 'no leg of any length or side could be walked' } };
        const fresh = !visited.has(`${Math.floor(env.here().x / 8)},${Math.floor(env.here().z / 8)}`);
        mark(env.here());
        const rem = hd(env.here(), to);
        if (rem < best - 2) { best = rem; slow = 0; }                         // a new closest point: the walk goes on
        else slow += fresh ? 0.25 : 1;                                        // a leg into ground the bot has not been on is exploring (round a ridge): twelve of them without a new closest point, or three on old ground, are stuck
        if (slow >= 3 && env.exec && !(await hasExit(env, env.here()))) {         // the same, when the legs wander inside an enclosure without a way out
            const d = await digOut(env, to);
            if (d.ok && d.steps > 0) { slow = 0; mark(env.here()); continue; }
        }
        if (slow >= 3) return { ok: false, reason: 'stuck', detail: { legs: legs + 1, at: env.here(), remaining: Math.round(hd(env.here(), to)), why: 'no new closest point to the target for several legs (twelve into new ground, three over old)' } };
    }
    return { ok: false, reason: 'timeout', detail: { legs, at: env.here(), remaining: Math.round(hd(env.here(), to)), why: `more than ${maxLegs} legs` } };
}

/** The distance beyond which a walk is split (a move_to this far usually fails for want of loaded chunks). */
const FAR = 56;

module.exports = { travel, legCandidates, LEG, NEAR, FAR, MAX_LEGS };
