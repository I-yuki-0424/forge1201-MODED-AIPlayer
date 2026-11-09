'use strict';
// Setting a respawn point at a bed (owner 2026-11-09): the bot touches the bed (the server sets the respawn point at the touch, day or night; at night the bot lies down, and
// wakes at once instead of sleeping until morning). Many bots are sent to one bed in a line (queue.js): one at a time, in name order, each with a time limit; a bot that cannot
// do it is sent away and the next one goes. The old version crowded them on one block and the first one slept on.
const Vec3 = require('vec3');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const blockAt = (bot, x, y, z) => bot.blockAt(new Vec3(x, y, z));          // mineflayer calls .floored() on the argument: a plain {x, y, z} throws (live 2026-11-09: set_spawn failed for all 20 bots)
const BED = /_bed$/;
const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** The bed block to use: the one at x y z when given (that cell must be a bed), else the nearest bed within `radius`. Returns the block or null. */
function findBed(bot, at = null, radius = 48) {
    if (at && Number.isInteger(at.x) && Number.isInteger(at.y) && Number.isInteger(at.z)) { const b = blockAt(bot, at.x, at.y, at.z); return b && BED.test(b.name) ? b : null; }
    return bot.findBlock({ matching: (b) => !!b && BED.test(b.name), maxDistance: radius }) || null;
}

/** One key for both halves of a bed, so that a bot at the foot and a bot at the head stand in the same line. */
function bedKey(bot, b) {
    const name = b.name; let best = { x: b.position.x, z: b.position.z, y: b.position.y };
    for (const [dx, dz] of SIDES) {
        const o = blockAt(bot, b.position.x + dx, b.position.y, b.position.z + dz);
        if (o && o.name === name && (o.position.x < best.x || (o.position.x === best.x && o.position.z < best.z))) best = { x: o.position.x, y: o.position.y, z: o.position.z };
    }
    return `bed:${best.x},${best.y},${best.z}`;
}

/** Standable cells next to a bed block (the server wants the bot within 3 blocks across and 2 up), nearest to `from` first. */
function standCells(w, bed, from) {
    const out = [];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const dy of [0, 1, -1]) {
        const x = bed.x + dx, y = bed.y + dy, z = bed.z + dz;
        if (!dx && !dz) continue;
        if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
        out.push({ x, y, z, d: Math.hypot(dx, dz) * 2 + Math.abs(from.x - x) * 0.01 + Math.abs(from.z - z) * 0.01 });
    }
    return out.sort((a, b) => a.d - b.d).map(({ x, y, z }) => ({ x, y, z }));
}

/** The respawn point the server holds for a player (RCON `data get entity`), or null. */
async function spawnOf(rcon, name) {
    const num = async (k) => { const r = String(await rcon(`data get entity ${name} ${k}`)).replace(/\x1b\[[0-9;]*m/g, ''); const m = /:\s*(-?\d+)\s*$/.exec(r.trim()); return m ? Number(m[1]) : null; };
    try { const x = await num('SpawnX'), y = await num('SpawnY'), z = await num('SpawnZ'); return x === null || z === null ? null : { x, y, z }; } catch (_) { return null; }
}

/**
 * Do it for one bot. `o`: { env (exec, here, w, sendAway), bot, gates, who, rcon?, at?, cancel, progress(p), waitMs, holdMs }.
 * Returns { ok, reason?, detail }: reasons invalid_target (no bed), timeout (waited too long or took too long), unreachable, not_confirmed (the server holds another spawn point), cancelled.
 */
async function setSpawn(o) {
    const { env, bot, gates, who, cancel } = o, w = env.w;
    const bed = findBed(bot, o.at);
    if (!bed) return { ok: false, reason: 'invalid_target', detail: { why: o.at ? 'no bed at that block' : 'no bed within 48 blocks (give x y z, or stand near one)' } };
    const key = bedKey(bot, bed), bedPos = { x: bed.position.x, y: bed.position.y, z: bed.position.z };
    let ticket = null, poll = null;
    if (gates) {
        poll = setInterval(() => { if (o.progress) o.progress({ queue: gates.gate(key).place(who) + 1, of: gates.gate(key).snapshot().length, bed: bedPos }); }, 1000); if (poll.unref) poll.unref();
        try { ticket = await gates.enter(key, who, { cancel, holdMs: o.holdMs, waitMs: o.waitMs }); }
        catch (e) { return { ok: false, reason: e.reason === 'cancelled' ? 'cancelled' : 'timeout', detail: { why: String(e.message).slice(0, 100), bed: bedPos } }; }
        finally { clearInterval(poll); }
    }
    const c = { get cancelled() { return !!(cancel && cancel.cancelled) || !!(ticket && ticket.evicted); } };
    const attempt = async () => {
        if (o.progress) o.progress({ turn: true, bed: bedPos });
        // Next to the bed first (one bot at a time stands there now), then the touch.
        let near = false;
        for (const cell of standCells(w, bedPos, env.here()).slice(0, 4)) {
            if (c.cancelled) break;
            const here = env.here();
            if (Math.abs(here.x - bedPos.x) <= 2 && Math.abs(here.z - bedPos.z) <= 2 && Math.abs(here.y - bedPos.y) <= 1) { near = true; break; }
            const m = await o.walk(cell, c); if (m && m.ok) { near = true; break; }
        }
        if (c.cancelled) return { ok: false, reason: ticket && ticket.evicted ? 'timeout' : 'cancelled', detail: { why: ticket && ticket.evicted ? 'took longer than the time limit at the bed' : 'cancelled', bed: bedPos } };
        if (!near) return { ok: false, reason: 'unreachable', detail: { why: 'no way to stand next to the bed', bed: bedPos } };
        const fresh = blockAt(bot, bedPos.x, bedPos.y, bedPos.z);
        if (!fresh || !BED.test(fresh.name)) return { ok: false, reason: 'invalid_target', detail: { why: 'the bed is gone', bed: bedPos } };
        await bot.lookAt(new Vec3(bedPos.x + 0.5, bedPos.y + 0.5, bedPos.z + 0.5), true).catch(() => {});
        let onSleep; const slept = new Promise((r) => { onSleep = () => r(true); bot.once('sleep', onSleep); });
        try { await bot.activateBlock(fresh); } catch (e) { bot.removeListener('sleep', onSleep); return { ok: false, reason: 'not_confirmed', detail: { why: `the touch failed: ${String(e.message).slice(0, 80)}`, bed: bedPos } }; }
        const lay = await Promise.race([slept, sleep(1500).then(() => false)]);
        bot.removeListener('sleep', onSleep);
        if (bot.isSleeping) { await sleep(300); try { await bot.wake(); } catch (_) { /* already up */ } }         // the respawn point is set when lying down: do not sleep until morning
        // The server's word: its stored spawn point is this bed (either half). Without RCON the touch itself is all there is.
        let sp = null;
        if (o.rcon) { await sleep(300); sp = await spawnOf(o.rcon, bot.username); }
        const same = sp && Math.abs(sp.x - bedPos.x) <= 1 && Math.abs(sp.z - bedPos.z) <= 1 && Math.abs(sp.y - bedPos.y) <= 1;
        if (o.rcon && !same) return { ok: false, reason: 'not_confirmed', detail: { why: sp ? `the server's respawn point is ${sp.x} ${sp.y} ${sp.z}, not this bed` : 'the server holds no respawn point for this bot', bed: bedPos, lay } };
        return { ok: true, detail: { bed: bedPos, lay, verified: !!o.rcon } };
    };
    let res;
    try { res = await attempt(); } finally { if (ticket) ticket.leave(); }
    // A bot that failed is sent a few blocks away: it must not stand on the bed's block while the next one comes.
    if (!res.ok && res.reason !== 'cancelled' && env.sendAway) { try { await env.sendAway(bedPos); } catch (_) { /* leaving is a courtesy */ } }
    return res;
}

module.exports = { setSpawn, findBed, bedKey, standCells, spawnOf };
