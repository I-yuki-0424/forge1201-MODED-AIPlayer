'use strict';
// The in-game display of the service: what to draw (bots' planned paths, pit lanes, build boxes, tagged blocks) and the switches.
// The drawing itself is display/overlay.js.
const { Overlay, DEFAULTS, PATH_STALE_MS } = require('../display/overlay');

class DisplayPart {
    /** Start the overlay (needs RCON). Called once by the constructor. */
    _startDisplay() {
        if (!this.o.rcon || this.o.display === false) return;
        this.display = new Overlay({
            rcon: (c) => this.rcon(c), pending: () => this._rconPending,
            config: () => this.settings.display, state: () => this.displayState(), humans: () => this._viewerList(),
            budget: this.o.displayBudget, frameMs: this.o.displayMs,
        });
        this.display.start();
    }

    /** The players who see the display: everyone on the server who is not a bot and stands in the overworld. */
    async _viewerList() {
        const ps = await this.players();
        return ps.filter((p) => !p.bot && p.pos && (!p.dimension || p.dimension === 'minecraft:overworld')).map((p) => ({ name: p.name, ...p.pos }));
    }

    /** Remember the way a bot is about to walk (the planner's cells, from the `walk` phase of the action layer). */
    _trackPath(rec, bot) {
        bot.__onPhase = (ev) => { if (ev && Array.isArray(ev.cells) && ev.cells.length) rec.path = { cells: ev.cells.slice(0, 400), at: Date.now() }; };
    }

    displayState() {
        const now = Date.now(), bots = [], lanes = [], tags = [];
        let i = 0;
        for (const rec of this.bots.values()) {
            if (rec.removed) continue;
            const color = i++, e = rec.state === 'online' && rec.bot && rec.bot.entity;
            const busy = rec.worker || (rec.cmd && rec.cmd.status === 'running') || rec.script;
            if (rec.path && (now - rec.path.at > PATH_STALE_MS || !busy)) rec.path = null;
            if (e) bots.push({ name: rec.name, color, pos: { x: e.position.x, y: e.position.y, z: e.position.z }, path: rec.path || null });
        }
        let k = 0;
        for (const job of this.jobs.values()) {
            if (!['running', 'paused', 'ready'].includes(job.state)) continue;
            if (job.kind === 'pit') {
                for (const reg of job.impl.ledger.regions.values()) {
                    const m = reg.meta, rows = Math.max(1, reg.rows || 1), layer = Math.min(reg.layers ? reg.layers - 1 : 0, Math.floor(reg.doneN / rows));
                    lanes.push({ job: job.id, id: reg.id, color: k++, box: { x0: m.x0, x1: m.x1, z0: m.z0, z1: m.z1 }, rim: m.top, activeY: Math.max(m.bottom, m.top - layer) });
                }
            } else {
                const b = this._jobBox(job); if (b && Number.isFinite(b.x0)) lanes.push({ job: job.id, id: 'build', color: k++, box: b, rim: b.y1, activeY: b.y0 });
            }
        }
        for (const s of this.sites.list()) {
            let end = null; try { end = this.sites.through(s.x, s.y, s.z); } catch (_) { /* a broken link is not drawn */ }
            tags.push({ name: s.name, x: s.x, y: s.y, z: s.z, machine: s.tags.includes('machine'), end });
        }
        return { bots, lanes, tags };
    }
}

module.exports = { DisplayPart, DEFAULTS };
