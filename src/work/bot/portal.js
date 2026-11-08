'use strict';
// Walking through a portal on purpose (owner 2026-11-08): the planner treats portal blocks as danger so that a bot never wanders into one (live pit 2026-11-07); a
// route that needs a gate walks to a cell beside it, faces it and keeps `forward` pressed until the server says the dimension changed (a Nether portal takes about four
// seconds standing in it), then goes on out of the exit portal so that the next walk does not start inside a portal block. Experimental.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORTAL = /^(nether_portal|end_portal)$/;

/** Standable cells next to a gate block, nearest to `from` first (the gate's own column excluded). */
function beside(w, gate, from) {
    const out = [];
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const dy of [0, -1, 1]) {
        const c = { x: gate.x + dx, y: gate.y + dy, z: gate.z + dz };
        if (w.kindAt(c.x, c.y, c.z) === 'air' && w.kindAt(c.x, c.y + 1, c.z) === 'air' && w.kindAt(c.x, c.y - 1, c.z) === 'solid') { out.push(c); break; }
    }
    return out.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
}

const inPortal = (env) => { const h = env.here(); return PORTAL.test(String(env.w.nameAt(h.x, h.y, h.z) || '').replace('minecraft:', '')); };

/** Out of a portal block, toward each side in turn (a bot that stands in a portal never crosses: the portal only works for someone who walks in). */
async function leave(env) {
    for (let i = 0; i < 4 && inPortal(env); i++) {
        const h = env.here(), cs = beside(env.w, h, h), target = cs[i % (cs.length || 1)] || { x: h.x + (i === 0 ? 1 : i === 1 ? -1 : 0), y: h.y, z: h.z + (i === 2 ? 1 : i === 3 ? -1 : 0) };
        await env.walkInto(target, { until: () => !inPortal(env), ms: 1500 });
    }
    return !inPortal(env);
}

/**
 * Cross the gate whose portal block is at `gate` {x, y, z}. `env`: exec, here, w, dimension() -> 'overworld' | 'nether' | 'end', walkInto(cell, {until, ms}) -> bool
 * (faces the cell and presses forward until `until()` or the time is up), cancel?. Returns {ok, from, to} or {ok: false, reason, detail}.
 */
async function cross(env, gate, { ms = 20000 } = {}) {
    const from = env.dimension();
    const name = env.w.nameAt ? env.w.nameAt(gate.x, gate.y, gate.z) : null;
    if (name && !PORTAL.test(String(name).replace('minecraft:', ''))) return { ok: false, reason: 'invalid_target', detail: { why: `there is ${name} at ${gate.x} ${gate.y} ${gate.z}, not a portal`, gate } };
    // Not from inside a portal (arriving through one leaves the bot in it): step out first, or it would stand there for good.
    if (inPortal(env) && !(await leave(env))) return { ok: false, reason: 'stuck', detail: { why: 'the bot stands in a portal and could not step out', gate } };
    // Close to the gate: the cell beside it from which the portal block is one step ahead.
    const cells = beside(env.w, gate, env.here());
    let there = false;
    for (const c of cells.slice(0, 3)) { const r = await env.exec('move_to', c); if (r.ok) { there = true; break; } }
    if (!there && Math.hypot(env.here().x - gate.x, env.here().z - gate.z) > 2.5) return { ok: false, reason: 'unreachable', detail: { why: 'no cell beside the gate can be reached', gate } };
    const crossed = await env.walkInto(gate, { until: () => env.dimension() !== from, ms });
    if (!crossed) return { ok: false, reason: 'timeout', detail: { why: `still in ${from} after ${Math.round(ms / 1000)} s in the portal`, gate } };
    // The new chunks first (the portal block cannot be seen before), then out of the exit portal.
    for (let i = 0; i < 40 && env.w.kindAt(env.here().x, env.here().y - 1, env.here().z) === 'unknown'; i++) await sleep(250);
    await sleep(300);
    await leave(env);
    return { ok: true, from, to: env.dimension() };
}

module.exports = { cross, leave, beside, PORTAL };
