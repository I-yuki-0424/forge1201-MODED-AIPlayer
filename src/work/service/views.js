'use strict';
// What the page shows: bot and job views, status.
// A part of WorkService (index.js copies these methods onto it).

class ViewsPart {
    _worn(bot, item) { try { return require('../../skills/options').isWorn(bot, item); } catch (_) { return false; } }
    _pitOf(rec) { const j = rec.job && this.jobs.get(rec.job); return j && j.kind === 'pit' ? j : null; }
    /** Below the rim of its pit job (the bot cannot simply walk out; "Leave pit" brings it up by pillar). */
    _inPit(rec) {
        const j = this._pitOf(rec), e = rec.bot && rec.bot.entity;
        if (!j || !e || rec.state !== 'online') return false;
        const b = j.spec.box; return e.position.x >= b.x0 - 1 && e.position.x <= b.x1 + 2 && e.position.z >= b.z0 - 1 && e.position.z <= b.z1 + 2 && e.position.y < b.top + 0.9;
    }

    _jobView(job, full = false) {
        const L = job.impl.ledger, p = L.progress();
        const v = {
            id: job.id, kind: job.kind, name: job.name, state: job.state, spec: { ...job.spec, file: undefined }, progress: p, bots: [...job.bots],
            stuck: L.stuck.length, repairs: job.repairs, auto: job.auto ? { n: job.auto.n, of: 6, inS: Math.max(0, Math.round((job.auto.next - Date.now()) / 1000)), gaveUp: !!job.auto.gaveUp } : null, workers: [...job.bots].filter((n) => this.bots.get(n)?.worker?.job === job.id).length, created: job.created, started: job.started, ended: job.ended, diff: job.diff,
            summary: job.summary, box: this._jobBox(job), lanes: job.kind === 'pit' ? job.impl.plan.regions.length : null,
        };
        // Running with nobody able to work: every assigned bot is retired, offline or gone (the page shows it, nothing else will).
        v.blocked = job.state === 'running' && !v.workers && !L.finished() ? (job.bots.size ? 'no bot is working: ' + [...job.bots].map((n) => { const r = this.bots.get(n); return r ? `${n} ${r.retired || r.state}` : `${n} gone`; }).join(', ') : 'no bots assigned') : null;
        if (full) {
            v.report = L.report(); v.recent = (job.recent || []).slice(-60);
            v.regions = [...L.regions.values()].map((r) => ({ id: r.id, anchor: r.anchor, n: r.n, done: r.doneN, stuck: r.stuckN, leased: r.leasedN, meta: { ...r.meta, stations: undefined, stationCount: r.meta.stations ? r.meta.stations.length : undefined } }));
        }
        return v;
    }
    jobDetail(id) { return this._jobView(this._job(id), true); }

    status() {
        return {
            now: Date.now(), uptime: Date.now() - this.started, server: { host: this.o.host, port: this.o.port }, settings: this.settings,
            rcon: !!this.o.rcon, kit: this.o.kit, maxBots: this.o.maxBots, map: this.maps.available, problems: this.problems.list.length,
            bots: [...this.bots.values()].filter((b) => !b.removed).map((b) => this._botView(b)),
            jobs: [...this.jobs.values()].map((j) => this._jobView(j)),
            log: this.log.filter((e) => e.level !== 'debug').slice(-60),
        };
    }
}

module.exports = { ViewsPart };
