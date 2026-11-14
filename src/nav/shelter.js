'use strict';
// NAV, the night (docs/implemented/NAV-v1.md). Normal difficulty, no armour: on the T26 worlds every bot sent out at night died within five minutes (creepers, zombies,
// a skeleton, a drowned; 2026-11-14). What a player without armour does: dig in. Three blocks straight down, one block over the head, wait for the morning, take the block away, climb out.
// The cover is a registered temporary block (temps.js, kind scaffold) and is broken before the bot leaves; the hole is left (a dug cell, not a placed block).
const P = require('./plan');
const fixtures = require('../skills/fixtures');

const NIGHT_FROM = 12800, NIGHT_TO = 23400;          // hostile mobs spawn in the open about 13000-23000; zombies and skeletons burn soon after 23400
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is it night where the bot is (Overworld clock)? null when the server sent no time. */
function isNight(bot) {
    const t = bot && bot.time && bot.time.timeOfDay;
    if (!Number.isFinite(t)) return null;
    return t >= NIGHT_FROM && t < NIGHT_TO;
}

/** Can the bot dig in where it stands: three diggable cells under the feet with nothing fluid beside them, and solid ground under the third? */
function canDigIn(w, f, dig) {
    const V = P.view(w, { dig });
    for (let d = 1; d <= 3; d++) if (V.digCost(f.x, f.y - d, f.z) === null) return false;
    return w.kindAt(f.x, f.y - 4, f.z) === 'solid';
}

/**
 * Dig in and wait for the morning. `env`: exec, here, w, bot, temps; `dig(name)`: the walker's dig cost. Returns {ok, waited (s), reason?}. Does nothing (ok, waited 0) by day.
 * Gives up the shelter (and walks on) when no cell within two blocks can be dug into.
 */
async function shelter(env, dig, { maxWaitMs = 12 * 60000, cancel = null } = {}) {
    const bot = env.bot, w = env.w;
    if (!isNight(bot)) return { ok: true, waited: 0 };
    let f = env.here();
    if (!canDigIn(w, f, dig)) {
        const near = [];
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) { const c = { x: f.x + dx, y: f.y, z: f.z + dz }; if ((dx || dz) && P.nodeKindOf(P.view(w), c.x, c.y, c.z, false) === 'stand' && canDigIn(w, c, dig)) near.push(c); }
        near.sort((a, b) => Math.hypot(a.x - f.x, a.z - f.z) - Math.hypot(b.x - f.x, b.z - f.z));
        let moved = false;
        for (const c of near.slice(0, 3)) { if ((await env.exec('move_to', c, { raw: true, maxTicks: 120 })).ok) { moved = true; break; } }
        f = env.here();
        if (!moved || !canDigIn(w, f, dig)) return { ok: false, reason: 'no_shelter', waited: 0 };
    }
    const top = { ...f };
    for (let d = 1; d <= 3; d++) {
        const c = { x: top.x, y: top.y - d, z: top.z };
        const m = await env.exec('mine', { ...c, collect: true }, { raw: true, maxTicks: 300 });
        if (!m.ok && w.kindAt(c.x, c.y, c.z) === 'solid') return { ok: false, reason: m.reason || 'stuck', waited: 0 };
        for (let i = 0; i < 30 && env.here().y > c.y; i++) await sleep(100);
    }
    // the cover over the head: the original floor cell, held up by the ground beside it
    const cover = { x: top.x, y: top.y - 1, z: top.z }, T = bot.__temps, dim = fixtures.dimOf(bot);
    const item = env.tempItem ? env.tempItem(1) : null;
    let covered = false;
    if (item) {
        if (T) T.add({ dim, ...cover, item, kind: 'scaffold', by: bot.username });
        const p = await env.exec('place', { ...cover, item }, { raw: true, maxTicks: 160 });
        covered = !!p.ok || w.kindAt(cover.x, cover.y, cover.z) === 'solid';
        if (!covered && T) T.remove(dim, cover);
    }
    const t0 = Date.now();
    while (isNight(bot) && Date.now() - t0 < maxWaitMs) {
        if (cancel && cancel.cancelled) break;
        if (bot.food !== undefined && bot.food <= 14) await env.exec('eat', {}, { raw: true, maxTicks: 200 });
        await sleep(2000);
    }
    if (covered) {
        const m = await env.exec('mine', { ...cover, collect: true }, { raw: true, maxTicks: 200 });
        if ((m.ok || w.kindAt(cover.x, cover.y, cover.z) !== 'solid') && T) T.remove(dim, cover);
    }
    return { ok: true, waited: Math.round((Date.now() - t0) / 1000), covered };
}

module.exports = { shelter, isNight, canDigIn, NIGHT_FROM, NIGHT_TO };
