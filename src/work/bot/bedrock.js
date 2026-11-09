'use strict';
// Breaking bedrock: the BASIC STRUCTURE only (owner 2026-11-09: it is a bug exploit and "quite difficult", so the frame is wanted, not a working machine; WIP).
// What is here and tested: the gates (off by default, only inside a designated range, only real bedrock, never the End's exit fountain), the registry of methods (each says where it
// applies, what it needs and what steps it takes), and a step runner that does the steps with the bot's ordinary commands and checks the block is really gone afterwards.
// What is NOT here: any method. `METHODS` holds one empty sketch, so `breakBedrock` answers `invalid_target` ("no method implemented") until someone writes the steps of a machine
// that is known to work on this server (build it by hand first, on a disposable copy: tools/ and scripts/world/test-up.sh) and fills `steps`. Nothing here is guessed.
// Pure apart from `env` (exec, run, w, have, here): the tests use a fake one.
const dimensions = require('../world/dimensions');

const FORBIDDEN_END = 12;                  // blocks around the exit portal / dragon fountain (0, 0) of the End that are never touched
const STEP_OPS = new Set(['place', 'mine', 'activate', 'wait', 'move_to', 'expect_air', 'expect_block']);

/**
 * METHODS[name] = { doc, status: 'sketch' | 'verified', needs: {item: count}, where(profile, target) -> bool, steps(target) -> [ {op, ...} ] }.
 * A step is {op: 'place', x, y, z, item} | {op: 'mine', x, y, z} | {op: 'activate', x, y, z, sneak?} | {op: 'wait', ticks} | {op: 'move_to', x, y, z}
 *               | {op: 'expect_air', x, y, z} | {op: 'expect_block', x, y, z, block}.
 */
const METHODS = {
    // An empty frame, to show the shape. A real method replaces `steps` and sets status 'verified' once it has worked on a disposable copy of the world.
    sketch: { doc: 'placeholder: no steps', status: 'sketch', needs: {}, where: () => true, steps: () => [] },
};

/** Is `target` bedrock the work layer may be asked to break? {ok: true} or {ok: false, why}. */
function check(env, target, { enabled, range = null, learned = null } = {}) {
    if (!enabled) return { ok: false, why: 'bedrock breaking is off (setting bedrockExploit)' };
    for (const k of ['x', 'y', 'z']) if (!Number.isInteger(target && target[k])) return { ok: false, why: `${k} must be an integer` };
    const dim = target.dim ? dimensions.need(target.dim) : null;
    if (range && !dimensions.contains(range, { ...target, dim: dim || range.dim })) return { ok: false, why: 'the block is outside the designated range' };
    if (!range) return { ok: false, why: 'bedrock is only broken inside a designated range' };
    const P = dimensions.profile(range.dim, learned), name = String(env.w.nameAt(target.x, target.y, target.z) || '').replace(/^minecraft:/, '');
    if (name !== 'bedrock') return { ok: false, why: `there is ${name || 'nothing known'} at ${target.x} ${target.y} ${target.z}, not bedrock` };
    if (P.name === 'end' && Math.hypot(target.x, target.z) <= FORBIDDEN_END) return { ok: false, why: 'the bedrock of the End\'s exit portal is never touched' };
    const inBand = ['lo', 'hi'].some((k) => P.bedrock[k] && target.y >= P.bedrock[k][0] && target.y <= P.bedrock[k][1]);
    if (P.known && !inBand && P.name !== 'end') return { ok: false, why: `bedrock outside the bedrock layers of ${P.name} is somebody's build` };
    return { ok: true, profile: P };
}

/** The first method that applies here (or the named one): {name, method} or null. */
function pick(P, target, name = null) {
    const names = name ? [name] : Object.keys(METHODS);
    for (const n of names) { const m = METHODS[n]; if (m && m.where(P, target)) return { name: n, method: m }; }
    return null;
}

/** Run steps with the bot's ordinary commands; stops at the first one that fails. Returns {ok, done} or {ok: false, reason, detail: {step, index}}. */
async function runSteps(env, steps) {
    let done = 0;
    for (const [index, s] of steps.entries()) {
        if (env.cancel && env.cancel.cancelled) return { ok: false, reason: 'cancelled', detail: { index } };
        if (!s || !STEP_OPS.has(s.op)) return { ok: false, reason: 'invalid_args', detail: { why: `unknown step ${JSON.stringify(s && s.op)}`, index } };
        let r = { ok: true };
        if (s.op === 'place') r = await env.exec('place', { x: s.x, y: s.y, z: s.z, item: s.item });
        else if (s.op === 'mine') r = await env.exec('mine', { x: s.x, y: s.y, z: s.z, collect: false });
        else if (s.op === 'activate') r = await env.exec('activate', { x: s.x, y: s.y, z: s.z, sneak: !!s.sneak });
        else if (s.op === 'move_to') r = await env.exec('move_to', { x: s.x, y: s.y, z: s.z });
        else if (s.op === 'wait') await (env.pause ? env.pause(Math.max(0, Math.min(1200, s.ticks | 0))) : Promise.resolve());
        else if (s.op === 'expect_air') { const n = String(env.w.nameAt(s.x, s.y, s.z) || ''); if (!/^(minecraft:)?(air|cave_air|void_air)$/.test(n)) r = { ok: false, reason: 'not_confirmed', detail: { why: `${n || 'unknown'} still at ${s.x} ${s.y} ${s.z}` } }; }
        else if (s.op === 'expect_block') { const n = String(env.w.nameAt(s.x, s.y, s.z) || '').replace(/^minecraft:/, ''); if (n !== String(s.block).replace(/^minecraft:/, '')) r = { ok: false, reason: 'not_confirmed', detail: { why: `${n || 'unknown'} at ${s.x} ${s.y} ${s.z}, wanted ${s.block}` } }; }
        if (!r.ok) return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), step: s, index } };
        done++;
    }
    return { ok: true, done };
}

/**
 * Break the bedrock at `target` {x, y, z, dim?}. `opt`: { enabled, range (a designated range, world/dimensions.js), method?, learned? }. Returns {ok, detail} like a command.
 * Today it can only refuse: the method list has no working method (see the top of the file).
 */
async function breakBedrock(env, target, opt = {}) {
    const c = check(env, target, opt);
    if (!c.ok) return { ok: false, reason: 'invalid_target', detail: { why: c.why, stage: 'gate' } };
    const m = pick(c.profile, target, opt.method || null);
    if (!m) return { ok: false, reason: 'invalid_target', detail: { why: opt.method ? `no method ${String(opt.method).slice(0, 24)} that applies here` : 'no method applies here', stage: 'method', known: Object.keys(METHODS) } };
    for (const [item, n] of Object.entries(m.method.needs || {})) if (env.have(item) < n) return { ok: false, reason: 'missing_item', detail: { item, need: n, stage: 'stock', method: m.name } };
    const steps = m.method.steps(target);
    if (!steps.length) return { ok: false, reason: 'invalid_target', detail: { why: `the method ${m.name} has no steps yet: no bedrock method is implemented (WIP)`, stage: 'method', method: m.name, status: m.method.status } };
    const r = await runSteps(env, [...steps, { op: 'expect_air', x: target.x, y: target.y, z: target.z }]);
    return r.ok ? { ok: true, reason: null, detail: { method: m.name, steps: r.done } } : { ok: false, reason: r.reason, detail: { ...r.detail, method: m.name, stage: 'steps' } };
}

module.exports = { breakBedrock, check, pick, runSteps, METHODS, STEP_OPS, FORBIDDEN_END };
