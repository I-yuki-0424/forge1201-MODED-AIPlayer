'use strict';
// Structures as a crew job (docs/proposed/WORKERS-v1.md part 2, rewritten 2026-11-18 as TASK-20261117-070 "the build is a user of the same layers as the pit"). The code is in src/work/builder/:
//   cells.js     what a blueprint cell is (item, kind, support, material list, state match)        order.js     the order of placement and what each unit waits for
//   stations.js  where a bot stands to place a batch of cells                                         run.js       one unit: supply, station, NAV walk, blind placement with recipes, read back
//   supply.js    one visit per chest (take_many)                                                      plan.js      the blueprint -> cells -> units, the diff against the world
// This file builds the job the service runs: the crew ledger (one region, one row per unit; a unit is claimable when the cells it hangs on stand in the world; the nearest one first), the final
// audit (what the world lacks reopens its units), and the old module API.
const { Ledger } = require('./crew');
const C = require('../builder/cells');
const P = require('../builder/plan');
const R = require('../builder/run');

const AUDIT_ROUNDS = 3;
const P_needs = (cells, w) => P.needsOf(cells, w), TRACE = !!process.env.BUILD_TRACE;

function createBuildJob(cells, origin, ledgerOpts = {}, planOpts = {}) {
    const plan = P.planBuild(cells, origin, planOpts), ledger = new Ledger({ holdMs: 2000, noShun: true, ...ledgerOpts });
    const job = { kind: 'build', ledger, plan, world: null, auditRound: 0, auditAt: 0, waits: {}, noStation: {}, lastProgress: Date.now(), posts: require('../builder/posts').makePosts(), tidyRounds: 0 };
    for (const r of plan.regions) ledger.addRegion({ ...r, gate: (u, bot, pos) => R.gateOf(plan, job, u, bot, pos), pick: (cands, o) => R.pickNear(plan, job, cands, o) });
    job.runUnit = (regionId, unit, env) => R.runUnit(plan, job, regionId, unit, env);
    /**
     * A bot with an area and nothing to claim (the first minutes: the trunk of the structure is built by one bot, the others wait for what hangs on it) goes to the chests and fills its pack with the
     * materials of the first units of its area, so that its first unit needs no trip. At most once every two minutes.
     */
    job.idle = async (env, id, now) => {
        const posts = require('../builder/posts'), supply = require('../builder/supply'), P = job.posts;
        if (!env.bot || !env.sites || !env.travel || !env.run) return;
        const z = posts.postOf(plan, job, id, env.pos(), now);
        if (z < 0 || now - (P.fetched.get(id) || 0) < 120000) return;
        const st = ledger.regions.get('b0').state, [a, b] = plan.zones.units[z];
        let u = a; while (u < b && (st[u] === 2 || st[u] === 3)) u++;
        if (u >= b) return;
        P.fetched.set(id, now);
        const need = supply.batch(env.bot, plan, u, env.w, P_needs(plan.units[u], env.w));
        const rs = await supply.restock(env, plan, need, { trigger: need, topup: false, reserve: 3 });
        if (TRACE) console.log(`[build] ${id} idle fetch for area ${z}: ${rs.ok ? 'ok' : 'short'} trips=${rs.trips || 0} items=${Object.keys(need).length}`);
    };
    job.cleanup = async (env) => { if (env && env.bot) { env.bot.__reserve = null; } };
    job.diff = (w) => P.diffBuild(plan, w);
    /**
     * The final look (the worker calls it when every unit is settled): what the world lacks sends its units back to work, a few rounds at most. One bot looks at a time. Returns
     * {} when nothing is left or the rounds are used up, {busy: true} while another bot is looking, {region, round, reopened} when units were sent back.
     */
    job.sweep = async (env, now) => {
        if (now - job.auditAt < 8000) return { busy: true };
        const rounds = job.auditRound >= AUDIT_ROUNDS;                                // the rounds of repair are used up: the tidy still runs
        job.auditAt = now;
        const missing = rounds ? [] : job.diff(env.w);
        if (!missing.length) {
            // Nothing is missing: what the bots left behind in the box (scaffolds) is taken away, a few rounds at most (owner 2026-11-19: temporary blocks are often not destroyed)
            if (job.tidyRounds < 6 && env.travel && env.exec) {
                job.tidyRounds++;
                const ex = P.extrasOf(plan, env.w).sort((a, b) => Math.hypot(a.x - env.pos().x, a.z - env.pos().z) - Math.hypot(b.x - env.pos().x, b.z - env.pos().z)), done = [];
                for (const c of ex.slice(0, 16)) {
                    if (env.cancelled && env.cancelled()) break;
                    const t = await env.travel({ x: c.x, y: c.y, z: c.z }, { near: 3, nearY: 3, maxSegments: 12, stuckAfter: 3, footNodes: 3000, why: 'tidy' });
                    if (!t.ok) continue;
                    const m = await env.exec('mine', { x: c.x, y: c.y, z: c.z, collect: false }, { raw: true, maxTicks: 300 });
                    if (m.ok) done.push(`${c.block}@${c.x},${c.y},${c.z}`);
                }
                if (TRACE) console.log(`[build] tidy round ${job.tidyRounds}: ${ex.length} left behind, ${done.length} taken away`);
                if (done.length) return { region: 'b0', round: job.auditRound, checked: plan.count, reopened: 0, gaveUp: 0, tidy: done.length };
            }
            return {};
        }
        const units = new Set(missing.map((c) => plan.unitOf.get(c.k)).filter((u) => u !== undefined));
        let reopened = 0;
        for (const u of units) if (ledger.requeueUnit('b0', u, now)) reopened++;
        job.auditRound++;
        return reopened ? { region: 'b0', round: job.auditRound, checked: plan.count, reopened, gaveUp: 0, first: { block: missing[0].block, x: missing[0].x, y: missing[0].y, z: missing[0].z } } : {};
    };
    return job;
}

module.exports = {
    createBuildJob, planBuild: P.planBuild, unitCells: P.unitCells, diffBuild: P.diffBuild, needsOf: P.needsOf, runUnit: R.runUnit,
    house: C.house, fromStructureNbt: C.fromStructureNbt, unbuildable: C.unbuildable, itemFor: C.itemFor, kindOf: C.kindOf, materialsOf: C.materialsOf, stateMatches: C.stateMatches, useMismatch: C.useMismatch,
};
