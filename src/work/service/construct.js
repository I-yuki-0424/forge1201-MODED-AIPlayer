'use strict';
// Litematica builds by the new builder (src/build/, TASK-20261121-073): the job kind `construct`. A part of WorkService (index.js copies these methods onto it).
// The job keeps the .litematic file and its placement (origin, rotation, mirror) and rebuilds the target from them after a restart; the crew are creative bots (flight, placement
// into the air, items as the creative inventory gives them, only item types the tagged materials containers hold). The old builder (jobs/build.js) stays for survival builds.
const fs = require('fs');
const path = require('path');
const lit = require('../jobs/litematic');
const { Target } = require('../../build/target');
const { BuildJob } = require('../../build/job');
const { drive } = require('../../build/drive');
const { Problem, need } = require('./common');

const SUPPLY_PURPOSES = new Set(['materials', 'tools', 'free']);

/** The target of a litematic placement: { target, placed }. */
function targetOf(file, placement) {
    let placed;
    try { placed = lit.place(lit.parse(file), placement, { keepAir: true }); } catch (e) { throw new Problem(`not a usable litematic: ${e.message}`); }
    return { target: new Target(placed.bp, placed.origin), placed };
}

/** What the rest of the service asks of a job's `impl` (the crew ledger's questions), answered by the build. */
function facade(build) {
    return {
        build,
        ledger: {
            regions: new Map(), stuck: [],
            finished: () => build.done,
            progress: () => { const s = build.status(); return { total: s.total, done: s.right, stuck: s.parked, leased: s.claimed, pending: Math.max(0, s.total - s.right), regions: 0, regionsDone: 0, finished: build.done, stage: s.stage, work: s.work, frontier: s.frontier, stats: s.stats }; },
            report: () => ({ ...build.status(), history: build.history.slice(-20), parked: [...build.parked.entries()].slice(0, 200).map(([k, why]) => ({ k, why })) }),
            requeueStuck: () => { const n = build.parked.size; build.parked.clear(); build.fails.clear(); build.done = false; build.stage = 'survey'; return n; },
        },
        plan: { count: build.t.n },
        diff: () => [],
    };
}

class ConstructPart {
    /**
     * A construct job. spec: { file: Buffer (the .litematic), placement: { pos: {x,y,z}, rotation, mirror }, name?, bots?, start?, dim? }.
     * The materials: every tagged container whose purpose is materials, tools or free.
     */
    createConstruct(spec) {
        need(spec && Buffer.isBuffer(spec.file), 'spec.file (the .litematic bytes) missing');
        need(spec.placement && spec.placement.pos && ['x', 'y', 'z'].every((k) => Number.isInteger(spec.placement.pos[k])), 'spec.placement.pos {x,y,z} (whole numbers) missing');
        spec = this._withRange(spec);
        const D = this._dimSpec(spec);
        const id = this._id('j'), file = path.join(this.o.dataDir, 'jobs', `${id}.litematic`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const placement = { pos: { ...spec.placement.pos }, rotation: spec.placement.rotation || 'NONE', mirror: spec.placement.mirror || 'NONE' };
        const { target, placed } = targetOf(spec.file, placement);
        fs.writeFileSync(file, spec.file);
        const name = String(spec.name || (placed && placed.name) || 'litematic').replace(/[^\w .-]/g, '').slice(0, 40) || 'litematic';
        const impl = this._constructImpl(target, id);
        const job = this._newJob('construct', name, { file: path.basename(file), placement, dim: D.dim, origin: { x: target.box.x, y: target.box.y, z: target.box.z }, ...(spec.syncmatica ? { syncmatica: spec.syncmatica } : {}) }, impl, id);
        job._box = { x0: target.box.x, x1: target.box.x + target.box.sx - 1, z0: target.box.z, z1: target.box.z + target.box.sz - 1, y0: target.box.y, y1: target.box.y + target.box.sy - 1 };
        job.summary = { size: [target.box.sx, target.box.sy, target.box.sz], count: [...target.items.values()].reduce((a, b) => a + b, 0), materials: Object.fromEntries(target.items), portals: target.portals.length };
        return this._register(job, spec);
    }

    _constructImpl(target, id) {
        const build = new BuildJob(target, { log: (m) => this.note('info', `job ${id}: ${m}`, { job: id }) });
        return facade(build);
    }

    /** A construct job after a restart: the same file and placement; the world is the truth, so the build starts with a survey. */
    _rebuildConstruct(j) {
        const file = fs.readFileSync(path.join(this.o.dataDir, 'jobs', path.basename(j.spec.file)));
        const { target } = targetOf(file, j.spec.placement);
        const job = this._newJob('construct', j.name, j.spec, this._constructImpl(target, j.id), j.id);
        job._box = { x0: target.box.x, x1: target.box.x + target.box.sx - 1, z0: target.box.z, z1: target.box.z + target.box.sz - 1, y0: target.box.y, y1: target.box.y + target.box.sy - 1 };
        job.summary = { size: [target.box.sx, target.box.sy, target.box.sz], count: [...target.items.values()].reduce((a, b) => a + b, 0), materials: Object.fromEntries(target.items), portals: target.portals.length };
        return job;
    }

    /** The materials containers: tagged containers a bot may take from, of purpose materials, tools or free, in the job's dimension. */
    _supplySites(job) {
        const dim = job.spec.dim || 'overworld';
        return this.sites.list().filter((s) => SUPPLY_PURPOSES.has(s.purpose) && this.sites.withdrawable(s) && (s.dim || 'overworld') === dim).map((s) => ({ x: s.x, y: s.y, z: s.z, name: s.name }));
    }

    /** One bot of a construct job (called by _startWorker once the bot is in the job's dimension). */
    _driveConstruct(job, rec, cancel) {
        const build = job.impl.build;
        this._dirty();
        drive(build, rec.name, rec.bot, { cancel, supplySites: this._supplySites(job) }).then((res) => {
            if (res.ended === 'not_creative') { rec.retired = 'not in creative mode: the builder flies and takes items like a creative player (switch the bot to creative)'; this.note('warn', `bot ${rec.name}: ${rec.retired}`, { job: job.id }); }
            this._workerEnded(job, rec, res, cancel);
        }, (e) => this._workerEnded(job, rec, { ended: 'error', error: String(e && e.stack || e).slice(0, 300) }, cancel));
    }
}

module.exports = { ConstructPart, targetOf };
