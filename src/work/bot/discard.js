'use strict';
// Getting rid of surplus items without the trash-throwing loop (owner 2026-11-06, 1-2). A bot that tosses cobblestone next to
// another bot that has free slots gets it thrown back; two bots can do that to each other forever. In the owner's order:
//   1. take the items out of the game: the server command `clear <bot> <item> <count>` (no item entity ever exists, nothing to pick up)
//   2. else carry them to a place where no job is active (and no other bot stands) and toss them there (dumpSpot)
//   3. else (no RCON, no known jobs) the plain toss, as before
// Not picking low-value drops up at all (option 3 of the note) is left out: it raises the world's entity load.
const PASSABLE = new Set(['air', 'climb']);
const NAME = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/;
const BOT = /^[A-Za-z0-9_]{1,16}$/;

/** The id the server wants: namespaced ids are kept, bare names are vanilla. */
const gameId = (item) => (item.includes(':') ? item : `minecraft:${item}`);

/**
 * Option 1. `rcon(cmd)` -> reply text; `count(item)` -> how many the bot holds now (to see the inventory follow). Returns
 * {ok, how: 'clear', removed} or {ok: false, reason} (the caller falls back).
 */
function makeClear({ rcon, name, count, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    if (!rcon || !BOT.test(name || '')) return null;
    return async (item, n, { damage } = {}) => {
        if (!NAME.test(item) || !Number.isInteger(n) || n < 1 || n > 2304) return { ok: false, reason: 'invalid_args' };
        if (damage !== undefined && !(Number.isInteger(damage) && damage >= 0 && damage < 100000)) return { ok: false, reason: 'invalid_args' };
        const before = count(item);
        let reply;
        // `damage`: one stack, the one with exactly this much wear (item NBT predicate), so that a good tool of the same name is not taken.
        try { reply = String(await rcon(`clear ${name} ${gameId(item)}${damage !== undefined ? `{Damage:${damage}}` : ''} ${n}`)); } catch (e) { return { ok: false, reason: 'refused', detail: { message: String(e.message).slice(0, 80) } }; }
        const m = /Removed (\d+)/i.exec(reply);
        if (!m || +m[1] < 1) return { ok: false, reason: 'refused', detail: { server: reply.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 100) } };
        for (let i = 0; i < 20 && count(item) > before - Math.min(n, +m[1]); i++) await sleep(100);       // the client's inventory follows the server's packet
        return { ok: true, how: 'clear', removed: +m[1] };
    };
}

/**
 * Option 2: a cell to dump at. Outside every box in `avoid` widened by `margin`, at least `apart` blocks from every position in
 * `others`, standable (floor, two free cells) at a height near `from`. Rings of growing radius around the bot, so the walk is short.
 * Pure; `w` is only read. Returns {x, y, z} or null.
 */
function dumpSpot(w, from, { avoid = [], others = [], margin = 12, apart = 8, maxR = 80, dyMax = 8 } = {}) {
    const free = (x, z) => !avoid.some((b) => x >= b.x0 - margin && x <= b.x1 + margin && z >= b.z0 - margin && z <= b.z1 + margin)
        && !others.some((o) => Math.hypot(o.x - x, o.z - z) < apart);
    const stand = (x, z) => {
        for (let d = 0; d <= dyMax; d++) for (const y of d ? [from.y + d, from.y - d] : [from.y]) {
            if (PASSABLE.has(w.kindAt(x, y, z)) && PASSABLE.has(w.kindAt(x, y + 1, z)) && w.kindAt(x, y - 1, z) === 'solid') return { x, y, z };
        }
        return null;
    };
    for (let r = 4; r <= maxR; r += 4) {
        for (let k = 0; k < 16; k++) {
            const a = (k / 16) * 2 * Math.PI, x = Math.round(from.x + r * Math.cos(a)), z = Math.round(from.z + r * Math.sin(a));
            if (!free(x, z)) continue;
            const s = stand(x, z); if (s) return s;
        }
    }
    return null;
}

/**
 * Dispose of `count` of `item` as the best available option. `env`: discard (option 1, may be null), dumpSpot() -> cell|null (option 2,
 * may be absent), exec(name, args), here(). Returns the last command's result with `how`.
 */
async function dispose(env, item, count) {
    if (env.discard) { const r = await env.discard(item, count); if (r.ok) return r; }
    const spot = env.dumpSpot && env.dumpSpot();
    if (spot) {
        const back = env.here && env.here();
        const m = await env.exec('move_to', spot);
        if (m.ok) {
            const t = await env.exec('toss', { item, count });
            if (back) await env.exec('move_to', back);                 // a failed walk back only costs time: the next unit walks again
            return { ...t, how: 'dump' };
        }
    }
    return { ...(await env.exec('toss', { item, count })), how: 'toss' };
}

module.exports = { makeClear, dumpSpot, dispose, gameId };
