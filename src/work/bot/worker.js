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
async function runWorker(job, id, env, { cancel = { cancelled: false }, policy = null, pollMs = 500, batch = 1, onEvent = () => {}, backoff: backoffOpt, handlers = null, scriptEnv = null, act: actOpt = null, sub: subOpt = null } = {}) {
    // What the bot is doing right now, named for the page and the health row (claim, unit, janitor, audit, rescue, recover, backoff, idle ...). The environment can refine it (line, lift, chest).
    const act = (name) => { if (actOpt) { try { actOpt(name); } catch (_) { /* a display hook never stops work */ } } };
    if (env && typeof env === 'object') { env.act = act; env.sub = (name) => { if (subOpt) { try { subOpt(name); } catch (_) { /* a display hook never stops work */ } } }; }
    const backoff = backoffOpt || backoffMs;
    const tries = {};
    // A recovery script (work/script.js) for what the bot lacks, run before it gives up and waits for the operator.
    // A handler is a script, or a function of the failed result that picks one (missing_tool: the class of tool the block needs; missing_item: the item that ran out).
    const recover = async (reason, failed) => {
        let sc = handlers && handlers[reason];
        if (typeof sc === 'function') { try { sc = sc(failed); } catch (_) { sc = null; } }
        if (!sc || (tries[`${reason}:${sc.name}`] = (tries[`${reason}:${sc.name}`] || 0) + 1) > HANDLER_TRIES) return false;
        const senv = Object.assign(Object.create(env), scriptEnv ? scriptEnv() : {});
        senv.leavePit = (box) => require('./exit').leavePit(senv, box);
        act('script');
        let out; try { out = await require('./script').runScript(sc, senv, { cancel }); } catch (e) { out = { ok: false, ended: 'error', reason: String(e.message).slice(0, 80), steps: 0, log: [] }; }
        onEvent('script', { id, name: sc.name, reason, ended: out.ended, ok: out.ok, steps: out.steps, log: out.log });
        return out.ok;
    };
    const L = job.ledger, now = env.now || Date.now;
    let farFails = 0;       // units in a row that failed on the way to the work (rejoin, gap, station): the post is out of this bot's reach
    let units = 0, failed = 0, idle = 0, streak = 0, sinceAudit = AUDIT_EVERY, finalAudits = 0, sweepWaits = 0;
    // Is the assigned range still what it should be? Finished units with a leftover or a stray block go back to pending (pit.audit).
    const audit = (full) => {
        if (!job.audit) return 0;
        try {
            const a = job.audit(env, now(), full ? { full: true } : {});
            if (a.reopened.length || a.gaveUp.length) onEvent('audit', { id, checked: a.checked, reopened: a.reopened.length, gaveUp: a.gaveUp.length, first: (a.reopened[0] || a.gaveUp[0]) });
            return a.reopened.length;
        } catch (e) { onEvent('audit_failed', { id, reason: String(e.message).slice(0, 80) }); return 0; }
    };
    // A bot that cannot go on is put back on its feet before it rests or waits (env.goBack: the last place that worked), not left where it stopped.
    const bringBack = async (why) => { if (!env.goBack) return; try { const r = await env.goBack(why); onEvent('sent_back', { id, ok: !!r.ok, reason: r.reason, why }); } catch (_) { /* resting where it stands is the old behaviour */ } };
    L.join(id);
    const hb = setInterval(() => L.heartbeat(id, now()), Math.max(1000, L.leaseMs / 3));
    // Wait in slices so that a cancel is seen within a second.
    const wait = async (ms) => { for (let t = 0; t < ms && !cancel.cancelled; t += 500) await sleep(Math.min(500, ms - t)); };
    try {
        while (!cancel.cancelled) {
            // Not in the dimension of the job (died in the End, back at the bed in the Overworld): the job's coordinates mean nothing here. The worker ends and the service starts it again
            // through the gate (`_enterDim`); nothing is claimed, walked or failed meanwhile (live 2026-11-10: a unit in the Overworld walked toward End coordinates for minutes).
            if (env.wrongDim && env.wrongDim()) { L.leave(id, now()); onEvent('wrong_dimension', { id, have: env.dimension && env.dimension() }); return { ended: 'wrong_dimension', units, failed }; }
            if (sinceAudit >= AUDIT_EVERY) { sinceAudit = 0; act('audit'); audit(false); }
            act('claim');
            const claim = L.claim(id, env.pos(), now(), { batch });
            if (!claim) {
                // The layer gate: the layer above is settled but not read yet: one bot reads every cell of it, what still holds a block goes back to work before the layer below is opened.
                if (L.gate && job.checkLayer) {
                    const ck = L.needCheck(id, now());
                    if (ck) {
                        act('check');
                        let res; try { res = await job.checkLayer(env, ck, now()); } catch (e) { res = { region: ck.region, layer: ck.layer, reopened: 0, error: String(e && e.message || e).slice(0, 80) }; }
                        L.checkDone(id, ck.region, ck.layer, now(), !res.reopened);
                        onEvent('layer_check', { id, ...res });
                        continue;
                    }
                }
                // Before the job is called finished, look at the whole range once more: what is wrong goes back to work. A pit does it chunk by chunk (job.sweep: the bot walks to
                // the chunk, reads it from the top layer down); the others look at what their bot can see (a few rounds at most).
                if (L.finished() && job.sweep) {
                    act('sweep');
                    const sw = await job.sweep(env, now());
                    if (sw.region) {                                                             // the next chunk, or the units that were sent back
                        onEvent('sweep', { id, ...sw });
                        if (sw.reopened || sw.gaveUp) onEvent('audit', { id, checked: sw.checked, reopened: sw.reopened, gaveUp: sw.gaveUp, first: sw.first });       // the same event the periodic check sends: the log, the problem list and the glow listen to it
                        continue;
                    }
                    if (sw.busy && ++sweepWaits < 900) { await sleep(pollMs); continue; }       // another bot is looking at a chunk: it may send units back, be there for them
                } else if (L.finished() && finalAudits < 3 && ++finalAudits && audit(true)) continue;
                if (L.finished()) { if (job.cleanup) await job.cleanup(env); return { ended: 'finished', units, failed }; }
                // The next layer waits for units other bots are still running; if nobody is running anything, nothing will change.
                if (L.progress().leased === 0 && !L.checkBusy(now()) && ++idle > 20) { L.leave(id, now()); return { ended: 'stalled', units, failed }; }
                act('idle');                                    // nothing claimable: the next layer waits for other bots' units, or the units left are on hold after a failure
                await sleep(pollMs);
                continue;
            }
            idle = 0;
            for (const u of claim.units) {
                if (cancel.cancelled) { L.leave(id, now()); return { ended: 'cancelled', units, failed }; }
                // A bot that fell into water: to the surface and the shore first, then stop the water (work/water.js).
                if (job.rescue && env.inWater && env.inWater()) {
                    act('rescue');
                    const rr = await job.rescue(env, 'in_water'); onEvent('rescue', { id, ok: rr.ok, reason: rr.reason, filled: rr.filled, surfaced: rr.surfaced });
                    if (!rr.ok && (rr.reason === 'died' || rr.reason === 'disconnected')) { L.leave(id, now()); return { ended: rr.reason, units, failed }; }
                }
                // Attacked while working: kill what attacks (defensive only, guard.js), then work on. Temporary blocks still standing go first.
                if (env.threat && env.defend && env.threat()) { act('defend'); const d = await env.defend(); onEvent('defend', { id, ...d }); if (d.ended === 'died' || d.ended === 'disconnected') { L.leave(id, now()); return { ended: d.ended, units, failed }; } }
                if (env.temp && env.temp.size) { try { const n = await require('./moves').cleanTemp(env); if (n) onEvent('temp_cleaned', { id, n }); } catch (_) { /* tried again at the next unit */ } }
                if (policy) {
                    act('janitor');
                    const m = await janitor.maintain(env, policy);        // a stalled janitor must not stall the job: log, carry on
                    if (!m.ok) onEvent('janitor_failed', { id, reason: m.reason, detail: m.detail });
                    const moved = (m.done || []).filter((d) => d.op === 'deposit');
                    if (moved.length) onEvent('janitor_done', { id, ok: m.ok, kinds: moved.length, items: moved.reduce((a, d) => a + (d.count || 0), 0), to: [...new Set(moved.map((d) => d.to).filter(Boolean))] });
                }
                if (env.takeCancelCause) env.takeCancelCause();                       // forget a flicker of an earlier unit: the cause of THIS unit's stop is what is wanted
                const t0 = now();
                act('unit');
                const r = await job.runUnit(claim.region, u, env);
                onEvent('unit', { id, region: claim.region, unit: u.unit, role: claim.role, ok: r.ok, reason: r.reason, ms: now() - t0, detail: r.reason === 'cancelled' && env.takeCancelCause ? { ...(r.detail || {}), cause: env.takeCancelCause() || 'unknown' } : r.detail });
                sinceAudit++;
                if (!r.ok && (r.reason === 'wrong_dimension' || (env.wrongDim && env.wrongDim()))) {           // it left the job's dimension during the unit (or was never in it): nothing is the unit's fault
                    L.fail(id, claim.region, u.unit, 'wrong_dimension', now());
                    for (const rest of claim.units) if (rest.unit > u.unit) L.fail(id, claim.region, rest.unit, 'cancelled', now());
                    L.leave(id, now()); onEvent('wrong_dimension', { id, have: env.dimension && env.dimension() }); return { ended: 'wrong_dimension', units, failed };
                }
                if (!r.ok && r.detail && ['rejoin', 'gap', 'gap_edge', 'station'].includes(r.detail.stage) && r.detail.botSide !== undefined) farFails++; else if (r.ok) farFails = 0;
                if (farFails >= 4 && L.forfeit && L.forfeit(id, now())) { farFails = 0; onEvent('forfeit', { id, region: claim.region }); }
                if (r.ok) { L.done(id, claim.region, u.unit, now()); units++; streak = 0; for (const k of Object.keys(tries)) tries[k] = 0; if (env.rememberGood) env.rememberGood(); continue; }
                failed++; sinceAudit = AUDIT_EVERY;                // a failure is the moment to check that the range is what it should be
                await new Promise((res) => setImmediate(res));      // a failed unit can come back at once (cancelled, invalid ...): timers and sockets (the keep-alives of every bot in this process) get their turn before the next round
                const fi = L.fail(id, claim.region, u.unit, r.reason, now(), r.detail);
                if (fi && fi.parked) onEvent('parked', { id, region: claim.region, unit: u.unit, reason: r.reason, why: fi.why, detail: r.detail });
                if (r.reason === 'died' || r.reason === 'disconnected') { L.leave(id, now()); return { ended: r.reason, units, failed }; }
                for (const rest of claim.units) if (rest.unit > u.unit) L.fail(id, claim.region, rest.unit, 'cancelled', now());   // back to the pool, not counted
                // Stopped by an attack (not by the operator): fight, then claim again; this is neither a failure of the unit nor a bad streak.
                // Only when there was something to fight. An interrupt with nothing to fight (a bot short of air that the rescue did not bring out, a stale threat flag) is a failure
                // like any other and goes through the fix and the wait below: re-claiming at once made a loop with no I/O in it, which froze the whole process (live 2026-11-09).
                if (r.reason === 'cancelled' && !cancel.cancelled && env.defend) {
                    const d = await env.defend(); onEvent('defend', { id, ...d });
                    if (d.ended === 'died' || d.ended === 'disconnected') { L.leave(id, now()); return { ended: d.ended, units, failed }; }
                    if (d.fought) break;
                }
                if (BOT_NEEDS.has(r.reason) && await recover(r.reason, r)) break;       // solved by a script (a tool from the tools chest, one crafted): claim again
                if (BOT_NEEDS.has(r.reason)) { L.leave(id, now()); await bringBack(`waiting for ${r.reason === 'missing_tool' ? 'a tool' : 'an item'}`); return { ended: 'unhealthy', units, failed, last: r.reason }; }   // it needs a tool or an item: the service waits for it
                streak++;
                if (streak >= MAX_BAD_STREAK) { L.leave(id, now()); await bringBack(`${streak} failures in a row (${r.reason})`); return { ended: 'unhealthy', units, failed, last: r.reason }; }
                // Basic fixes before the next try: the ladder (wait / jump / sidestep / back to where it last worked) and a pause of a few seconds.
                onEvent('recover', { id, streak, reason: r.reason });
                act('recover');
                if (job.rescue) { try { const rr = await job.rescue(env, r.reason); if (rr.filled || rr.surfaced) onEvent('rescue', { id, ok: rr.ok, reason: rr.reason, filled: rr.filled, surfaced: rr.surfaced }); } catch (_) { /* a failed rescue is not a failed unit */ } }
                if (env.recover) { try { await env.recover(streak + 1, r); } catch (_) { /* a failed fix is not a failed unit */ } }
                // The failed unit is parked or on hold: the next claim is another unit, in another place. Waiting here would only be standing still.
                if (!(fi && (fi.parked || fi.held))) { act('backoff'); await wait(backoff(streak)); }
                break;
            }
        }
        L.leave(id, now());
        if (job.cleanup) await job.cleanup(env);
        return { ended: 'cancelled', units, failed };
    } finally { clearInterval(hb); act(null); if (env.dispose) env.dispose(); }
}

module.exports = { runWorker, backoffMs, MAX_BAD_STREAK };
