'use strict';
// Problems written down with surroundings, glow, direct pickup, running boxes.
// A part of WorkService (index.js copies these methods onto it).
const { surroundings } = require('../bot/problems');
const { BOT_NAME } = require('./common');

class DiagnosticsPart {
    /** Write a problem down with the bot's surroundings and make it glow. Never throws: it is a diagnostic aid. */
    _problem(rec, kind, e) {
        try {
            let ctx = null; try { ctx = rec.bot && rec.state === 'online' ? surroundings(rec.bot, require('../../skills/world').fromBot(rec.bot)) : null; } catch (_) { /* no world yet */ }
            const { cell: target, ...rest } = e;                       // `target` = the cell it failed on; `cell` (from the surroundings) = where the bot stood
            this.problems.record({ bot: rec.name, kind, ...rest, target, hp: rec.bot && rec.bot.health }, ctx);
            rec.problem = { kind, reason: e.reason || null, stage: e.stage || null, cell: target || (ctx && ctx.cell) || null, at: Date.now() };      // shown in the bots table until the next good unit
            if (this.settings.glow && this.o.rcon) this.problems.glow((c) => this.rcon(c), rec.name).catch(() => {});
            this._dirty();
        } catch (_) { /* diagnostic only */ }
    }
    _clearGlow(rec) {
        rec.problem = null; if (this.problems.glowing.has(rec.name) && this.o.rcon) this.problems.unglow((c) => this.rcon(c), rec.name).catch(() => {}); }

    /** The server's script (server_scripts/forgeaip_direct_pickup.js) gives drops of players tagged `aip_direct` straight to their inventory. */
    _tagDirect(rec, on = this.settings.directPickup) {
        if (!this.o.rcon || !BOT_NAME.test(rec.name)) return;
        this.rcon(`tag ${rec.name} ${on ? 'add' : 'remove'} aip_direct`).catch(() => {});
    }

    problemsView(n = 100) { return { recent: this.problems.recent(Math.min(300, Math.max(1, n | 0))), common: this.problems.common(), glowing: [...this.problems.glowing.keys()] }; }

    /** X-Z boxes of the jobs that are running (where no trash may be dumped). */
    _activeBoxes() {
        const out = [];
        for (const j of this.jobs.values()) {
            if (j.state !== 'running') continue;
            const b = this._jobBox(j); if (b && Number.isInteger(b.x0)) out.push({ x0: b.x0, x1: b.x1, z0: b.z0, z1: b.z1 });
        }
        return out;
    }
    /** Positions of the other online bots. */
    _botSpots(except) {
        const out = [];
        for (const r of this.bots.values()) if (r.name !== except && !r.removed && r.state === 'online' && r.bot && r.bot.entity) out.push({ x: r.bot.entity.position.x, z: r.bot.entity.position.z });
        return out;
    }
}

module.exports = { DiagnosticsPart };
