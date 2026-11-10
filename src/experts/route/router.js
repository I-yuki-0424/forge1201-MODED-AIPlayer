'use strict';
// Chunk-exit routing, part 4: the walk (owner 2026-11-10; docs/implemented/ROUTE-v1.md). For a target the policy decides, chunk by chunk, where to leave the chunk the bot stands in
// (the entry cell of the next chunk on the straight chunk line, or of a side chunk to go round something); the path calculator (the action layer's `move_to`, A* of
// src/skills/planner.js) makes the route between two such cells. In the destination chunk the policy makes waypoints, one per 3 blocks (rounded down) of the straight-line
// distance to the arrival point. A move that fails is remembered (tabu), the next decision sees it; chunks already walked count, so the bot does not go back and forth.
// Same call and result as travel.js (`env`: exec, here, w, cancel?, wrongDim?), so it can replace it.
const fs = require('fs');
const path = require('path');
const C = require('./candidates');
const F = require('./features');
const P = require('./policy');

const VIA = 10, NEAR = 3, MAX_DECISIONS = 120, PATIENCE = 8, GAIN = 2, MAX_FAILS_ROW = 4;
const FATAL = new Set(['died', 'disconnected', 'cancelled']);
const MODEL_FILE = path.join(__dirname, '..', '..', '..', 'models', 'experts', 'route.json');

let cached = null;
/** The trained policy (models/experts/route.json), or the heuristic when the file is missing. */
function defaultModel() {
    if (cached) return cached;
    try { cached = P.load(JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'))); cached.name = 'rl'; } catch (_) { cached = P.fromVector(P.heuristicVector()); cached.name = 'heuristic'; }
    return cached;
}
const heuristicModel = () => { const m = P.fromVector(P.heuristicVector()); m.name = 'heuristic'; return m; };

const now = () => Number(process.hrtime.bigint()) / 1e6;

/** The arrival level when the caller gave none: the standable cell of the target column nearest the bot's level, or null (not loaded, nothing to stand on). */
function levelOf(w, to, here) {
    if (Number.isInteger(to.y)) return to.y;
    if (Number.isInteger(to.level)) return to.level;                                  // a level to arrive at without a cell to stand in (a chest, a station): no exact last step
    const ys = C.stands(w, to.x, to.z, Math.max(-63, here.y - 24), Math.min(318, here.y + 24)).sort((a, b) => Math.abs(a - here.y) - Math.abs(b - here.y));
    return ys.length ? ys[0] : null;
}

/**
 * Walk to `to` {x, z, y?}. Returns {ok: true, legs, walked, route} or {ok: false, reason, detail: {legs, at, remaining, why}, route}; `route`: {decisions, fails, prepMs, thinkMs, thinkMaxMs, execMs, model}.
 * `to.level`: the level to come to when the target is a block, not a cell (arrival is then within `nearY` levels, default 8, and within `near` across). `o`: near (default 3), nearY, maxDecisions, model (a policy from policy.js; default the trained one), back (allow chunks behind from the start).
 */
async function route(env, to, o = {}) {
    const model = o.model || defaultModel(), near = o.near === undefined ? NEAR : o.near, maxDec = o.maxDecisions || MAX_DECISIONS;
    const mem = { visits: new Map([[C.ckey(C.chunkOf(env.here().x), C.chunkOf(env.here().z)), 1]]), failed: [], prev: null, move: null }, st = { decisions: 0, fails: 0, prepMs: 0, thinkMs: 0, thinkMaxMs: 0, execMs: 0, model: model.name || 'custom', reachNodes: 0 };
    const start = env.here();
    let legs = 0, stalls = 0, failsRow = 0, noGain = 0, best = C.hd(start, to), wp = null, last = null, ty = null;
    const out = (r) => ({ ...r, route: st });
    const fail = (reason, detail) => out({ ok: false, reason, detail: { legs, at: env.here(), remaining: Math.round(C.hd(env.here(), to)), ...detail } });
    while (st.decisions < maxDec) {
        if (env.cancel && env.cancel.cancelled) return out({ ok: false, reason: 'cancelled', detail: { legs } });
        if (env.wrongDim && env.wrongDim()) return out({ ok: false, reason: 'wrong_dimension', detail: { legs, why: 'the bot is not in the dimension of the target (a respawn): the coordinates are not this dimension\'s' } });
        const here = env.here(), d = C.hd(here, to);
        if (ty === null) ty = levelOf(env.w, to, here);
        const vOK = !Number.isInteger(to.level) || Math.abs(here.y - to.level) <= (o.nearY === undefined ? 8 : o.nearY);
        if (wp && wp.left <= 0 && !vOK && d > near) wp = null;                          // every waypoint was walked but the bot is still at the wrong level: a new set
        if (vOK && (d <= near || (wp && wp.left <= 0))) {
            if (Number.isInteger(to.y) && (here.y !== to.y || d > 0.5)) {
                const t0 = now(), r = await env.exec('move_to', { x: to.x, y: to.y, z: to.z }); st.execMs += now() - t0;
                if (!r.ok) return fail(r.reason, { ...(r.detail || {}), stage: 'last step' });
            }
            return out({ ok: true, legs, walked: Math.round(C.hd(start, env.here())) });
        }
        const here0 = env.here();
        const t0 = now();
        const inDest = C.chunkOf(here.x) === C.chunkOf(to.x) && C.chunkOf(here.z) === C.chunkOf(to.z);
        const d3 = ty === null ? d : Math.hypot(d, ty - here.y);                       // the straight-line distance to the arrival point: one waypoint per 3 blocks of it, rounded down
        if (inDest && !wp) wp = { left: C.waypointCount(d3), n: C.waypointCount(d3) };
        let cands;
        if (inDest) {
            const exact = wp.left <= 1 && ty !== null && env.w.kindAt(to.x, ty, to.z) !== 'unknown' && C.stands(env.w, to.x, to.z, ty, ty).length;
            cands = exact ? [{ x: to.x, y: ty, z: to.z, side: 'wp', dir: [0, 0], diag: 0, off: 0 }] : C.waypointCandidates(env.w, here, to, wp.left <= 1 ? 1 : 1 / (wp.left + 1), { ty });
        } else cands = C.exitCandidates(env.w, here, to, { back: stalls >= 2 || !!o.back, ty });
        if (!inDest && !cands.length) cands = C.exitCandidates(env.w, here, to, { back: true, ty });
        if (inDest && !cands.length) cands = C.exitCandidates(env.w, here, to, { back: true, ty });
        if (!cands.length) return fail(last ? last.reason : 'unreachable', { ...(last && last.detail ? last.detail : {}), why: 'no cell to stand on at the border of the chunk toward the target' });
        const reach = await C.reachMap(env.w, here); st.reachNodes += reach.nodes;
        if (!o.noFrontier && (!inDest || (ty !== null && Math.abs(ty - here.y) > 6))) { const have = new Set(cands.map((q) => `${q.x},${q.y},${q.z}`)); for (const q of C.frontierCandidates(reach, here, to, ty)) if (!have.has(`${q.x},${q.y},${q.z}`)) cands.push(q); }
        const built = F.build({ w: env.w, here, to, ty, cands, reach, mem, legs, stalls, failsLeg: failsRow, wp: inDest });
        st.prepMs += now() - t0;
        const t1 = now(), sc = P.scores(model, built.feat, built.ctx, built.cands.length), pick = P.argmax(sc), dt = now() - t1;
        st.thinkMs += dt; st.thinkMaxMs = Math.max(st.thinkMaxMs, dt); st.decisions++;
        const c = built.cands[pick];
        if (o.onDecision) { try { o.onDecision({ here, to, cand: c, mode: inDest ? 'wp' : 'exit', k: built.cands.length, score: sc[pick] }); } catch (_) { /* a log must not stop a walk */ } }
        const t2 = now();
        let r = await env.exec('move_to', { x: c.x, y: c.y, z: c.z });
        // The planner's own search reached this cell, but the walk's search (guided by the straight line, 6,000 cells) did not find it: walk the way the reach search found, in stretches of VIA cells.
        if (!r.ok && !FATAL.has(r.reason) && c.rc !== undefined && reach.path) {
            const way = reach.path(c.x, c.y, c.z); st.via = (st.via || 0) + 1;
            if (way && way.length > 2) {
                r = { ok: true };
                for (let i = VIA; i < way.length + VIA - 1 && r.ok; i += VIA) { const q = way[Math.min(i, way.length - 1)]; r = await env.exec('move_to', { x: q.x, y: q.y, z: q.z }); if (r.ok && Math.min(i, way.length - 1) === way.length - 1) break; }
            }
        }
        st.execMs += now() - t2;
        if (r.ok) {
            const after = env.here(), key = C.ckey(C.chunkOf(after.x), C.chunkOf(after.z)), fresh = !mem.visits.has(key), da = C.hd(after, to);
            mem.move = { x: after.x - here0.x, z: after.z - here0.z }; mem.prev = C.ckey(C.chunkOf(here0.x), C.chunkOf(here0.z)); mem.visits.set(key, (mem.visits.get(key) || 0) + 1); legs++; failsRow = 0;
            if (inDest) wp.left--;
            // A leg that ends in a chunk never seen is exploration (going round a wall gets no closer for a while); one that ends in a chunk already walked and gains nothing is the back and forth.
            if (fresh || da < best - GAIN) noGain = 0; else if (++noGain >= PATIENCE) return fail('stuck', { why: `${PATIENCE} legs in a row ended in chunks already walked, no closer than ${GAIN} blocks` });
            best = Math.min(best, da);
            continue;
        }
        st.fails++; failsRow++; last = { reason: r.reason, detail: r.detail };
        if (FATAL.has(r.reason)) return out({ ok: false, reason: r.reason, detail: { legs } });
        mem.failed.push({ x: c.x, y: c.y, z: c.z });
        if (failsRow >= 2) stalls++;
        if (failsRow >= MAX_FAILS_ROW) return fail(r.reason, { ...(r.detail || {}), why: `${MAX_FAILS_ROW} exits in a row could not be walked`, tried: { x: c.x, y: c.y, z: c.z } });
    }
    return fail('timeout', { why: `more than ${maxDec} decisions` });
}

module.exports = { route, defaultModel, heuristicModel, NEAR };
