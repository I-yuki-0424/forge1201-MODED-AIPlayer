'use strict';
// RL-MOVE-v3, the walk: the learned policy decides ONE cell-level action at a time (walk a cell, put a bridge block, pillar up, descend, dig, take its own block back, wait, step aside)
// and the action layer's own commands carry it out (`move_to` one cell, the bridge / pillar / descend moves of work/bot, a blind `mine`). Everything the policy sees comes from the bot's world
// model (view.js), nothing from the simulator; success is judged from where the bot stands. Same call and result shape as experts/route/router.js, so env.travel can use either.
const spec = require('./spec');
const R = require('./rules');
const { observe } = require('./obs');
const P = require('./policy');
const { makeView, packCount } = require('./view');

const { A } = spec;
const FATAL = new Set(['died', 'disconnected', 'cancelled', 'wrong_dimension']);
const MAX_ACROSS = 48, MAX_LEVELS = 30;                    // farther targets are not this policy's business (the grid it was trained on is 40 x 32 x 40)
const feetOf = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y + 1e-3), z: Math.floor(p.z) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The arrival level when the caller gave none: the standable cell of the target column nearest the bot's level. */
function levelOf(w, to, here) {
    if (Number.isInteger(to.y)) return to.y;
    if (Number.isInteger(to.level)) return to.level;
    const v = { code: (x, y, z) => ({ air: 0, climb: 0, solid: 1 }[w.kindAt(x, y, z)] ?? 6) }, ys = [];
    for (let y = here.y + 24; y >= here.y - 24; y--) if (R.standable(v, to.x, y, to.z)) ys.push(y);
    ys.sort((a, b) => Math.abs(a - here.y) - Math.abs(b - here.y));
    return ys.length ? ys[0] : null;
}

/**
 * The cell the bot is standing IN for the policy: its feet cell, unless that cell has no floor while the body rests on ground (a bridge or a dig leaves it on the edge of a block, a
 * few hundredths of a block into the next cell: found live 2026-11-11, the policy saw "nothing under my feet" and waited for good). Then the standable cell its body overlaps most.
 */
function supportCell(env, view) {
    const here = env.here(), bot = env.bot, e = bot && bot.entity;
    if (!e || R.standable(view, here.x, here.y, here.z)) return here;
    const p = e.position, h = 0.3, xs = new Set([Math.floor(p.x - h), Math.floor(p.x + h)]), zs = new Set([Math.floor(p.z - h), Math.floor(p.z + h)]);
    let best = null;
    for (const x of xs) for (const z of zs) {
        if (!R.standable(view, x, here.y, z)) continue;
        const ov = (Math.min(p.x + h, x + 1) - Math.max(p.x - h, x)) * (Math.min(p.z + h, z + 1) - Math.max(p.z - h, z));
        if (!best || ov > best.ov) best = { x, y: here.y, z, ov };
    }
    return best ? { x: best.x, y: best.y, z: best.z } : here;
}

/** Walk the body to the middle of its own cell (a few hundredths of a block off the middle is enough to hang on the edge of the block under it). Up to ~1 s. */
async function recenter(env, c) {
    const bot = env.bot; if (!bot || !bot.entity) return;
    for (let i = 0; i < 14; i++) {
        if (env.cancel && env.cancel.cancelled) break;
        const p = bot.entity.position, dx = c.x + 0.5 - p.x, dz = c.z + 0.5 - p.z, d = Math.hypot(dx, dz);
        if (d < 0.18) break;
        try { await bot.look(Math.atan2(-dx, -dz), 0, true); bot.setControlState('forward', true); await sleep(Math.min(120, Math.max(40, d * 160))); } finally { bot.setControlState('forward', false); }
        await sleep(60);
    }
}

/** Do the action `a` (result row `r` of rules.results). Returns {ok, reason?, detail?}. */
async function perform(env, a, r, here) {
    switch (r.kind) {
        case 'move': return env.exec('move_to', { x: r.pos.x, y: r.pos.y, z: r.pos.z }, { maxTicks: 160 });
        case 'place': {                                                                // a bridge block under the next cell, then onto it (bridge.js: sneak to the edge, place against the side face, step on)
            // The bot may rest on the edge of the cell the policy sees it in (supportCell): the bridge move counts from the cell its body is in, so it first steps onto that cell.
            const F = env.bot && env.bot.entity ? feetOf(env.bot.entity.position) : here, chain = [];
            if (F.x !== here.x || F.z !== here.z) { if (Math.abs(F.x - here.x) + Math.abs(F.z - here.z) !== 1) { const m = await env.exec('move_to', { x: here.x, y: here.y, z: here.z }, { maxTicks: 120 }); if (!m.ok) return m; } else chain.push({ x: here.x, z: here.z }); }
            chain.push({ x: r.cell.x, z: r.cell.z });
            if (env.run) return env.run('bridge', { y: here.y, cells: chain, keep: true });
            return { ok: false, reason: 'refused', detail: { why: 'no bridge move in this environment' } };
        }
        case 'pillar': await recenter(env, here); return env.run ? env.run('pillar', { levels: 1 }) : { ok: false, reason: 'refused' };
        case 'descend': await recenter(env, here); return env.run ? env.run('descend', { levels: 1 }) : { ok: false, reason: 'refused' };
        case 'dig': if (r.cell.x === here.x && r.cell.z === here.z && r.cell.y < here.y) await recenter(env, here);       // the block under the feet: from the middle of its cell, or the body stays on its edge
            return env.exec('mine', { x: r.cell.x, y: r.cell.y, z: r.cell.z, collect: false, blind: true });
        case 'wait': await sleep(250); return { ok: true };
        default: return { ok: false, reason: 'invalid_args', detail: { why: `no executor for ${r.kind}` } };
    }
}

/**
 * Walk to `to` {x, z, y?, level?}. Returns {ok: true, decisions, walked, move3} or {ok: false, reason, detail}, `move3`: {decisions, fails, tool, ms}.
 * `o`: near (default 2), nearY (default 1 for a cell, 8 for a `level`), maxDecisions (default spec.HORIZON), model, onDecision(t, info) (a test hook: may change the world),
 * refuse (false: do not refuse far targets).
 * `env`: w, here(), exec(name, args, opts), run(name, args), cancel?, wrongDim?, bot?, within?, spots?.
 */
async function walk3(env, to, o = {}) {
    const model = o.model || P.defaultModel();
    if (!model) return { ok: false, reason: 'refused', detail: { why: 'no move3 policy file (models/experts/move3.json)' } };
    const start = env.here(), ty = levelOf(env.w, to, start);
    const info = { decisions: 0, fails: 0, tool: 0, ms: 0, model: model.meta && model.meta.name || 'move3' };
    const out = (r) => ({ ...r, move3: info });
    if (ty === null) return out({ ok: false, reason: 'unreachable', detail: { why: 'no cell to stand on in the target column' } });
    if (o.refuse !== false && (Math.hypot(to.x - start.x, to.z - start.z) > MAX_ACROSS || Math.abs(ty - start.y) > MAX_LEVELS)) return out({ ok: false, reason: 'refused', detail: { why: `farther than ${MAX_ACROSS} blocks across or ${MAX_LEVELS} levels: the chunk router's walk` } });
    const near = o.near === undefined ? 2 : o.near, nearY = o.nearY === undefined ? (Number.isInteger(to.level) && !Number.isInteger(to.y) ? 8 : 1) : o.nearY, tgt = { x: to.x, y: ty, z: to.z };
    const maxDec = o.maxDecisions || spec.HORIZON, bot = env.bot || null;
    const st = { pos: start, tgt, near, nearY, pack: packCount(bot), hp: bot && Number.isFinite(bot.health) ? bot.health : spec.MAX_HP, t: 0, since: 0, last: A.WAIT, visits: new Map([[`${start.x},${start.z}`, 1]]) };
    let best = R.dist3(start, tgt), failsRow = 0, planned = 0;
    const tabu = new Map();                                            // action@cell -> the decision until which it is left out (it just failed there)
    const minY = env.profile ? env.profile().minY : -64;
    while (st.t < maxDec) {
        if (env.cancel && env.cancel.cancelled) return out({ ok: false, reason: 'cancelled' });
        if (env.wrongDim && env.wrongDim()) return out({ ok: false, reason: 'wrong_dimension', detail: { why: 'the bot is not in the dimension of the target' } });
        const view = makeView(env), here = supportCell(env, view); st.pos = here;
        if (R.arrived(here, tgt, near, nearY)) return out({ ok: true, decisions: st.t, walked: Math.round(Math.hypot(here.x - start.x, here.z - start.z)) });
        const t0 = Date.now();
        st.pack = packCount(bot); st.hp = bot && Number.isFinite(bot.health) ? bot.health : spec.MAX_HP;
        const res = R.results(view, st, { minY });
        const ban = new Set();
        for (let a = 0; a < spec.NA; a++) { const k = `${a}@${here.x},${here.y},${here.z}`; if (tabu.has(k) && tabu.get(k) > st.t) ban.add(a); }
        const mask = res.map((r) => r.valid);
        const x = observe(view, st), pick = P.act(model, x, mask, ban);
        let a = pick.action;
        if (a < 0) a = pick.action = mask.every((m, i) => !m || ban.has(i)) ? A.WAIT : A.WAIT;          // everything allowed just failed here: wait, the tabu runs out
        planned += Date.now() - t0;
        info.decisions++;
        if (o.onDecision) { try { await o.onDecision(st.t, { here, action: spec.ACTIONS[a], cell: res[a].cell || res[a].pos }); } catch (_) { /* a test hook must not stop a walk */ } }
        const t1 = Date.now(), r = await perform(env, a, res[a], here);
        info.tool += Date.now() - t1;
        if (o.trace) { try { o.trace({ t: st.t, action: spec.ACTIONS[a], from: here, to: env.here(), ok: !!r.ok, reason: r.reason, detail: r.detail, valid: mask.map((m, i) => (m ? spec.ACTIONS[i] : null)).filter(Boolean).join(','), ms: Date.now() - t1 }); } catch (_) { /* a trace must not stop a walk */ } }
        st.t++; st.last = a;
        const after = env.here(), key = `${after.x},${after.z}`;
        st.visits.set(key, Math.min((st.visits.get(key) || 0) + 1, 100));
        const d = R.dist3(after, tgt);
        if (d < best - 0.5) { best = d; st.since = 0; } else st.since++;
        // A reflex (fall, lava: work/bot/reflex.js) takes the body for a moment and stops the command with 'cancelled'; that is not the caller's cancel: wait until the reflex is over, count a failed action.
        if (!r.ok && r.reason === 'cancelled' && !(env.cancel && env.cancel.cancelled) && env.bot && env.bot.__preempt) { for (let i = 0; i < 100 && env.bot.__preempt; i++) await sleep(100); r.reason = 'preempted'; }
        if (!r.ok) {
            info.fails++; failsRow++;
            if (FATAL.has(r.reason)) return out({ ok: false, reason: r.reason, detail: { ...(r.detail || {}), action: spec.ACTIONS[a] } });
            tabu.set(`${a}@${here.x},${here.y},${here.z}`, st.t + 4);
            if (failsRow >= 8) return out({ ok: false, reason: r.reason || 'stuck', detail: { ...(r.detail || {}), why: '8 actions in a row failed', action: spec.ACTIONS[a], at: after } });
        } else failsRow = 0;
        if (st.since >= 60) return out({ ok: false, reason: 'stuck', detail: { why: '60 decisions without getting closer', at: after, remaining: Math.round(d) } });
    }
    info.ms = planned;
    const at = env.here();
    return out({ ok: false, reason: 'timeout', detail: { why: `more than ${maxDec} decisions`, at, remaining: Math.round(R.dist3(at, tgt)) } });
}

module.exports = { walk3, levelOf, perform, supportCell, recenter, MAX_ACROSS, MAX_LEVELS };
