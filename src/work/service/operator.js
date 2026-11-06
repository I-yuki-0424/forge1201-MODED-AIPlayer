'use strict';
// What needs RCON: players, terrain height, kits and materials (operator `give`).
// A part of WorkService (index.js copies these methods onto it).
const { need, int, ITEM_ID, PLAYER_NAME, MIN_Y, MAX_Y } = require('./common');

class OperatorPart {
    async rcon(cmd) {
        need(this.o.rcon, 'RCON is not configured (RCON_PASSWORD)', 503);
        const run = async () => {
            if (this.o.rcon.command) return this.o.rcon.command(cmd);                  // an injected client (tests)
            if (!this._rcon) { const { Rcon } = require('../../rl/rcon'); const r = new Rcon({ ...this.o.rcon, timeoutMs: 8000 }); await r.connect(); this._rcon = r; }
            try { return await this._rcon.command(cmd); } catch (e) { try { this._rcon.close(); } catch (_) { /* gone */ } this._rcon = null; throw e; }
        };
        const p = this._rconTail.then(run); this._rconTail = p.catch(() => {});
        return p;
    }

    /** Players on the server with their position (RCON: `list`, `data get entity`). Bots are listed too, flagged. */
    async players() {
        const list = await this.rcon('list');
        const m = /:\s*(.*)$/.exec(String(list).replace(/\x1b\[[0-9;]*m/g, '').trim());
        const names = (m && m[1] ? m[1].split(',').map((s) => s.trim()).filter((s) => PLAYER_NAME.test(s)) : []);
        const out = [];
        for (const name of names) {
            const p = { name, bot: this.bots.has(name), pos: null, dimension: null };
            try {
                const pos = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(await this.rcon(`data get entity ${name} Pos`));
                if (pos) p.pos = { x: Math.floor(Number(pos[1])), y: Math.floor(Number(pos[2])), z: Math.floor(Number(pos[3])) };
                const dim = /"([a-z0-9_:]+)"/.exec(await this.rcon(`data get entity ${name} Dimension`));
                if (dim) p.dimension = dim[1];
            } catch (_) { /* position unknown */ }
            out.push(p);
        }
        return out;
    }

    /** Top solid block (not leaves or logs) at x,z from the chunks a bot has loaded; null when nothing is loaded there. */
    surface(x, z) {
        int(x, 'x'); int(z, 'z');
        const rec = [...this.bots.values()].find((r) => r.state === 'online' && r.bot);
        need(rec, 'no bot online to read the terrain', 503);
        const w = require('../../skills/world').fromBot(rec.bot);
        if (w.kindAt(x, 64, z) === 'unknown') return { y: null, why: 'chunk not loaded near any bot' };
        for (let y = MAX_Y; y >= MIN_Y; y--) {
            if (w.kindAt(x, y, z) !== 'solid') continue;
            if (/leaves|_log$|_wood$/.test(w.nameAt(x, y, z) || '')) continue;
            return { y, block: w.nameAt(x, y, z) };
        }
        return { y: null, why: 'no ground' };
    }

    /** Bring a bot's inventory up to the kit minimums with `give` (operator action through RCON). */
    async kitBot(name, { quiet = false } = {}) {
        need(this.o.rcon, 'RCON is not configured (RCON_PASSWORD)', 503);
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        need(rec.state === 'online', `bot ${name} is ${rec.state}`, 409);
        const have = (re) => rec.bot.inventory.items().reduce((n, i) => n + (i.name === re ? i.count : 0), 0);
        const given = [];
        for (const [item, k] of Object.entries(this.o.kit)) {
            need(ITEM_ID.test(item), 'kit item id');
            if (have(item) >= k.min) continue;
            await this.rcon(`give ${name} ${item.includes(':') ? item : 'minecraft:' + item} ${Math.max(1, Math.min(2304, k.give | 0))}`);
            given.push(`${item} x${k.give}`);
        }
        if (given.length && !quiet) this.note('info', `kit for ${name}: ${given.join(', ')}`);
        rec.retired = null;
        if (rec.job) this._resume(rec);
        return { given };
    }

    /** Give the materials a build job needs, split over its bots (or the named one). One `give` per item and bot. */
    async supply(id, botName = null) {
        const job = this._job(id);
        need(job.kind === 'build' && job.summary, 'only build jobs have materials', 409);
        const names = botName ? [botName] : [...job.bots];
        need(names.length, 'no bots assigned', 409);
        for (const n of names) need(this.bots.get(n)?.state === 'online', `bot ${n} is not online`, 409);
        const given = {};
        // Scaffold stairs are built from cheap blocks (build.js: K(K+1)/2 for K layers above the ground) and eat the same
        // cobblestone the structure may need: add them per bot (live run: both bots ran dry).
        const K = Math.min(10, Math.max(0, job.impl.plan.layers - 1)), margin = K ? (K * (K + 1)) / 2 + 8 : 0;
        const mats = { ...job.summary.materials };
        if (margin) mats.cobblestone = (mats.cobblestone || 0) + margin * names.length;
        for (const [item, total] of Object.entries(mats)) {
            need(ITEM_ID.test(item), 'item id');
            const each = Math.ceil(total / names.length);
            for (const n of names) {
                let left = each;
                while (left > 0) { const c = Math.min(left, 64 * 9); await this.rcon(`give ${n} ${item.includes(':') ? item : 'minecraft:' + item} ${c}`); left -= c; }
            }
            given[item] = each * names.length;
        }
        this.note('info', `materials for ${job.id} given to ${names.join(', ')}`);
        return { given };
    }
}

module.exports = { OperatorPart };
