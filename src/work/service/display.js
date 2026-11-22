'use strict';
// The in-game display of the service: what to draw (bots' planned paths, pit lanes, build boxes, tagged blocks, each with its dimension) and the switches.
// The drawing itself is display/overlay.js.
const { Overlay, DEFAULTS, PATH_STALE_MS } = require('../display/overlay');
const dimensions = require('../world/dimensions');

class DisplayPart {
    /** Start the overlay (needs RCON). Called once by the constructor. */
    _startDisplay() {
        if (!this.o.rcon || this.o.display === false) return;
        this.display = new Overlay({
            rcon: (c) => this.rcon(c), pending: () => this._rconPending,
            config: () => this.settings.display, state: () => this.displayState(), humans: () => this._viewerList(),
            perFrame: this.o.displayBudget, frameMs: this.o.displayMs,
        });
        this.display.start();
    }

    /** The players who see the display: everyone on the server who is not a bot, in any dimension (an entity is seen by whoever is in its dimension). */
    async _viewerList() {
        const ps = await this.players();
        return ps.filter((p) => !p.bot && p.pos).map((p) => ({ name: p.name, ...p.pos, dim: p.dimension || 'minecraft:overworld' }));
    }

    /** Remember the way a bot is about to walk (the planner's cells, from the `walk` phase of the action layer). */
    _trackPath(rec, bot) {
        bot.__onPhase = (ev) => { if (ev && ev.phase) { rec.phase = { name: String(ev.phase).slice(0, 24), at: Date.now() }; this.health.phase(rec.name, rec.phase.name); } if (ev && Array.isArray(ev.cells) && ev.cells.length) rec.path = { cells: ev.cells.slice(0, 400), at: Date.now() }; };
    }

    displayState() {
        const now = Date.now(), bots = [], lanes = [], tags = [], colorOf = new Map();
        let i = 0;
        for (const rec of this.bots.values()) {
            if (rec.removed) continue;
            const color = i++; colorOf.set(rec.name, color);
            const e = rec.state === 'online' && rec.bot && rec.bot.entity;
            const busy = rec.worker || (rec.cmd && rec.cmd.status === 'running') || rec.script;
            if (rec.path && (now - rec.path.at > PATH_STALE_MS || !busy)) rec.path = null;
            if (e) bots.push({ name: rec.name, color, dim: dimensions.canon(rec.bot.game && rec.bot.game.dimension) || 'overworld', pos: { x: e.position.x, y: e.position.y, z: e.position.z }, path: rec.path || null });
        }
        let k = 0;
        for (const job of this.jobs.values()) {
            if (!['running', 'paused', 'ready'].includes(job.state)) continue;
            if (job.kind === 'pit') {
                for (const reg of job.impl.ledger.regions.values()) {
                    const m = reg.meta, rows = Math.max(1, reg.rows || 1), layer = Math.min(reg.layers ? reg.layers - 1 : 0, Math.floor(reg.doneN / rows));
                    lanes.push({ job: job.id, id: reg.id, dim: job.spec.dim || 'overworld', color: k++, box: { x0: m.x0, x1: m.x1, z0: m.z0, z1: m.z1 }, rim: m.top, activeY: Math.max(m.bottom, m.top - layer * (m.band || 1)) });
                }
            } else if (job.kind === 'construct') {
                // the structure builder (src/build): the box, and each bot's share of it now: the cells it has claimed and the cell it stands on, in the bot's colour (a construct
                // job has no plan: the generic branch threw and the overlay drew nothing at all during a build, 2026-11-22)
                const B = job.impl && job.impl.build; if (!B || !B.t) continue;
                const tb = B.t.box, dim = job.spec.dim || 'overworld';
                const per = new Map();
                const grow = (name, x, y, z) => { let r = per.get(name); if (!r) per.set(name, (r = { x0: x, x1: x, y0: y, y1: y, z0: z, z1: z })); else { r.x0 = Math.min(r.x0, x); r.x1 = Math.max(r.x1, x); r.y0 = Math.min(r.y0, y); r.y1 = Math.max(r.y1, y); r.z0 = Math.min(r.z0, z); r.z1 = Math.max(r.z1, z); } };
                for (const [k, name] of B.claims) { const [x, y, z] = k.split(',').map(Number); grow(name, x, y, z); }
                for (const [name, b] of B.bots) if (b.station && per.has(name)) grow(name, b.station[0].x, b.station[0].y, b.station[0].z);
                for (const [name, r] of per) lanes.push({ job: job.id, id: `claim ${name}`, dim, color: colorOf.has(name) ? colorOf.get(name) : 0, box: { x0: r.x0, x1: r.x1, z0: r.z0, z1: r.z1 }, rim: r.y1, activeY: r.y0 });
                // the whole box last (the layer has a cap: the claims, small and changing, come first); white, its dashed rim at the top and at the frontier layer
                lanes.push({ job: job.id, id: 'build', dim, color: 7, box: { x0: tb.x, x1: tb.x + tb.sx - 1, z0: tb.z, z1: tb.z + tb.sz - 1 }, rim: tb.y + tb.sy - 1, activeY: Number.isFinite(B.frontier) ? B.frontier : tb.y });
            } else {
                const b = this._jobBox(job); if (b && Number.isFinite(b.x0)) lanes.push({ job: job.id, id: 'build', dim: job.spec.dim || 'overworld', color: k++, box: b, rim: b.y1, activeY: b.y0 });
            }
        }
        for (const s of this.sites.list()) {
            let end = null; try { end = this.sites.through(s.x, s.y, s.z); } catch (_) { /* a broken link is not drawn */ }
            tags.push({ name: s.name, dim: dimensions.canon(s.dim) || 'overworld', x: s.x, y: s.y, z: s.z, machine: s.purpose === 'furnace', end });
        }
        return { bots, lanes, tags };
    }
}

module.exports = { DisplayPart, DEFAULTS };
