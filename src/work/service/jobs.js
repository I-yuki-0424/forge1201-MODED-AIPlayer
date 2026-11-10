'use strict';
// Jobs on the crew ledger: create (pit, build), assign, start, pause, cancel, repair.
// A part of WorkService (index.js copies these methods onto it).
const fs = require('fs');
const path = require('path');
const bp = require('../jobs/blueprint');
const build = require('../jobs/build');
const pit = require('../jobs/pit');
const janitor = require('../bot/janitor');
const dimensions = require('../world/dimensions');
const { Problem, need, int, normalizeBox, overlap, STRUCT_NAME, MIN_Y, MAX_Y, ACTIVE, PIT_LEDGER } = require('./common');

class JobsPart {
    _id(prefix) { return `${prefix}${++this.seq}`; }

    /**
     * The bots numbered `from` to `to` (owner 2026-11-09: "from number X to number Y, working in parallel"): Work3 is number 3, the name's trailing digits. Either order; every bot of the
     * roster in that range, in number order. Refused when the numbers are not whole or no bot has one of them.
     */
    botsInRange(from, to) {
        need(Number.isInteger(from) && Number.isInteger(to), 'from and to must be whole numbers (Work3 is number 3)', 400);
        const lo = Math.min(from, to), hi = Math.max(from, to);
        const names = [...this.bots.values()].filter((r) => !r.removed).map((r) => ({ name: r.name, n: /(\d+)$/.exec(r.name) })).filter((x) => x.n && +x.n[1] >= lo && +x.n[1] <= hi)
            .sort((a, b) => +a.n[1] - +b.n[1] || a.name.localeCompare(b.name)).map((x) => x.name);
        need(names.length, `no bot is numbered ${lo}..${hi}`, 404);
        return names;
    }
    /** `spec.bots` plus `spec.range` {from, to} as one list of names. */
    _withRange(spec) {
        if (!spec || typeof spec !== 'object' || !spec.range) return spec;
        need(typeof spec.range === 'object', 'range: {from, to}');
        const names = [...new Set([...(Array.isArray(spec.bots) ? spec.bots.map(String) : []), ...this.botsInRange(spec.range.from, spec.range.to)])];
        return { ...spec, bots: names, range: undefined };
    }
    unassignMany(id, names) { for (const n of names) this.unassign(id, n); return this._jobView(this._job(id)); }

    _jobBox(job) {
        if (job.kind === 'pit') { const b = job.spec.box; return { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.bottom, y1: b.top }; }
        if (job._box) return job._box;
        const p = job.impl.plan, box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: p.minY, y1: p.minY + p.layers - 1 };
        for (const k of p.footprint) { const [x, z] = k.split(',').map(Number); if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x; if (z < box.z0) box.z0 = z; if (z > box.z1) box.z1 = z; }
        return (job._box = box);
    }
    /** The dimension a job is in (default overworld; older stored jobs have none) and, for a dimension we have no profile of, the limits a bot there has told us (bot.game.minY / height). */
    _dimSpec(spec) {
        let dim; try { dim = spec.dim === undefined || spec.dim === null || spec.dim === '' ? 'overworld' : dimensions.need(spec.dim); } catch (e) { throw new Problem(e.message); }
        return { dim, limits: this._limits(dim) };
    }
    _limits(dim) {
        for (const rec of this.bots.values()) { const b = rec.bot; if (rec.state === 'online' && !rec.removed && b && b.game && dimensions.canon(b.game.dimension) === dim && Number.isInteger(b.game.minY) && Number.isInteger(b.game.height)) return { minY: b.game.minY, height: b.game.height }; }
        return null;
    }

    /** Check a designated range without making anything (POST /api/range/check): { dim, x0, z0, x1, z1, y0?, y1? } -> the normalised range, the dimension's limits, warnings, and the same spot in the twin dimension. */
    checkRange(spec) {
        need(spec && typeof spec === 'object', 'range missing');
        const D = this._dimSpec(spec);
        let range; try { range = dimensions.designate({ ...spec, dim: D.dim }, { learned: D.limits }); } catch (e) { throw new Problem(e.message); }
        const P = dimensions.profile(D.dim, D.limits), centre = dimensions.centre(range);
        const twinDim = D.dim === 'overworld' ? 'nether' : D.dim === 'nether' ? 'overworld' : null;
        return { range, limits: { minY: P.minY, maxY: P.maxY, known: P.known, learned: !!P.learned, voidBelow: P.voidBelow }, centre, twin: twinDim ? dimensions.convert(centre, D.dim, twinDim) : null };
    }

    /** The dimensions the console knows of: the three vanilla ones, every dimension a bot is in, every dimension a tagged gate stands in. */
    dimensionsList() {
        const seen = new Map(), add = (n, from) => { const c = dimensions.canon(n); if (!c) return; const e = seen.get(c) || { name: c, bots: 0, sites: 0 }; e[from]++; seen.set(c, e); };
        for (const n of ['overworld', 'nether', 'end']) seen.set(n, { name: n, bots: 0, sites: 0 });
        for (const rec of this.bots.values()) if (rec.state === 'online' && !rec.removed && rec.bot && rec.bot.game && rec.bot.game.dimension) add(rec.bot.game.dimension, 'bots');
        for (const s of this.sites.list()) if (s.dim) add(s.dim, 'sites');
        return { dimensions: [...seen.values()].map((e) => { const P = dimensions.profile(e.name, this._limits(e.name)); return { ...e, known: P.known, minY: P.minY, maxY: P.maxY, voidBelow: P.voidBelow, scale: P.scale }; }) };
    }

    _guardOverlap(job, force) {
        const box = this._jobBox(job), dimOf = (j) => j.spec.dim || 'overworld';
        for (const o of this.jobs.values()) if (o !== job && ACTIVE.has(o.state) && dimOf(o) === dimOf(job) && overlap(box, this._jobBox(o))) need(force, `overlaps job ${o.id} (${o.name}); pass force to allow`, 409);
        return box;
    }

    /** Open-pit job. spec: { name?, box: {x0,z0,x1,z1,top,bottom}, depot?: {kind,x,y,z}, bots?: [...], start?, force? } */
    createPit(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        spec = this._withRange(spec);
        const D = this._dimSpec(spec), box = normalizeBox(spec.box, D.dim, D.limits);
        // One lane (an X-Z range dug down to the bottom) per bot: the bots named, or else every idle bot that is online now; `lanes` overrides.
        const idle = [...this.bots.values()].filter((r) => !r.removed && r.state !== 'offline' && !(r.job && this.jobs.has(r.job) && ACTIVE.has(this.jobs.get(r.job).state))).length;
        const lanes = spec.lanes !== undefined ? spec.lanes : (Array.isArray(spec.bots) && spec.bots.length) || idle || 1;
        need(Number.isInteger(lanes) && lanes >= 1 && lanes <= 32, 'lanes: 1..32');
        // method: 'expert' (default: the learned station planner picks where to stand, band by band; setting pitExpert false = 'sweep'), 'sweep' (stand in the middle of a tile, dig everything in reach, move on in a fan) or 'rows' (the first version, cell by cell).
        // road: keep the haul road (default: only for rows; a sweep job leaves by pillar, exit.js) -- a road lets a late or respawned bot WALK in.
        const method = spec.method === undefined ? (this.settings.pitExpert === false ? 'sweep' : 'expert') : spec.method, road = spec.road === undefined ? !['sweep', 'expert'].includes(method) : !!spec.road;
        need(['sweep', 'rows', 'expert'].includes(method), 'method: expert, sweep or rows');
        let impl;
        try { impl = pit.createPitJob(box, PIT_LEDGER, { lanes, method, road }); } catch (e) { throw new Problem(e.message); }
        const depot = spec.depot ? this._depot(spec.depot) : null;
        const job = this._newJob('pit', spec.name || `pit ${box.x1 - box.x0 + 1}x${box.z1 - box.z0 + 1}x${box.top - box.bottom + 1}`, { box, depot, lanes, method, road, dim: D.dim, ...(D.limits ? { limits: D.limits } : {}) }, impl);
        job.policy = this._pitPolicy(depot);
        this._guardOverlap(job, spec.force);
        return this._register(job, spec);
    }

    /** The upkeep policy of a pit: the job's depot and the tagged sites (read live, so a site added later applies to jobs already running). */
    _pitPolicy(depot) {
        return janitor.pitPolicy({ ...(depot ? { depot, storeMin: depot.minValue || 0 } : {}), sites: () => this.sites, discardWorn: () => this.settings.discardWorn !== false });
    }

    _depot(d) {
        need(d && ['chest', 'shulker'].includes(d.kind), 'depot.kind is chest or shulker');
        // minValue: the depot's rank, 0..100 (janitor VALUES): what is worth less is thrown away instead of stored; 0 = store everything.
        const minValue = d.minValue === undefined ? 0 : d.minValue;
        need(Number.isInteger(minValue) && minValue >= 0 && minValue <= 100, 'depot.minValue: 0..100');
        if (d.kind === 'chest') {                                       // a depot at coordinates where a bot sees no container is a mistake worth saying at once (it was air on the play world)
            const bn = this._blockName(int(d.x, 'depot.x'), int(d.y, 'depot.y'), int(d.z, 'depot.z'));
            need(!bn || /(^|_)(chest|barrel|shulker_box)$/.test(bn), `no container at ${d.x} ${d.y} ${d.z} (there is ${bn}): check the depot coordinates`);
        }
        const item = d.item === undefined ? 'shulker_box' : d.item;      // any colour of shulker box the bot carries
        need(typeof item === 'string' && /^(?:(?:[a-z]+_)?shulker_box|enderstorage:ender_chest)$/.test(item), 'depot.item: a shulker box (shulker_box, red_shulker_box ...) or enderstorage:ender_chest (the bot carries it, places it, fills it and takes it back; its colours are the item\'s)');
        return d.kind === 'chest' ? { kind: 'chest', x: int(d.x, 'depot.x'), y: int(d.y, 'depot.y'), z: int(d.z, 'depot.z'), minValue } : { kind: 'shulker', item, minValue };
    }

    /** Build job. spec: { name?, structure, origin: {x,y,z}, ops?: [...], bots?, start?, force? } */
    async createBuild(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        spec = this._withRange(spec);
        need(typeof spec.structure === 'string' && STRUCT_NAME.test(spec.structure), 'structure name');
        const o = spec.origin || {};
        const origin = { x: int(o.x, 'origin.x'), y: int(o.y, 'origin.y'), z: int(o.z, 'origin.z') };
        const D = this._dimSpec(spec), P = dimensions.profile(D.dim, D.limits);
        need(origin.y >= P.minY && origin.y <= P.maxY, `origin.y must be between ${P.minY} and ${P.maxY} in ${P.name}`);
        let b = await this.getStructure(spec.structure);
        if (spec.ops && spec.ops.length) b = await this._ops(b, spec.ops);
        return this._buildFrom(b, origin, spec, spec.structure, { dim: D.dim, ...(D.limits ? { limits: D.limits } : {}) });
    }

    /**
     * Simple placement (jobs/layout.js): one block type as a floor, a wall or the walls of a room. spec: { kind, block, x0, z0, x1, z1, y, height?, name?, bots?, start?, force? }.
     * Becomes an ordinary build job (the cells are a blueprint), so bots, materials, scaffolding and repair work as for a structure.
     */
    async createLayout(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        spec = this._withRange(spec);
        const D = this._dimSpec(spec);
        let L; try { L = require('../jobs/layout').layout({ ...spec, dim: D.dim, limits: D.limits }); } catch (e) { throw new Problem(e.message); }
        need(!this.known || this.known(L.block), `the bots cannot place ${L.block} (it is not in their block table)`);
        const b = bp.fromCells(L.cells);
        const detail = { kind: L.kind, block: L.block, height: L.height, x0: spec.x0, z0: spec.z0, x1: spec.x1, z1: spec.z1, y: spec.y };
        return this._buildFrom(b, L.origin, { ...spec, name: spec.name || `${L.kind} ${L.block}` }, null, { layout: detail, dim: D.dim, ...(D.limits ? { limits: D.limits } : {}) }, { describe: L.describe });
    }

    /** What a layout would be, without making a job (the Place page's preview): a sentence, the count, the boxes for the map; or {ok: false, why} with the reason in words. */
    previewLayout(spec) {
        let L; try { const D = this._dimSpec(spec); L = require('../jobs/layout').layout({ ...spec, dim: D.dim, limits: D.limits }); } catch (e) { return { ok: false, why: e.message }; }
        const item = build.itemFor(L.block), known = !this.known || this.known(L.block);
        return { ok: true, describe: L.describe, count: L.count, stacks: Math.ceil(L.count / 64), origin: L.origin, size: L.size, boxes: L.boxes, kind: L.kind, along: L.along, block: L.block, item, known, why: known ? null : `the bots cannot place ${L.block} (it is not in their block table)` };
    }

    async _buildFrom(b, origin, spec, structure, extra, summaryExtra = {}) {
        const id = this._id('j');
        const file = path.join(this.o.dataDir, 'jobs', `${id}.nbt`);
        fs.writeFileSync(file, bp.write(b));                                            // an immutable copy: editing the library later changes nothing
        let impl;
        try { impl = build.createBuildJob(bp.cells(b), origin, { leaseMs: 45000 }, { known: this.known }); } catch (e) { fs.rmSync(file, { force: true }); throw new Problem(e.message); }
        const job = this._newJob('build', spec.name || `build ${structure}`, { structure, origin, file: path.basename(file), ...extra }, impl, id);
        job.summary = { size: b.size, count: impl.plan.count, unsupported: impl.plan.unsupported, materials: this._materials(impl.plan), ...summaryExtra };
        try { this._guardOverlap(job, spec.force); } catch (e) { fs.rmSync(file, { force: true }); throw e; }
        return this._register(job, spec);
    }

    _materials(plan) {
        const m = {};
        for (const t of plan.tiles.values()) for (const list of t.cells.values()) for (const c of list) { const it = build.itemFor(c.block); if (it) m[it] = (m[it] || 0) + 1; }
        return m;
    }

    _newJob(kind, name, spec, impl, id = null) {
        return { id: id || this._id('j'), kind, name: String(name).slice(0, 60), spec, impl, state: 'ready', created: Date.now(), bots: new Set(), workers: new Map(), policy: null, repairs: 0, summary: null, started: null, ended: null, diff: null };
    }

    _register(job, spec) {
        for (const n of spec.bots || []) this._assign(job, n);
        this.jobs.set(job.id, job);
        this.note('info', `job ${job.id} created: ${job.name}`);
        this._dirty();
        if (spec.start) this.startJob(job.id);
        return this._jobView(job);
    }

    async _rebuild(j) {
        const base = { id: j.id, kind: j.kind, name: j.name, spec: j.spec, created: j.created };
        let impl;
        if (j.kind === 'pit') impl = pit.createPitJob(normalizeBox(j.spec.box, j.spec.dim || 'overworld', j.spec.limits || null), PIT_LEDGER, { lanes: j.spec.lanes || 0, method: j.spec.method || 'rows', road: j.spec.road === undefined ? true : !!j.spec.road });
        else {
            const b = await bp.read(fs.readFileSync(path.join(this.o.dataDir, 'jobs', path.basename(j.spec.file))));
            impl = build.createBuildJob(bp.cells(b), j.spec.origin, { leaseMs: 45000, maxAttempts: 6 }, { known: this.known });
        }
        const job = this._newJob(j.kind, j.name, j.spec, impl, j.id);
        job.created = base.created;
        if (j.kind === 'pit') job.policy = this._pitPolicy(j.spec.depot);
        else job.summary = { count: impl.plan.count, unsupported: impl.plan.unsupported, materials: this._materials(impl.plan) };
        return job;
    }

    _job(id) { const j = this.jobs.get(id); need(j, `no job ${id}`, 404); return j; }

    _assign(job, name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        need(!rec.job || rec.job === job.id || !this.jobs.has(rec.job) || !ACTIVE.has(this.jobs.get(rec.job).state), `bot ${name} works on ${rec.job}`, 409);
        rec.job = job.id; rec.retired = null; job.bots.add(name);
    }

    assign(id, names) {
        const job = this._job(id);
        need(ACTIVE.has(job.state), `job is ${job.state}`, 409);
        for (const n of names) this._assign(job, n);
        this._dirty();
        if (job.state === 'running') for (const n of names) this._startWorker(job, this.bots.get(n));
        return this._jobView(job);
    }
    unassign(id, name) {
        const job = this._job(id), rec = this.bots.get(name);
        job.bots.delete(name);
        if (rec && rec.job === id) { rec.job = null; this._stopWorker(rec); }
        this._dirty();
        return this._jobView(job);
    }

    startJob(id) {
        const job = this._job(id);
        need(['ready', 'paused'].includes(job.state), `job is ${job.state}`, 409);
        if (!job.bots.size) for (const rec of this.bots.values()) if (!rec.removed && !rec.job && rec.state !== 'offline') { rec.job = job.id; job.bots.add(rec.name); }     // no choice made: every idle bot
        need(job.bots.size, 'no bots assigned and no idle bot online', 409);
        job.state = 'running'; job.started = job.started || Date.now();
        for (const n of job.bots) this._startWorker(job, this.bots.get(n));
        this.note('info', `job ${job.id} started with ${job.bots.size} bots`);
        this._dirty();
        return this._jobView(job);
    }

    pauseJob(id) {
        const job = this._job(id);
        need(job.state === 'running', `job is ${job.state}`, 409);
        job.state = 'paused';
        for (const n of job.bots) { const rec = this.bots.get(n); if (rec) this._stopWorker(rec); }
        this.note('info', `job ${job.id} paused`);
        this._dirty();
        return this._jobView(job);
    }

    cancelJob(id) {
        const job = this._job(id);
        need(ACTIVE.has(job.state), `job is ${job.state}`, 409);
        job.state = 'cancelled'; job.ended = Date.now();
        this._release(job);
        this.note('info', `job ${job.id} cancelled`);
        this._dirty();
        return this._jobView(job);
    }

    deleteJob(id) {
        const job = this._job(id);
        need(!ACTIVE.has(job.state) || job.state === 'ready', `job is ${job.state}: cancel it first`, 409);
        this._release(job);
        this.jobs.delete(id);
        if (job.kind === 'build') fs.rmSync(path.join(this.o.dataDir, 'jobs', path.basename(job.spec.file)), { force: true });
        this._dirty();
    }

    _release(job) {
        for (const n of job.bots) { const rec = this.bots.get(n); if (rec) { this._stopWorker(rec); if (rec.job === job.id) rec.job = null; } }
        job.bots.clear();
    }

    /** Give every stuck unit another round (the repair pass of pit_live.js); the job runs again if it had ended. */
    repairJob(id) {
        const job = this._job(id), n = job.impl.ledger.requeueStuck(Date.now());
        if (n) job.repairs = 0;
        if (job.state === 'finished' && n) { job.state = 'paused'; this.startJob(id); }
        this._dirty();
        return { requeued: n, job: this._jobView(job) };
    }
}

module.exports = { JobsPart };
