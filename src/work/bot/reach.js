'use strict';
// Getting a bot next to a container it cannot simply walk to (owner 2026-11-09). Every chest the work layer uses stands somewhere: in another layer (a pit is 200 deep and the
// Ender chests stood on its floor: the live log was full of `take ... unreachable` and `janitor_failed reach block`) or farther than a move_to can see (view distance 4).
// The caller has already decided that the container is USABLE (sites.js: within 10 chunks, same dimension); this only brings the bot to it.
const REACH_DY = 12;           // a container this many levels above or below the bot is not walked to (the planner would search for a minute and fail)
const FAR = 40;                // farther than this across: a walk in legs first (travel.js), a plain move_to does not see the chunk

/**
 * Null when the bot can go on with the command (it walks the last blocks itself), else a failure {ok: false, reason, detail}.
 * `strict` (default): without a way to change layer a chest far above or below is a failure (a script passes over it); otherwise the command is left to try the walk.
 * `env`: here(), travel(to, opts) (long walks), lift(cell, opts) (the server puts the bot on a standable cell near the container: a layer change that cannot be walked).
 */
async function approach(env, chest, opt = {}) {
    // Take a turn first (queue.js): one bot at a time walks to a container, the others wait where they are; a turn that does not come in time is a failure like an unreachable chest.
    if (env && env.reserve) {
        const q = await env.reserve(chest);
        if (q) return { ...q, detail: { ...(q.detail || {}), why: `waiting in line for the container: ${(q.detail && q.detail.why) || q.reason}` } };
    }
    const r = await walkTo(env, chest, opt);
    if (r && env && env.release) env.release(chest);
    return r;
}

async function walkTo(env, chest, { why = 'to a container', strict = true } = {}) {
    if (!env || typeof env.here !== 'function') return null;
    const h = env.here(), d = Math.hypot(chest.x - h.x, chest.z - h.z);
    if (Math.abs(chest.y - h.y) <= REACH_DY && d <= FAR) return null;
    // Far across: a walk in legs first. Inside a deep pit the legs often fail (no surface to walk on): then the server puts the bot next to the container, as it does for another layer
    // (the chest is inside the loaded area when it is within 4 chunks; farther, the lift finds no standable cell and says so).
    let walked = true;
    if (d > FAR && env.travel) {
        const t = await env.travel({ x: chest.x, z: chest.z }, { near: 24 });
        if (!t.ok) {
            if (['died', 'disconnected', 'cancelled'].includes(t.reason) || !env.lift) return { ok: false, reason: t.reason || 'unreachable', detail: { ...(t.detail || {}), why: `the walk to the container failed (${t.reason})`, stage: 'approach' } };
            walked = false;
        }
    }
    const dy = Math.abs(chest.y - env.here().y);
    if (dy > REACH_DY || !walked) {
        if (!env.lift) return strict ? { ok: false, reason: 'unreachable', detail: { why: `the container is ${dy} levels away and there is no way to change layer`, stage: 'approach' } } : null;      // strict: skip a chest that cannot be reached; else let the command try on foot
        const l = await env.lift({ x: chest.x, y: chest.y, z: chest.z }, { radius: 4, down: 1, up: 2, purpose: 'job', why });
        if (!l.ok) return { ok: false, reason: l.reason || 'unreachable', detail: { ...(l.detail || {}), why: `could not get to the container (${dy} levels away; ${l.reason})`, stage: 'approach' } };
    }
    return null;
}

module.exports = { approach, REACH_DY, FAR };
