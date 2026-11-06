'use strict';
// The roster: bots that connect, reconnect, and what the page shows about each.
// A part of WorkService (index.js copies these methods onto it).
const { need, BOT_NAME } = require('./common');

class BotsPart {
    addBot(name, { job = null } = {}) {
        need(typeof name === 'string' && BOT_NAME.test(name), 'bot name: 3-16 letters, digits or _');
        const have = this.bots.get(name);
        need(!have || have.removed, `bot ${name} exists`, 409);
        need([...this.bots.values()].filter((b) => !b.removed).length < this.o.maxBots, `at most ${this.o.maxBots} bots`, 409);
        const rec = { name, bot: null, state: 'connecting', job, worker: null, attempts: 0, error: null, removed: false, timer: null, retired: null, since: Date.now(), kitAt: 0 };
        this.bots.set(name, rec);
        this._connect(rec);
        this.note('info', `bot ${name} added`);
        this._dirty();
        return this._botView(rec);
    }

    _connect(rec) {
        if (rec.removed) return;
        rec.state = 'connecting'; rec.error = null;
        let bot;
        try { bot = this.factory(rec.name); } catch (e) { rec.error = String(e.message).slice(0, 200); return this._retry(rec); }
        rec.bot = bot;
        const mine = () => rec.bot === bot && !rec.removed;
        bot.once('spawn', () => { if (!mine()) return; rec.state = 'online'; rec.attempts = 0; rec.since = Date.now(); this.note('info', `bot ${rec.name} online`); this._tagDirect(rec); this._dirty(); this._resume(rec); });
        bot.on('spawn', () => { if (mine() && rec.state === 'online') setTimeout(() => this._resume(rec), 2500); });        // respawn after death
        bot.on('death', () => { if (mine()) this.note('warn', `bot ${rec.name} died`); });
        bot.on('error', (e) => { if (mine()) rec.error = String((e && e.message) || e).slice(0, 200); });
        bot.on('kicked', (r) => { if (mine()) { rec.error = `kicked: ${JSON.stringify(r).slice(0, 160)}`; this.note('warn', `bot ${rec.name} ${rec.error}`); } });
        bot.on('end', (why) => {
            if (!mine()) return;
            rec.state = 'offline'; this._stopWorker(rec);
            this.note('warn', `bot ${rec.name} disconnected${rec.error ? ': ' + rec.error : ''} (${String(why).slice(0, 60)})`);
            this._retry(rec); this._dirty();
        });
    }
    _retry(rec) {
        if (rec.removed) return;
        rec.state = 'offline';
        const wait = Math.min(60000, this.o.reconnectMs * 2 ** Math.min(rec.attempts++, 5));
        clearTimeout(rec.timer); rec.timer = setTimeout(() => this._connect(rec), wait); rec.timer.unref?.();
    }

    removeBot(name) {
        const rec = this.bots.get(name);
        need(rec && !rec.removed, `no bot ${name}`, 404);
        rec.removed = true; clearTimeout(rec.timer);
        this._stopWorker(rec);
        try { rec.bot && rec.bot.quit && rec.bot.quit(); } catch (_) { /* already gone */ }
        for (const j of this.jobs.values()) j.bots.delete(name);
        this.bots.delete(name);
        this.note('info', `bot ${name} removed`);
        this._dirty();
    }

    _botView(rec) {
        const b = rec.bot, e = b && b.entity && rec.state === 'online' ? b.entity : null;
        const items = b && b.inventory && rec.state === 'online' ? b.inventory.items() : [];
        const count = (re) => items.reduce((n, i) => n + (re.test(i.name) ? i.count : 0), 0);
        return {
            name: rec.name, state: rec.state, job: rec.job, working: !!rec.worker, retired: rec.retired, error: rec.error,
            cmd: rec.cmd ? { id: rec.cmd.id, name: rec.cmd.name, status: rec.cmd.status, since: rec.cmd.started, result: rec.cmd.result || null, progress: rec.cmd.progress || null } : null,
            pos: e ? { x: Math.round(e.position.x * 10) / 10, y: Math.round(e.position.y * 10) / 10, z: Math.round(e.position.z * 10) / 10 } : null,
            health: b && rec.state === 'online' ? b.health ?? null : null, food: b && rec.state === 'online' ? b.food ?? null : null,
            pickaxes: count(/_pickaxe$/), free: b && b.inventory && rec.state === 'online' ? b.inventory.emptySlotCount?.() ?? null : null,
            // tools with their durability, for the table and the summary: worn = the retireWorn rule passes them over
            tools: items.filter((i) => i.maxDurability && /(_pickaxe|_axe|_shovel|_hoe|_sword)$/.test(i.name)).slice(0, 12).map((i) => ({ name: i.name, left: i.maxDurability - (i.durabilityUsed || 0), max: i.maxDurability, worn: this._worn(b, i) })),
            script: rec.script ? rec.script.name : null,
            inPit: this._inPit(rec),
        };
    }
}

module.exports = { BotsPart };
