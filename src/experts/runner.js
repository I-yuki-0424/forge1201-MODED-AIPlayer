'use strict';
// Runs a trained skill expert on a live bot: observe, ask the policy, execute the chosen command through the action layer, repeat until the bot is at the target, the
// budget is spent, the bot is stopped, or it has made no progress for long enough (docs/implemented/EXPERTS-v1.md). The same loop as the simulator's episode.
const features = require('./features');
const policy = require('./policy');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FATAL = new Set(['died', 'disconnected', 'cancelled']);
const PATIENCE = 25;          // steps without a step of 2 blocks closer: then the policy is sampled instead of followed greedily; the same again: give up
const IMPROVE = 2;

/**
 * `ex`: {model, doc} of the expert; `target` {x,y,z}; `o`: { space (ExpertSpace), exec(name, args) -> result, here() -> feet cell, names, cancel?, maxSteps?, maxMs?, rnd?, onStep? }.
 * Returns { ok, reason?, steps, dist, sampled, thinkMs: think, thinkMaxMs: thinkMax, trace }: reason 'stuck' | 'timeout' | 'cancelled' | 'died' | ... or the failing command's.
 */
async function run(ex, target, o) {
    const doc = ex.model.doc, reach = doc.reach, maxSteps = o.maxSteps || doc.max_steps, maxMs = o.maxMs || 180000, t0 = Date.now(), rnd = o.rnd || Math.random;
    const dist = (c) => Math.sqrt((c.x - target.x) ** 2 + (c.y - target.y) ** 2 + (c.z - target.z) ** 2);
    const progress = new Array(o.progressDim || 26).fill(0);
    let last = { reason: 'ok', ticks: 0 }, best = dist(o.here()), since = 0, sample = 0, stalls = 0, steps = 0, sampled = 0, think = 0, thinkMax = 0;
    const trace = [];
    o.space.setTarget(target);
    for (; steps < maxSteps; steps++) {
        if (o.cancel && o.cancel.cancelled) return { ok: false, reason: 'cancelled', steps, dist: dist(o.here()), sampled, thinkMs: think, thinkMaxMs: thinkMax, trace };
        const here = o.here(), d = dist(here);
        if (d <= reach) return { ok: true, steps, dist: d, sampled, thinkMs: think, thinkMaxMs: thinkMax, trace };
        if (Date.now() - t0 > maxMs) return { ok: false, reason: 'timeout', steps, dist: d, sampled, thinkMs: think, thinkMaxMs: thinkMax, trace };
        if (d < best - IMPROVE) { best = d; since = 0; stalls = 0; sample = 0; } else since++;
        if (since >= PATIENCE) { since = 0; stalls++; if (stalls >= 2) return { ok: false, reason: 'stuck', steps, dist: d, sampled, thinkMs: think, thinkMaxMs: thinkMax, trace }; sample = PATIENCE; }
        const tk = Date.now();
        const obs = o.space.observe(progress, last, new Map(), { frac: 0, step: steps, tod: 0 });
        let pick;
        if (o.decide) pick = o.decide(obs, sample > 0);                     // tests: a stand-in for the network
        else {
            const names = o.names, c = features.ctx(obs, names, doc.rel, doc.anon), { cand, mask } = features.cands(obs, names, doc.rel, doc.anon, doc.actions);
            pick = policy.choose(policy.forward(ex.model, c, cand, mask).logits, mask, { sample: sample > 0, rnd });
        }
        const dt = Date.now() - tk; think += dt; thinkMax = Math.max(thinkMax, dt);
        if (sample > 0) { sample--; sampled++; }
        const cd = o.space.cands[pick];
        if (!cd) { await sleep(200); last = { reason: 'invalid_args', ticks: 1 }; continue; }
        o.space.remember(here);
        let res;
        if (cd.cmd === 'wait') { await sleep((cd.args.ticks || 40) * 50); res = { ok: true, ticks: cd.args.ticks || 40 }; }
        else res = await o.exec(cd.cmd, cd.args);
        last = { reason: res.ok ? 'ok' : res.reason, ticks: Math.max(res.ticks || 1, 1) };
        if (trace.length < 400) trace.push([cd.cmd, res.ok ? 'ok' : res.reason]);
        if (o.onStep) o.onStep({ step: steps, cmd: cd.cmd, args: cd.args, ok: res.ok, reason: res.reason, dist: dist(o.here()) });
        if (!res.ok && FATAL.has(res.reason)) return { ok: false, reason: res.reason, steps: steps + 1, dist: dist(o.here()), sampled, thinkMs: think, thinkMaxMs: thinkMax, trace };
    }
    const d = dist(o.here());
    return d <= reach ? { ok: true, steps, dist: d, sampled, thinkMs: think, thinkMaxMs: thinkMax, trace } : { ok: false, reason: 'timeout', steps, dist: d, sampled, thinkMs: think, thinkMaxMs: thinkMax, trace };
}

module.exports = { run, PATIENCE };
