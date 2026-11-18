'use strict';
// POSTS (owner 2026-11-18): "once an assignment is decided, keep it and hold the post, unless the bot leaves due to some problem; two bots should not build the same place". The plan is cut into
// one area (zone) per bot (order.js `partition`). A bot takes a free area when it first asks for work and keeps it: it carries the materials for that area only, and builds nothing else
// while the area has work it can do. Another bot's area is touched only when
//   - the bot has no area (more bots than areas), or its own area is finished, or nothing in it was claimable for IDLE_MS (it waits for cells of a neighbouring area: run 1, 2026-11-18, idle 30 to 57 % of the time), and
//   - the unit is at least APART blocks from where the area's keeper is working (a helper stays away from the keeper), unless the keeper has left.
// An area whose keeper has been gone for KEEP_MS goes to the next bot that asks. Pure: the ledger (the units' states, which bots are here) and the plan come in as arguments.
const KEEP_MS = 120000, IDLE_MS = 6000, APART = 14;
const DONE = 2, STUCK = 3;

const makePosts = () => ({ owner: [], of: new Map(), ownAt: new Map(), at: new Map(), fetched: new Map() });

const state = (job) => job.ledger.regions.get('b0').state;
const zoneOf = (plan, u) => plan.zones.ofUnit[u];

/** Is every unit of area z done or parked? */
function finished(plan, job, z) {
    const st = state(job), [a, b] = plan.zones.units[z];
    for (let i = a; i < b; i++) if (st[i] !== DONE && st[i] !== STUCK) return false;
    return true;
}
/** How many units of area z are still to do. */
function remaining(plan, job, z) {
    const st = state(job), [a, b] = plan.zones.units[z]; let n = 0;
    for (let i = a; i < b; i++) if (st[i] !== DONE && st[i] !== STUCK) n++;
    return n;
}
/** Is the bot still here (working, or away for less than KEEP_MS)? */
function present(job, id, now) {
    const b = job.ledger.bots.get(id);
    return !!b && (b.alive || now - b.leftAt < KEEP_MS);
}

/** The area the bot keeps (a number), or -1 when it has none (every area has a keeper that is here, or is finished). The first call decides; later calls return the same area. */
function postOf(plan, job, id, pos, now) {
    const P = job.posts, n = plan.zones.n;
    const z = P.of.get(id);
    if (z !== undefined && z >= 0 && P.owner[z] === id) return z;
    let best = -1, bd = Infinity;
    for (let k = 0; k < n; k++) {
        const o = P.owner[k];
        if ((o !== undefined && o !== null && o !== id && present(job, o, now)) || finished(plan, job, k)) continue;
        const c = plan.zones.centre[k], d = pos ? Math.hypot(c.x - pos.x, c.z - pos.z) : k;
        if (d < bd) { best = k; bd = d; }
    }
    if (best < 0) { P.of.set(id, -1); return -1; }
    P.owner[best] = id; P.of.set(id, best); P.ownAt.set(id, now);
    return best;
}

/** May the bot take unit u now (the posts' part of the gate)? */
function allows(plan, job, u, id, pos, now) {
    const z = zoneOf(plan, u), mine = postOf(plan, job, id, pos, now);
    if (z === mine) return true;
    const P = job.posts;
    if (mine >= 0 && !finished(plan, job, mine) && now - (P.ownAt.get(id) || 0) < IDLE_MS) return false;        // its own area still has work it will be able to do soon
    const k = P.owner[z];
    if (k && k !== id && present(job, k, now)) {                                                                  // the keeper is here: keep away from where it works
        const at = P.at.get(k), c = plan.centre[u];
        if (at && Math.hypot(c.x - at.x, c.z - at.z) < APART) return false;
    }
    return true;
}

/**
 * The order a bot is offered the claimable units: its own area first, bottom-up (of the first few the nearest), then other areas, the one with the most left first, bottom-up. A unit with a
 * floating piece (a seed: placed when nothing else could go, at the top, 20 levels of climbing) comes after the others in either (run 1: one bot spent 8 minutes on one at the very top).
 */
function order(plan, job, cands, { pos, bot }, now = Date.now()) {
    const P = job.posts, mine = postOf(plan, job, bot, pos, now), sd = (u) => (plan.seedUnit[u] ? 1 : 0);
    const own = cands.filter((u) => zoneOf(plan, u) === mine).sort((a, b) => sd(a) - sd(b) || a - b), W = 4;
    if (own.length) P.ownAt.set(bot, now);
    const head = own.filter((u) => !sd(u)).slice(0, W).sort((a, b) => Math.hypot(plan.centre[a].x - pos.x, plan.centre[a].z - pos.z) - Math.hypot(plan.centre[b].x - pos.x, plan.centre[b].z - pos.z));
    const left = (u) => remaining(plan, job, zoneOf(plan, u));
    const foreign = cands.filter((u) => zoneOf(plan, u) !== mine).sort((a, b) => sd(a) - sd(b) || left(b) - left(a) || a - b);
    return [...head, ...own.filter((u) => !head.includes(u)), ...foreign];
}

/** The bot starts working on unit u: where it is (others keep away from it) until the unit ends (a bot that is not working anywhere is not in the way: the key unit of a structure that failed must not
 * wait for 'a distance from its keeper', run 4, 2026-11-18: 230 s). */
function working(plan, job, id, u) { job.posts.at.set(id, plan.centre[u]); }
function resting(job, id) { job.posts.at.delete(id); }

module.exports = { makePosts, postOf, allows, order, working, resting, finished, remaining, present, KEEP_MS, IDLE_MS, APART };
