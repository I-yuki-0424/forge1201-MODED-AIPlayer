'use strict';
// One pure bot: claim units from the crew ledger, run them with the action layer, report. No decisions, no LLM, no learner
// (docs/proposed/WORKERS-v1.md). The loop is the same for every job kind; the job supplies `runUnit`.
const janitor = require('./janitor');
const { isBotSide } = require('./crew');

const MAX_BAD_STREAK = 3;      // consecutive failed units before a bot gives up (it is the problem, not the units)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param job     { ledger, runUnit(regionId, unit, env) } (createPitJob, createBuildJob)
 * @param id      the bot's name in the ledger
 * @param env     { exec(name, args), w, have(item), inv(), here(), pos() -> {x,z}, now() -> ms }
 * @param opts    { cancel, policy (janitor), pollMs, batch, onEvent }
 * @returns       { ended: 'finished' | 'cancelled' | 'died' | 'disconnected', units, failed }
 */
async function runWorker(job, id, env, { cancel = { cancelled: false }, policy = null, pollMs = 500, batch = 1, onEvent = () => {} } = {}) {
    const L = job.ledger, now = env.now || Date.now;
    let units = 0, failed = 0, idle = 0, streak = 0;
    L.join(id);
    const hb = setInterval(() => L.heartbeat(id, now()), Math.max(1000, L.leaseMs / 3));
    try {
        while (!cancel.cancelled) {
            const claim = L.claim(id, env.pos(), now(), { batch });
            if (!claim) {
                if (L.finished()) { if (job.cleanup) await job.cleanup(env); return { ended: 'finished', units, failed }; }
                // The next layer waits for units other bots are still running; if nobody is running anything, nothing will change.
                if (L.progress().leased === 0 && ++idle > 20) { L.leave(id, now()); return { ended: 'stalled', units, failed }; }
                await sleep(pollMs);
                continue;
            }
            idle = 0;
            for (const u of claim.units) {
                if (cancel.cancelled) { L.leave(id, now()); return { ended: 'cancelled', units, failed }; }
                if (policy) {
                    const m = await janitor.maintain(env, policy);        // a stalled janitor must not stall the job: log, carry on
                    if (!m.ok) onEvent('janitor_failed', { id, reason: m.reason, detail: m.detail });
                }
                const t0 = now();
                const r = await job.runUnit(claim.region, u, env);
                onEvent('unit', { id, region: claim.region, unit: u.unit, role: claim.role, ok: r.ok, reason: r.reason, ms: now() - t0, detail: r.detail });
                if (r.ok) { L.done(id, claim.region, u.unit, now()); units++; streak = 0; continue; }
                failed++; streak++;
                L.fail(id, claim.region, u.unit, r.reason, now(), r.detail);
                if (r.reason === 'died' || r.reason === 'disconnected') { L.leave(id, now()); return { ended: r.reason, units, failed }; }
                if (streak >= MAX_BAD_STREAK) {        // e.g. respawned far from the site: stop taking units, the others carry on
                    for (const rest of claim.units) if (rest.unit > u.unit) L.fail(id, claim.region, rest.unit, 'cancelled', now());
                    L.leave(id, now()); return { ended: 'unhealthy', units, failed, last: r.reason };
                }
                for (const rest of claim.units) if (rest.unit > u.unit) L.fail(id, claim.region, rest.unit, 'cancelled', now());   // back to the pool, not counted
                break;
            }
        }
        L.leave(id, now());
        if (job.cleanup) await job.cleanup(env);
        return { ended: 'cancelled', units, failed };
    } finally { clearInterval(hb); }
}

/** The environment of a real Mineflayer bot on the action layer. */
function botEnv(bot, { cancel } = {}) {
    const { execute } = require('../skills');
    const { fromBot } = require('../skills/world');
    const { feetCell } = require('../skills/motion');
    const w = fromBot(bot);
    return {
        w, now: Date.now,
        pause: (ticks) => sleep(ticks * 50),                       // let the thing in the way (another bot, an item) move on
        exec: (name, args) => execute(bot, name, args, { cancel }),
        have: (item) => bot.inventory.items().reduce((n, i) => n + (i.name === item ? i.count : 0), 0),
        inv: () => janitor.inventoryOf(bot),
        here: () => feetCell(bot.entity.position),
        pos: () => ({ x: bot.entity.position.x, z: bot.entity.position.z }),
    };
}

module.exports = { runWorker, botEnv };
