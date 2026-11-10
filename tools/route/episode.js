'use strict';
// One episode of the routing simulator: a policy (or the legacy walk) takes a bot from the start to the target; the result is what it cost.
const S = require('./sim');
const { route } = require('../../src/experts/route/router');
const P = require('../../src/experts/route/policy');
const { travel } = require('../../src/work/bot/travel');

const MAX_DECISIONS = 60;
/** spec: {type: 'legacy'} | {type: 'vec', vec: number[]} ; episode: {kind, seed}. */
async function runEpisode(spec, ep) {
    const placed = S.place(S.scenario(ep.seed, ep.kind), ep.seed), bot = new S.SimBot(placed), env = bot.env();
    const t0 = process.hrtime.bigint();
    let r, info = {};
    if (spec.type === 'legacy') r = await travel(env, placed.target, { near: 3 });
    else { const m = P.fromVector(Float64Array.from(spec.vec)); r = await route(env, placed.target, { model: m, near: 3, maxDecisions: MAX_DECISIONS }); info = r.route; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6, c = bot.c, rem = Math.hypot(bot.pos.x - placed.target.x, bot.pos.z - placed.target.z);
    const ret = (r.ok ? 600 : -2 * rem) - c.blocks - 25 * c.fail - 0.005 * c.expanded;
    return { kind: ep.kind, seed: ep.seed, ok: !!r.ok, reason: r.reason || null, ret, blocks: c.blocks, calls: c.calls, fail: c.fail, expanded: c.expanded, plans: c.plans, ms, decisions: info.decisions || 0, prepMs: info.prepMs || 0, thinkMs: info.thinkMs || 0, rem, reasons: c.reasons };
}
/** The i-th episode of a set (kinds in turn, seeds spread). */
const episode = (base, i) => ({ kind: S.KINDS[i % S.KINDS.length], seed: base + i * 7919 });

module.exports = { runEpisode, episode, MAX_DECISIONS };
