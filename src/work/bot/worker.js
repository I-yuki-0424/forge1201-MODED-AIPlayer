'use strict';
// One pure bot: claim units from the crew ledger, run them with the action layer, report. No decisions, no LLM, no learner
// (docs/proposed/WORKERS-v1.md). The loop is the same for every job kind; the job supplies `runUnit`.
const janitor = require('./janitor');

const MAX_BAD_STREAK = 12;     // consecutive failed units (each after a fix and a wait) before a bot cools down; the service brings it back
const BOT_NEEDS = new Set(['missing_tool', 'missing_item']);       // waiting for the operator, not a fault to retry
const AUDIT_EVERY = 5;         // units between two looks at whether the finished part of the range still matches (job.audit)
const HANDLER_TRIES = 10;      // runs of a recovery script for one reason in a row (reset by a finished unit) before the bot waits for the operator
/** Seconds between attempts after the n-th failure in a row: 3, 5, 8, 12, 20, then 30. Problems of the world or the server often pass by themselves. */
const backoffMs = (n) => [1000, 1000, 2000, 2000, 3000, 5000][Math.min(n, 6) - 1];      // owner 2026-11-07: retry much sooner (was 3, 5, 8, 12, 20, 30 s)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param job     { ledger, runUnit(regionId, unit, env) } (createPitJob, createBuildJob)
 * @param id      the bot's name in the ledger
 * @param env     { exec(name, args), w, have(item), inv(), here(), pos() -> {x,z}, now() -> ms }
 * @param opts    { cancel, policy (janitor), pollMs, batch, onEvent, handlers: { missing_tool: script, ... }, scriptEnv: () => extra env for scripts (sites, policy, box) }
 * @returns       { ended: 'finished' | 'cancelled' | 'died' | 'disconnected', units, failed }
 */
async function runWorker(job, id, env, { cancel = { cancelled: false }, policy = null, pollMs = 500, batch = 1, onEvent = () => {}, backoff: backoffOpt, handlers = null, scriptEnv = null } = {}) {
    const backoff = backoffOpt || backoffMs;
    const tries = {};
    // A recovery script (work/script.js) for what the bot lacks, run before it gives up and waits for the operator.
    const recover = async (reason) => {
        const sc = handlers && handlers[reason];
        if (!sc || (tries[reason] = (tries[reason] || 0) + 1) > HANDLER_TRIES) return false;
        const senv = Object.assign(Object.create(env), scriptEnv ? scriptEnv() : {});
        senv.leavePit = (box) => require('./exit').leavePit(senv, box);
        let out; try { out = await require('./script').runScript(sc, senv, { cancel }); } catch (e) { out = { ok: false, ended: 'error', reason: String(e.message).slice(0, 80), steps: 0, log: [] }; }
        onEvent('script', { id, name: sc.name, reason, ended: out.ended, ok: out.ok, steps: out.steps, log: out.log });
        return out.ok;
    };
    const L = job.ledger, now = env.now || Date.now;
    let units = 0, failed = 0, idle = 0, streak = 0, sinceAudit = AUDIT_EVERY, finalAudits = 0;
    // Is the assigned range still what it should be? Finished units with a leftover or a stray block go back to pending (pit.audit).
    const audit = (full) => {
        if (!job.audit) return 0;
        try {
            const a = job.audit(env, now(), full ? { full: true } : {});
            if (a.reopened.length || a.gaveUp.length) onEvent('audit', { id, checked: a.checked, reopened: a.reopened.length, gaveUp: a.gaveUp.length, first: (a.reopened[0] || a.gaveUp[0]) });
            return a.reopened.length;
        } catch (e) { onEvent('audit_failed', { id, reason: String(e.message).slice(0, 80) }); return 0; }
    };
    L.join(id);
    const hb = setInterval(() => L.heartbeat(id, now()), Math.max(1000, L.leaseMs / 3));
    // Wait in slices so that a cancel is seen within a second.
    const wait = async (ms) => { for (let t = 0; t < ms && !cancel.cancelled; t += 500) await sleep(Math.min(500, ms - t)); };
    try {
        while (!cancel.cancelled) {
            if (sinceAudit >= AUDIT_EVERY) { sinceAudit = 0; audit(false); }
            const claim = L.claim(id, env.pos(), now(), { batch });
            if (!claim) {
                // Before the job is called finished, look at the whole range once more (a few rounds at most): what is wrong goes back to work.
                if (L.finished() && finalAudits < 3 && ++finalAudits && audit(true)) continue;
                if (L.finished()) { if (job.cleanup) await job.cleanup(env); return { ended: 'finished', units, failed }; }
                // The next layer waits for units other bots are still running; if nobody is running anything, nothing will change.
                if (L.progress().leased === 0 && ++idle > 20) { L.leave(id, now()); return { ended: 'stalled', units, failed }; }
                await sleep(pollMs);
                continue;
            }
            idle = 0;
            for (const u of claim.units) {
                if (cancel.cancelled) { L.leave(id, now()); return { ended: 'cancelled', units, failed }; }
                // A bot that fell into water: to the surface and the shore first, then stop the water (work/water.js).
                if (job.rescue && env.inWater && env.inWater()) {
                    const rr = await job.rescue(env, 'in_water'); onEvent('rescue', { id, ok: rr.ok, reason: rr.reason, filled: rr.filled, surfaced: rr.surfaced });
                    if (!rr.ok && (rr.reason === 'died' || rr.reason === 'disconnected')) { L.leave(id, now()); return { ended: rr.reason, units, failed }; }
                }
                // Attacked while working: kill what attacks (defensive only, guard.js), then work on. Temporary blocks still standing go first.
                if (env.threat && env.defend && env.threat()) { const d = await env.defend(); onEvent('defend', { id, ...d }); if (d.ended === 'died' || d.ended === 'disconnected') { L.leave(id, now()); return { ended: d.ended, units, failed }; } }
                if (env.temp && env.temp.size) { try { const n = await require('./moves').cleanTemp(env); if (n) onEvent('temp_cleaned', { id, n }); } catch (_) { /* tried again at the next unit */ } }
                if (policy) {
                    const m = await janitor.maintain(env, policy);        // a stalled janitor must not stall the job: log, carry on
                    if (!m.ok) onEvent('janitor_failed', { id, reason: m.reason, detail: m.detail });
                }
                const t0 = now();
                const r = await job.runUnit(claim.region, u, env);
                onEvent('unit', { id, region: claim.region, unit: u.unit, role: claim.role, ok: r.ok, reason: r.reason, ms: now() - t0, detail: r.detail });
                sinceAudit++;
                if (r.ok) { L.done(id, claim.region, u.unit, now()); units++; streak = 0; for (const k of Object.keys(tries)) tries[k] = 0; if (env.rememberGood) env.rememberGood(); continue; }
                failed++; sinceAudit = AUDIT_EVERY;                // a failure is the moment to check that the range is what it should be
                L.fail(id, claim.region, u.unit, r.reason, now(), r.detail);
                if (r.reason === 'died' || r.reason === 'disconnected') { L.leave(id, now()); return { ended: r.reason, units, failed }; }
                for (const rest of claim.units) if (rest.unit > u.unit) L.fail(id, claim.region, rest.unit, 'cancelled', now());   // back to the pool, not counted
                // Stopped by an attack (not by the operator): fight, then claim again; this is neither a failure of the unit nor a bad streak.
                if (r.reason === 'cancelled' && !cancel.cancelled && env.defend) {
                    const d = await env.defend(); onEvent('defend', { id, ...d });
                    if (d.ended === 'died' || d.ended === 'disconnected') { L.leave(id, now()); return { ended: d.ended, units, failed }; }
                    break;
                }
                if (BOT_NEEDS.has(r.reason) && await recover(r.reason)) break;       // solved by a script (a tool from the tools chest, one crafted): claim again
                if (BOT_NEEDS.has(r.reason)) { L.leave(id, now()); return { ended: 'unhealthy', units, failed, last: r.reason }; }   // it needs a tool or an item: the service waits for it
                streak++;
                if (streak >= MAX_BAD_STREAK) { L.leave(id, now()); return { ended: 'unhealthy', units, failed, last: r.reason }; }
                // Basic fixes before the next try: the ladder (wait / jump / sidestep / back to where it last worked) and a pause of a few seconds.
                onEvent('recover', { id, streak, reason: r.reason });
                if (job.rescue) { try { const rr = await job.rescue(env, r.reason); if (rr.filled || rr.surfaced) onEvent('rescue', { id, ok: rr.ok, reason: rr.reason, filled: rr.filled, surfaced: rr.surfaced }); } catch (_) { /* a failed rescue is not a failed unit */ } }
                if (env.recover) { try { await env.recover(streak + 1, r); } catch (_) { /* a failed fix is not a failed unit */ } }
                await wait(backoff(streak));
                break;
            }
        }
        L.leave(id, now());
        if (job.cleanup) await job.cleanup(env);
        return { ended: 'cancelled', units, failed };
    } finally { clearInterval(hb); if (env.dispose) env.dispose(); }
}

module.exports = { runWorker, backoffMs, MAX_BAD_STREAK };
