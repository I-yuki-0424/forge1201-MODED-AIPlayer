'use strict';
// Litematica builds by the new builder (src/build/, TASK-20261121-073): the job kind `construct`. A part of WorkService (index.js copies these methods onto it).
// The job keeps the .litematic file and its placement (origin, rotation, mirror) and rebuilds the target from them after a restart; the crew are survival players (walking,
// pillars and bridges of temporary blocks, survival digging, clicks a vanilla client can make, materials from the tagged containers by count, shulker boxes unpacked by hand).
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
        // the terrain goes through the pit (build/job.js planPit): the bot's work environment and the worker's options, as a pit job's bot gets them (workers.js _startWorker)
        const work = {
            env: () => {
                const env = this.envFactory && this.envFactory(rec.bot, cancel, { worker: true });
                if (!env) return null;
                env.sites = this.sites; env.jobDim = job.spec.dim ? require('../world/dimensions').canon(job.spec.dim) : null;
                if (env.configure) env.configure({ retireWorn: !!this.settings.retireWorn, defend: this.settings.defend !== false, planNodes: this.o.planNodes || 6000 });
                return env;
            },
            opts: {
                handlers: this.settings.scripts ? { missing_tool: (r) => this._toolScript(rec, r && r.detail && r.detail.block), missing_item: (r) => require('../bot/script').fetchScript(r && r.detail) } : null,
                scriptEnv: () => ({ sites: this.sites, box: build.pitPhase && build.pitPhase.box }),
                onEvent: (ev, d) => {
                    if (ev === 'parked') this.note('info', `${d.id} parked pit ${d.region} u${d.unit} (${d.reason}${d.detail && d.detail.stage ? ` at ${d.detail.stage}` : ''}${d.detail && d.detail.why ? `: ${String(d.detail.why).slice(0, 120)}` : ''})`, { job: job.id });
                    // a slow pit unit (over 30 s): its time, NAV trips and slowest cell, for the pace of forest sites (081's b081k, TASK-075)
                    if (ev === 'unit' && d.ok && d.ms > 30000 && d.detail) this.note('info', `${d.id} pit ${d.region} u${d.unit} slow ${Math.round(d.ms / 1000)} s: ${JSON.stringify({ nav: d.detail.navReach || 0, navS: Math.round((d.detail.navMs || 0) / 1000), blind: d.detail.blindReach || 0, cellsS: Math.round((d.detail.cellMs || 0) / 1000), mined: d.detail.mined, trees: d.detail.trees ? d.detail.trees.mined : undefined, cell: d.detail.slowCell })}`.slice(0, 360), { job: job.id });
                    if (ev === 'unit' && !d.ok && d.reason !== 'cancelled') this.note('info', `${d.id} pit ${d.region} u${d.unit} ${d.reason}${d.detail ? `: ${JSON.stringify({ why: d.detail.why, item: d.detail.item, block: d.detail.block, stage: d.detail.stage, cell: d.detail.cell, unmet: d.detail.unmet }).slice(0, 320)}` : ''}`, { job: job.id });
                    if (ev === 'script') this.note(d.ok ? 'info' : 'warn', `${d.id} script ${d.name} for ${d.reason}: ${d.ended}`, { job: job.id });
                },
            },
        };
        drive(build, rec.name, rec.bot, { cancel, supplySites: this._supplySites(job), pitWork: work }).then((res) => {
            if (res.ended === 'wrong_mode') { rec.retired = `game mode ${rec.bot && rec.bot.game && rec.bot.game.gameMode}: a builder works in survival (or creative)`; this.note('warn', `bot ${rec.name}: ${rec.retired}`, { job: job.id }); }
            this._workerEnded(job, rec, res, cancel);
        }, (e) => this._workerEnded(job, rec, { ended: 'error', error: String(e && e.stack || e).slice(0, 300) }, cancel));
    }
}

module.exports = { ConstructPart, targetOf };
