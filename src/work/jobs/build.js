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

function createBuildJob(cells, origin, ledgerOpts = {}, planOpts = {}) {
    const plan = P.planBuild(cells, origin, planOpts), ledger = new Ledger({ holdMs: 2000, ...ledgerOpts });
    const job = { kind: 'build', ledger, plan, world: null, auditRound: 0, auditAt: 0, waits: {}, lastProgress: Date.now() };
    for (const r of plan.regions) ledger.addRegion({ ...r, gate: (u) => R.gateOf(plan, job, u), pick: (cands, o) => R.pickNear(plan, cands, o) });
    job.runUnit = (regionId, unit, env) => R.runUnit(plan, job, regionId, unit, env);
    job.cleanup = async (env) => { if (env && env.bot) { env.bot.__reserve = null; } };
    job.diff = (w) => P.diffBuild(plan, w);
    /**
     * The final look (the worker calls it when every unit is settled): what the world lacks sends its units back to work, a few rounds at most. One bot looks at a time. Returns
     * {} when nothing is left or the rounds are used up, {busy: true} while another bot is looking, {region, round, reopened} when units were sent back.
     */
    job.sweep = async (env, now) => {
        if (now - job.auditAt < 8000) return { busy: true };
        if (job.auditRound >= AUDIT_ROUNDS) return {};
        job.auditAt = now;
        const missing = job.diff(env.w);
        if (!missing.length) return {};
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
