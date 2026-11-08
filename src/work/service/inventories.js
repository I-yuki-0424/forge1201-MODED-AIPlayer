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

    /**
     * An Ender Storage chest: the console cannot reach its items (they belong to the colours, not to the block: `data get block` has no Items, `item replace` cannot write them).
     * Read: the world's saved storage (after a save-all flush, at most once in 8 s). Null when the target is not such a chest. Moving stacks is refused in `moveStack`.
     */
    async _enderView(t) {
        if (!t || t.type !== 'block') return null;
        const es = require('../world/enderstorage'), site = this.sites.at(t.x, t.y, t.z), name = this._blockName(t.x, t.y, t.z);
        if (!(site && site.ender) && !(name && es.isMod(name))) return null;
        let freq = site && site.ender;
        if (!freq && this.o.rcon) {
            const m = /left: (\d+).*?middle: (\d+).*?right: (\d+)|middle: (\d+).*?left: (\d+).*?right: (\d+)/s.exec(String(await this.rcon(`data get block ${t.x} ${t.y} ${t.z} Frequency`)));
            if (m) { const n = m[1] !== undefined ? [m[1], m[2], m[3]] : [m[5], m[4], m[6]]; freq = es.frequency({ left: Number(n[0]), middle: Number(n[1]), right: Number(n[2]) }); }
        }
        need(freq, 'cannot tell which colours this Ender Storage chest has (tag it with its colours on the Tags page)', 409);
        if (this.o.rcon && Date.now() - (this._enderSaved || 0) > 8000) { this._enderSaved = Date.now(); try { await this.rcon('save-all flush'); } catch (_) { /* the file as it is */ } }
        const store = await es.readStore(this.o.worldDir || null), f = store && store.frequencies.find((q) => q.key === es.keyOf(freq));
        const view = (s) => { const tg = s.tag || {}; return { slot: s.slot, id: s.id, count: s.count, label: null, damage: typeof tg.Damage === 'number' ? tg.Damage : null, enchanted: !!(tg.Enchantments && tg.Enchantments.length), nbt: s.tag ? JSON.stringify(s.tag).slice(0, 400) : null }; };
        return { kind: 'container', id: 'enderstorage:ender_chest', size: f ? f.size : 27, slots: f ? f.slots.map(view) : [], readOnly: true,
            note: `colours ${es.label(freq)}; read from the world's saved storage${store ? '' : ' (world folder not mounted: unknown)'}; stacks are moved by a bot (deposit / withdraw), not here` };
    }
    _isEnder(t) {
        if (!t || t.type !== 'block') return false;
        const site = this.sites.at(t.x, t.y, t.z), name = this._blockName(t.x, t.y, t.z);
        return !!((site && site.ender) || (name && require('../world/enderstorage').isMod(name)));
    }

    async inventory(target) {
        let t; try { t = this._linkTarget(inventory.target(target)); } catch (e) { throw new Problem(e.message); }
        const ender = await this._enderView(t); if (ender) return ender;
        if (!this.o.rcon) {
            const rec = t.type === 'entity' ? this.bots.get(t.name) : null;
            need(rec && rec.state === 'online', 'RCON is not configured: only bots can be read (no stack details)', 503);
            return this._durability(this._botSlots(rec));
        }
        try { return this._durability(await inventory.read(this._run(), t)); } catch (e) { throw e instanceof Problem ? e : new Problem(e.message, /not configured/.test(e.message) ? 503 : 409); }
    }

    async moveStack({ src, srcSlot, dst, dstSlot = null }) {
        need(this.o.rcon, 'moving items needs RCON', 503);
        need(!this._isEnder(src) && !this._isEnder(dst), 'an Ender Storage chest cannot be filled or emptied from the console (its items belong to its colours): use a bot, deposit / withdraw on the Commands page', 409);
        try {
            const r = await inventory.move(this._run(), this._linkTarget(src), srcSlot, this._linkTarget(dst), dstSlot);
            this.note('info', `moved ${r.moved.count} ${r.moved.id.replace('minecraft:', '')}: ${this._who(src)}[${r.from}] -> ${this._who(dst)}[${r.to}]`);
            return r;
        } catch (e) { throw e instanceof Problem ? e : new Problem(e.message, 409); }
    }
    async moveAllStacks({ src, dst }) {
        need(this.o.rcon, 'moving items needs RCON', 503);
        need(!this._isEnder(src) && !this._isEnder(dst), 'an Ender Storage chest cannot be filled or emptied from the console (its items belong to its colours): use a bot, deposit / withdraw on the Commands page', 409);
        try { const r = await inventory.moveAll(this._run(), this._linkTarget(src), this._linkTarget(dst)); this.note('info', `moved ${r.moved.length} stacks ${this._who(src)} -> ${this._who(dst)}${r.stopped ? ' (stopped: ' + r.stopped + ')' : ''}`); return r; }
        catch (e) { throw e instanceof Problem ? e : new Problem(e.message, 409); }
    }
    _who(t) { return t && t.type === 'entity' ? t.name : t && t.type === 'block' ? `${t.x},${t.y},${t.z}` : '?'; }
}

module.exports = { InventoriesPart };
