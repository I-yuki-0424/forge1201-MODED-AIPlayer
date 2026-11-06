'use strict';
// Jobs on the crew ledger: create (pit, build), assign, start, pause, cancel, repair.
// A part of WorkService (index.js copies these methods onto it).
const fs = require('fs');
const path = require('path');
const bp = require('../jobs/blueprint');
const build = require('../jobs/build');
const pit = require('../jobs/pit');
const janitor = require('../bot/janitor');
const { Problem, need, int, normalizeBox, overlap, STRUCT_NAME, MIN_Y, MAX_Y, ACTIVE, PIT_LEDGER } = require('./common');

class JobsPart {
    _id(prefix) { return `${prefix}${++this.seq}`; }

    _jobBox(job) {
        if (job.kind === 'pit') { const b = job.spec.box; return { x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1, y0: b.bottom, y1: b.top }; }
        if (job._box) return job._box;
        const p = job.impl.plan, box = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y0: p.minY, y1: p.minY + p.layers - 1 };
        for (const k of p.footprint) { const [x, z] = k.split(',').map(Number); if (x < box.x0) box.x0 = x; if (x > box.x1) box.x1 = x; if (z < box.z0) box.z0 = z; if (z > box.z1) box.z1 = z; }
        return (job._box = box);
    }
    _guardOverlap(job, force) {
        const box = this._jobBox(job);
        for (const o of this.jobs.values()) if (o !== job && ACTIVE.has(o.state) && overlap(box, this._jobBox(o))) need(force, `overlaps job ${o.id} (${o.name}); pass force to allow`, 409);
        return box;
    }

    /** Open-pit job. spec: { name?, box: {x0,z0,x1,z1,top,bottom}, depot?: {kind,x,y,z}, bots?: [...], start?, force? } */
    createPit(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        const box = normalizeBox(spec.box);
        // One lane (an X-Z range dug down to the bottom) per bot: the bots named, or else every idle bot that is online now; `lanes` overrides.
        const idle = [...this.bots.values()].filter((r) => !r.removed && r.state !== 'offline' && !(r.job && this.jobs.has(r.job) && ACTIVE.has(this.jobs.get(r.job).state))).length;
        const lanes = spec.lanes !== undefined ? spec.lanes : (Array.isArray(spec.bots) && spec.bots.length) || idle || 1;
        need(Number.isInteger(lanes) && lanes >= 1 && lanes <= 32, 'lanes: 1..32');
        // method: 'sweep' (default: stand in the middle of a tile, dig everything in reach, move on in a fan) or 'rows' (the first version, cell by cell).
        // road: keep the haul road (default: only for rows; a sweep job leaves by pillar, exit.js) -- a road lets a late or respawned bot WALK in.
        const method = spec.method === undefined ? 'sweep' : spec.method, road = spec.road === undefined ? method !== 'sweep' : !!spec.road;
        need(['sweep', 'rows'].includes(method), 'method: sweep or rows');
        let impl;
        try { impl = pit.createPitJob(box, PIT_LEDGER, { lanes, method, road }); } catch (e) { throw new Problem(e.message); }
        const depot = spec.depot ? this._depot(spec.depot) : null;
        const job = this._newJob('pit', spec.name || `pit ${box.x1 - box.x0 + 1}x${box.z1 - box.z0 + 1}x${box.top - box.bottom + 1}`, { box, depot, lanes, method, road }, impl);
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
        return d.kind === 'chest' ? { kind: 'chest', x: int(d.x, 'depot.x'), y: int(d.y, 'depot.y'), z: int(d.z, 'depot.z'), minValue } : { kind: 'shulker', item: 'shulker_box', minValue };
    }

    /** Build job. spec: { name?, structure, origin: {x,y,z}, ops?: [...], bots?, start?, force? } */
    async createBuild(spec) {
        need(spec && typeof spec === 'object', 'spec missing');
        need(typeof spec.structure === 'string' && STRUCT_NAME.test(spec.structure), 'structure name');
        const o = spec.origin || {};
        const origin = { x: int(o.x, 'origin.x'), y: int(o.y, 'origin.y'), z: int(o.z, 'origin.z') };
        need(origin.y >= MIN_Y && origin.y <= MAX_Y, `origin.y must be between ${MIN_Y} and ${MAX_Y}`);
        let b = await this.getStructure(spec.structure);
        if (spec.ops && spec.ops.length) b = await this._ops(b, spec.ops);
        const id = this._id('j');
        const file = path.join(this.o.dataDir, 'jobs', `${id}.nbt`);
        fs.writeFileSync(file, bp.write(b));                                            // an immutable copy: editing the library later changes nothing
        let impl;
        try { impl = build.createBuildJob(bp.cells(b), origin, { leaseMs: 45000 }, { known: this.known }); } catch (e) { fs.rmSync(file, { force: true }); throw new Problem(e.message); }
        const job = this._newJob('build', spec.name || `build ${spec.structure}`, { structure: spec.structure, origin, file: path.basename(file) }, impl, id);
        job.summary = { size: b.size, count: impl.plan.count, unsupported: impl.plan.unsupported, materials: this._materials(impl.plan) };
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
        if (j.kind === 'pit') impl = pit.createPitJob(normalizeBox(j.spec.box), PIT_LEDGER, { lanes: j.spec.lanes || 0, method: j.spec.method || 'rows', road: j.spec.road === undefined ? true : !!j.spec.road });
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
        if (job.state === 'finished' && n) { job.state = 'paused'; this.startJob(id); }
        this._dirty();
        return { requeued: n, job: this._jobView(job) };
    }
}

module.exports = { JobsPart };
