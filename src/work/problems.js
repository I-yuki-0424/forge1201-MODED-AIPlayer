'use strict';
// Problem bots are made visible (owner 2026-11-06, 2-2): when a bot hits a problem it GLOWS in the game (the `glowing` effect shows
// through blocks, so a crowd of bots can be looked at from above), and the problem is written down with where, which way the bot
// faced, what it stood on and ran into, and when. An unexplained problem (the pioneer's "one block lower at z 3 and 33, the bot
// jumps and gets stuck") then shows its common factors: `common()` counts them. The same record serves 1-1 (pit leftovers).
const fs = require('fs');

const HEADING = ['south', 'west', 'north', 'east'];            // Minecraft yaw 0 = south (+z), 90 = west (-x), 180 = north, 270 = east
const BOT = /^[A-Za-z0-9_]{1,16}$/;
const GLOW_SECONDS = 120;

/** Facing of a Mineflayer yaw (radians, 0 = north in Mineflayer's convention: forward is (-sin, -cos)). */
function headingOf(yaw) {
    const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
    return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north');
}

/** What a bot stands in, on, and faces, from its position and the world model `w` (nameAt). */
function surroundings(bot, w) {
    const p = bot.entity && bot.entity.position;
    if (!p) return null;
    const fx = Math.floor(p.x), fy = Math.floor(p.y + 0.2), fz = Math.floor(p.z), h = headingOf(bot.entity.yaw || 0);
    const d = { east: [1, 0], west: [-1, 0], south: [0, 1], north: [0, -1] }[h];
    const nm = (x, y, z) => { try { return (w && w.nameAt(x, y, z)) || null; } catch (_) { return null; } };
    return {
        pos: [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(p.z * 10) / 10], cell: [fx, fy, fz], heading: h,
        in: nm(fx, fy, fz), below: nm(fx, fy - 1, fz), ahead: nm(fx + d[0], fy, fz + d[1]), ahead_up: nm(fx + d[0], fy + 1, fz + d[1]), step_up: nm(fx + d[0], fy + 2, fz + d[1]),
        onGround: !!bot.entity.onGround,
    };
}

class Problems {
    /** @param file JSONL file to append to (or null); `max` entries are kept in memory. */
    constructor({ file = null, max = 300, now = Date.now } = {}) { Object.assign(this, { file, max, now }); this.list = []; this.glowing = new Map(); }

    /** Write one problem down. `e`: {bot, kind, reason?, stage?, job?, region?, unit?, cell?, why?} + `ctx` from surroundings(). */
    record(e, ctx = null) {
        const row = { t: this.now(), ...e, ...(ctx || {}) };
        for (const k of Object.keys(row)) if (row[k] === undefined || row[k] === null) delete row[k];
        this.list.push(row); if (this.list.length > this.max) this.list.shift();
        if (this.file) { try { fs.appendFileSync(this.file, JSON.stringify(row) + '\n'); } catch (_) { /* the log is a convenience */ } }
        return row;
    }

    recent(n = 100) { return this.list.slice(-n); }

    /**
     * What the problems have in common: counts per factor (reason, stage, kind, heading, the block stood on and the one ahead,
     * height, the chunk-relative x and z and the absolute z, and the minute of the day), most frequent first, only values seen twice
     * or more. Several bots failing at the same coordinate is exactly the thing to look for.
     */
    common(n = 8) {
        const tally = {};
        const add = (f, v) => { if (v === undefined || v === null) return; const m = (tally[f] = tally[f] || new Map()); m.set(String(v), (m.get(String(v)) || 0) + 1); };
        for (const r of this.list) {
            add('reason', r.reason); add('stage', r.stage); add('kind', r.kind); add('heading', r.heading); add('below', r.below); add('ahead', r.ahead); add('job', r.job);
            if (r.cell) { add('y', r.cell[1]); add('x_in_chunk', ((r.cell[0] % 16) + 16) % 16); add('z_in_chunk', ((r.cell[2] % 16) + 16) % 16); add('z', r.cell[2]); add('x', r.cell[0]); add('cell', r.cell.join(',')); }
        }
        const out = {};
        for (const [f, m] of Object.entries(tally)) {
            const top = [...m].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, n).map(([value, count]) => ({ value, count }));
            if (top.length) out[f] = top;
        }
        return { total: this.list.length, factors: out };
    }

    // ---- the glow: `rcon(cmd)` is the server console; the effect lasts GLOW_SECONDS and is renewed by every new problem
    async glow(rcon, name) {
        if (!rcon || !BOT.test(name)) return false;
        this.glowing.set(name, this.now());
        try { await rcon(`effect give ${name} minecraft:glowing ${GLOW_SECONDS} 0 true`); return true; } catch (_) { return false; }
    }
    async unglow(rcon, name) {
        if (!rcon || !BOT.test(name) || !this.glowing.delete(name)) return false;
        try { await rcon(`effect clear ${name} minecraft:glowing`); return true; } catch (_) { return false; }
    }
}

module.exports = { Problems, surroundings, headingOf, GLOW_SECONDS };
