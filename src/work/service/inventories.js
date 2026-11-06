'use strict';
// Inventory pages: read and move stacks (bot, player, block) through RCON.
// A part of WorkService (index.js copies these methods onto it).
const inventory = require('../operator/inventory');
const { Problem, need } = require('./common');

class InventoriesPart {
    _run() { return (cmd) => this.rcon(cmd); }

    /** The bot's own view of its inventory (works without RCON; no stack NBT). Slots use the game's numbering. */
    /** Durability for the inventory page: `max` (uses of a new item, from any online bot's registry) next to `damage` (used), and `left`. */
    _durability(data) {
        const rec = [...this.bots.values()].find((r) => r.bot && r.bot.registry && r.state === 'online');
        if (!rec || !data || !Array.isArray(data.slots)) return data;
        for (const sl of data.slots) {
            const it = rec.bot.registry.itemsByName[String(sl.id).replace(/^minecraft:/, '')];
            if (it && it.maxDurability) {
                const used = Number(sl.damage) || 0;
                sl.max = it.maxDurability; sl.damage = used; sl.left = it.maxDurability - used;
            }
        }
        return data;
    }
    _botSlots(rec) {
        const map = (w) => (w >= 36 && w <= 44 ? w - 36 : w >= 9 && w <= 35 ? w : w === 5 ? 103 : w === 6 ? 102 : w === 7 ? 101 : w === 8 ? 100 : w === 45 ? -106 : null);
        const out = [];
        (rec.bot.inventory.slots || []).forEach((it, w) => { const s = map(w); if (it && s !== null) out.push({ slot: s, id: it.name.includes(':') ? it.name : `minecraft:${it.name}`, count: it.count, label: null, damage: it.maxDurability ? (it.durabilityUsed || 0) : null, enchanted: false, nbt: null }); });
        return { kind: 'player', size: 36, slots: out };
    }

    async inventory(target) {
        let t; try { t = this._linkTarget(inventory.target(target)); } catch (e) { throw new Problem(e.message); }
        if (!this.o.rcon) {
            const rec = t.type === 'entity' ? this.bots.get(t.name) : null;
            need(rec && rec.state === 'online', 'RCON is not configured: only bots can be read (no stack details)', 503);
            return this._durability(this._botSlots(rec));
        }
        try { return this._durability(await inventory.read(this._run(), t)); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message, /not configured/.test(e.message) ? 503 : 409); }
    }

    async moveStack({ src, srcSlot, dst, dstSlot = null }) {
        need(this.o.rcon, 'moving items needs RCON', 503);
        try {
            const r = await inventory.move(this._run(), this._linkTarget(src), srcSlot, this._linkTarget(dst), dstSlot);
            this.note('info', `moved ${r.moved.count} ${r.moved.id.replace('minecraft:', '')}: ${this._who(src)}[${r.from}] -> ${this._who(dst)}[${r.to}]`);
            return r;
        } catch (e) { throw e instanceof Problem ? e : new Problem(e.message, 409); }
    }
    async moveAllStacks({ src, dst }) {
        need(this.o.rcon, 'moving items needs RCON', 503);
        try { const r = await inventory.moveAll(this._run(), this._linkTarget(src), this._linkTarget(dst)); this.note('info', `moved ${r.moved.length} stacks ${this._who(src)} -> ${this._who(dst)}${r.stopped ? ' (stopped: ' + r.stopped + ')' : ''}`); return r; }
        catch (e) { throw e instanceof Problem ? e : new Problem(e.message, 409); }
    }
    _who(t) { return t && t.type === 'entity' ? t.name : t && t.type === 'block' ? `${t.x},${t.y},${t.z}` : '?'; }
}

module.exports = { InventoriesPart };
