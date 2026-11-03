'use strict';
// What hurt the bot, per command (TASK-20261103-031): the server's own damage events, so "why did it die" is measured, not
// inferred. A 1.20 server sends `damage_event` {entityId, sourceTypeId, sourceCauseId (entity id + 1 of the attacker, 0 = none),
// sourceDirectId (the projectile, if any)} and `death_combat_event` {message: chat component with the death translation key}.
// The damage-type id is a registry index; the names come from the login packet's codec. The amount is the health drop the next
// `health` event shows. `take()` hands out the rows of one command (event log field `dmg`).

/** Damage type names by registry id from the login packet's dimension codec (NBT), [] when it cannot be read. */
function damageTypeNames(codec) {
    try {
        const reg = require('prismarine-nbt').simplify(codec)['minecraft:damage_type'];
        const out = [];
        for (const e of (reg && reg.value) || []) out[e.id] = String(e.name).replace(/^minecraft:/, '');
        return out;
    } catch (_) { return []; }
}

/** `death.attack.mob` -> 'death.attack.mob'; the attacker's name is kept as a second part: 'death.attack.mob:Zombie'. */
function deathKey(message) {
    try {
        const m = typeof message === 'string' ? JSON.parse(message) : message;
        const who = m.with && m.with[1] && (m.with[1].text || (m.with[1].with && m.with[1].with[0] && m.with[1].with[0].text) || m.with[1].translate);
        return String(m.translate || m.text || '?') + (who ? `:${String(who).slice(0, 40)}` : '');
    } catch (_) { return String(message).slice(0, 80); }
}

class DamageLog {
    constructor(bot, { cap = 40 } = {}) {
        this.bot = bot; this.rows = []; this.types = []; this.cap = cap; this.tick = 0; this.hp = bot.health;
        const c = bot._client;
        c.on('login', (p) => { this.types = damageTypeNames(p.dimensionCodec); });
        c.on('damage_event', (p) => this.onDamage(p));
        c.on('death_combat_event', (p) => this.push({ k: 'death', msg: deathKey(p.message) }));
        bot.on('health', () => this.onHealth());
        bot.on('physicsTick', () => { this.tick++; });
    }

    push(row) { if (this.rows.length < this.cap) this.rows.push({ t: this.tick, ...row }); }

    name(id) { const e = this.bot.entities[id]; return e ? (e.name || e.type || '?') : null; }

    onDamage(p) {
        const me = this.bot.entity;
        if (!me || p.entityId !== me.id) return;
        const by = p.sourceCauseId ? this.name(p.sourceCauseId - 1) : null, direct = p.sourceDirectId ? this.name(p.sourceDirectId - 1) : null;
        const src = this.bot.entities[(p.sourceCauseId || p.sourceDirectId) - 1];
        const row = { k: 'hit', src: this.types[p.sourceTypeId] || `type${p.sourceTypeId}`, by, direct: direct && direct !== by ? direct : undefined,
            dist: src && src.position ? Math.round(src.position.distanceTo(me.position) * 10) / 10 : undefined, d: undefined };
        // The health update can come first (a melee hit in run val: 65 hp of 250 had no hit row): the amount is then already in a
        // `loss` row of the last 3 ticks, which this event explains.
        const last = this.rows[this.rows.length - 1];
        if (last && last.k === 'loss' && this.tick - last.t <= 3) { row.d = last.d; this.rows.pop(); }
        this.push(row);
    }

    onHealth() {
        const hp = this.bot.health;
        if (!Number.isFinite(this.hp)) { this.hp = hp; return; }    // the first health packet after connecting is a baseline, not damage
        const drop = this.hp - hp;
        this.hp = hp;
        if (drop <= 0) return;
        // The amount belongs to the newest hit row without one from the last 3 ticks; a drop with no hit event (starvation,
        // a server that sends none) is its own row.
        for (let i = this.rows.length - 1; i >= 0 && this.tick - this.rows[i].t <= 3; i--) {
            if (this.rows[i].k === 'hit' && this.rows[i].d === undefined) { this.rows[i].d = Math.round(drop * 100) / 100; return; }
        }
        this.push({ k: 'loss', d: Math.round(drop * 100) / 100 });
    }

    /** The rows since the last call (empty array when nothing hurt the bot). */
    take() { const r = this.rows; this.rows = []; return r; }
}

module.exports = { DamageLog, damageTypeNames, deathKey };
