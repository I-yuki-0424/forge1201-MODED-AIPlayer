'use strict';
// "Collect N of X": the target (a block or an item name) is turned into the blocks that give it, the matching blocks are found in the
// chunks the bot has loaded (world data, no guessing), and they are mined nearest first. Because the next target is always the one
// nearest to where the bot stands NOW, everything within reach of one standing place is dug before the bot walks on: the existing
// `mine` only walks when the block is out of reach. Pure given `bot` (Mineflayer-like) and `execute` (the action layer), so it is tested
// without a server.
const { fromBot } = require('../../skills/world');

const ALIAS = { redstone_dust: 'redstone', cobble: 'cobblestone' };          // how a person writes it -> the registry's name
const bare = (n) => { const s = String(n).replace(/^minecraft:/, ''); return ALIAS[s] || s; };
const REACH = 4.5;
const REACH_FROM = 4.2;                          // how far from a block the router lets the bot work on it (the precondition's `max`); the cell must be one the bot can walk to
const MAX_DIG_IN = 4;                                // a buried block is reached by tunnelling at most this many blocks through solid rock
const FLUID = new Set(['water', 'liquid', 'danger']);          // never dig next to water or lava (it would flow into the hole)                                   // blocks within this distance of the eyes are mined without walking

/** { blocks: [names], item: name | null } for a block or item name, or null when nothing in the registry matches. */
function resolve(registry, target) {
    const name = bare(target), blocks = new Set();
    const item = registry.itemsByName[name] || null;
    if (registry.blocksByName[name]) { blocks.add(name); if (registry.blocksByName[`deepslate_${name}`] && /_ore$/.test(name)) blocks.add(`deepslate_${name}`); }
    if (item) for (const b of Object.values(registry.blocksByName)) {                       // every block that drops the item
        const drops = (b.drops || []).map((d) => (typeof d === 'object' ? (d.drop?.id ?? d.id) : d));
        if (drops.includes(item.id) && b.diggable !== false) blocks.add(b.name);
    }
    return blocks.size ? { blocks: [...blocks], item: item ? item.name : null } : null;
}

const countOf = (bot, item) => bot.inventory.items().reduce((n, i) => n + (i.name === item ? i.count : 0), 0);

/** Candidate cells sorted by distance from the bot: [{x, y, z, dist, exposed}]. `exposed` = a face touches air or a fluid (can be reached by digging only this block). */
function find(bot, spec, radius, skip = new Set()) {
    const reg = bot.registry, ids = spec.blocks.map((n) => reg.blocksByName[n].id);
    const w = fromBot(bot), me = bot.entity.position, out = [];
    for (const p of bot.findBlocks({ matching: ids, maxDistance: radius, count: 256 })) {
        const key = `${p.x},${p.y},${p.z}`; if (skip.has(key)) continue;
        const kinds = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]].map(([a, b, c]) => w.kindAt(p.x + a, p.y + b, p.z + c));
        const wet = kinds.some((k) => FLUID.has(k)), exposed = kinds.some((k) => k !== 'solid') && !wet;            // a block that touches water or lava is not safe to open
        out.push({ x: p.x, y: p.y, z: p.z, dist: Math.hypot(p.x + 0.5 - me.x, p.y + 0.5 - (me.y + 1.6), p.z + 0.5 - me.z), exposed, wet });
    }
    return out.sort((a, b) => (b.exposed - a.exposed) || a.dist - b.dist);
}

/**
 * The cells to dig, outermost first, to reach a buried block by tunnelling sideways or upwards into it: a shortest path through solid
 * cells from the target to a cell that touches open air beside it or below it, at most `max` cells long. `mine` never stands on the block
 * it breaks, so a path may not go DOWN from one cell to the next, and a cell whose only air is above it cannot be the entrance. Null when
 * there is no such path, or when the target or any cell of it touches water or lava.
 */
function digPath(w, target, max = MAX_DIG_IN) {
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], key = (c) => `${c.x},${c.y},${c.z}`;
    const wet = (c) => N.some(([a, b, d]) => FLUID.has(w.kindAt(c.x + a, c.y + b, c.z + d)));
    if (wet(target)) return null;
    const seen = new Map([[key(target), null]]); let frontier = [target];
    for (let depth = 0; depth < max && frontier.length; depth++) {
        const next = [];
        for (const c of frontier) for (const [a, b, d] of N) {
            if (b === 1) continue;                                              // n would be above c: the bot would have to dig down while standing on n
            const n = { x: c.x + a, y: c.y + b, z: c.z + d }, k = key(n);
            if (seen.has(k)) continue;
            if (w.kindAt(n.x, n.y, n.z) !== 'solid' || wet(n)) continue;
            seen.set(k, c);
            if (N.some(([e, f, g]) => f <= 0 && ['air', 'climb'].includes(w.kindAt(n.x + e, n.y + f, n.z + g)))) {       // open air beside or below n: the way in
                const path = []; for (let q = n; q && key(q) !== key(target); q = seen.get(key(q))) path.push(q);
                return path;                                                    // outermost cell first
            }
            next.push(n);
        }
        frontier = next;
    }
    return null;
}

/**
 * Everything to dig for a path from `digPath`, in order: each path cell followed by the cell above it (the bot has to be able to walk
 * in: it needs head room), then the cell above the target (so it can step in and pick up the drop). Cells that are already open are left
 * out. Null when any of them touches water or lava.
 */
function withHeadroom(w, path, target) {
    const N = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]], out = [];
    const wet = (c) => N.some(([a, b, d]) => FLUID.has(w.kindAt(c.x + a, c.y + b, c.z + d)));
    const add = (c) => { if (w.kindAt(c.x, c.y, c.z) === 'solid') { if (wet(c)) return false; out.push(c); } return true; };
    for (const q of path) { if (!add(q) || !add({ x: q.x, y: q.y + 1, z: q.z })) return null; }
    return add({ x: target.x, y: target.y + 1, z: target.z }) ? out : null;
}

/** True when some cell the planner can walk to (`reach`, from `reachableAsync`) lies within `r` blocks of the cell. */
const nearReach = (reach, c, r) => reach.cells.some((q) => Math.hypot(q[0] - c.x, q[1] + 1.62 - (c.y + 0.5), q[2] - c.z) <= r);          // a walkable cell whose EYES are within r of the block's centre

/**
 * The candidates `gather` can actually work: an exposed block the bot can walk up to (a walkable cell within reach of it), or a buried one with a short dig path whose entrance is a cell the bot can
 * walk to. Without `reach` (no planner) every candidate counts. Ore in a cave 20 levels down is exposed and nearest but no walk leads there (acceptance world 4, 2026-11-13).
 */
function workable(bot, all, reach) {
    if (!reach) return all.filter((c) => !c.wet);
    const w = fromBot(bot), me = bot.entity.position, here = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
    // The router's own question (src/stack/router.js standCells: a standing cell with the block in reach AND in view) answered against the planner's reach: the same decision the mining will meet.
    // A cheap distance test first, the exact one for the nearest few only (it casts rays).
    const standOk = (cell) => { const sc = require('../../stack/router').standCells; return sc({ w }, { kind: 'block', name: 'mine', x: cell.x, y: cell.y, z: cell.z }, here).some((q) => reach.has(q.x, q.y, q.z)); };
    const cheap = all.filter((c) => {
        if (c.wet) return false;
        if (c.exposed) return nearReach(reach, c, REACH_FROM - 0.4);
        const core = digPath(w, c), path = core && withHeadroom(w, core, c);
        return !!path && nearReach(reach, core[0] || c, REACH_FROM - 0.4);
    }).sort((a, b) => a.dist - b.dist);
    const out = []; let tested = 0;                                              // the nearest that pass: the first ones are often under the bot's feet or in a wall it cannot stand against
    for (const c of cheap) {
        if (out.length >= 12 || tested >= 60) break;
        tested++;
        if (c.exposed ? standOk(c) : standOk((digPath(w, c) || [c])[0] || c)) out.push(c);
    }
    return out;
}

/** What `gather` would work with: for the page's "Find" button. */
function survey(bot, target, radius) {
    const spec = resolve(bot.registry, target);
    if (!spec) return { ok: false, why: `${bare(target)} is neither a block nor an item of this world` };
    const all = find(bot, spec, radius);
    return { ok: true, blocks: spec.blocks, item: spec.item, total: all.length, wet: all.filter((c) => c.wet).length, exposed: all.filter((c) => c.exposed).length, inReach: all.filter((c) => c.exposed && c.dist <= REACH).length, nearest: all.slice(0, 8).map((c) => ({ x: c.x, y: c.y, z: c.z, dist: Math.round(c.dist * 10) / 10, exposed: c.exposed })) };
}

/**
 * Collect `count` of `target`. Returns { ok, reason, detail: { got, want, mined, walked, ... } }.
 * opts: { cancel, execute(bot, name, args, {cancel}), onProgress({got, want, mined}) }
 */
async function gather(bot, { target, count = 16, radius = 32 }, { cancel = { cancelled: false }, execute, onProgress = () => {}, reach: reachOf = null } = {}) {
    const spec = resolve(bot.registry, target);
    if (!spec) return { ok: false, reason: 'invalid_args', detail: { why: `${bare(target)} is neither a block nor an item of this world` } };
    const item = spec.item, base = item ? countOf(bot, item) : 0;
    let mined = 0, tunnelled = 0, tries = 0, unreached = 0, lastFail = null, lastDetail = null; const skip = new Set(), t0 = Date.now();
    const got = () => (item ? countOf(bot, item) - base : mined);
    onProgress({ got: 0, want: count, mined });
    while (got() < count) {
        if (cancel.cancelled) return { ok: false, reason: 'cancelled', detail: { got: got(), want: count, mined } };
        if (++tries > count * 4 + 20) return { ok: got() > 0, reason: got() > 0 ? null : 'stuck', detail: { got: got(), want: count, mined, why: 'too many attempts' } };
        const every = find(bot, spec, radius, skip), reach = reachOf ? await reachOf().catch(() => null) : null;
        const ok = reach ? new Set(workable(bot, every, reach).map((c) => `${c.x},${c.y},${c.z}`)) : null, all = ok ? every.filter((c) => ok.has(`${c.x},${c.y},${c.z}`)) : every;       // with the planner's reach only what can be worked
        let pick = all.find((c) => c.exposed);
        if (!pick) {                                                                         // everything left is buried: tunnel in to the nearest one that can be reached safely
            const w = fromBot(bot);
            for (const c of all.slice().sort((a, b) => a.dist - b.dist).slice(0, 12)) {
                const core = digPath(w, c), path = core && withHeadroom(w, core, c); if (!path) { skip.add(`${c.x},${c.y},${c.z}`); continue; }
                let dug = true;
                for (const q of path) { const r = await execute(bot, 'mine', q, { cancel }); if (!r.ok) { dug = false; lastFail = r.reason; lastDetail = r.detail || null; if (r.reason === 'missing_tool' || r.reason === 'cancelled' || r.reason === 'died' || r.reason === 'disconnected') return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), got: got(), want: count, mined, tunnelled } }; break; } tunnelled++; }
                if (dug) { pick = c; break; } skip.add(`${c.x},${c.y},${c.z}`);
            }
        }
        if (!pick) return { ok: got() > 0, reason: got() > 0 ? null : 'invalid_target', detail: { got: got(), want: count, mined, lastDetail: lastDetail ? JSON.stringify(lastDetail).slice(0, 400) : null, why: all.length ? `${all.length} found but none of them can be reached from here: they are deeper than ${MAX_DIG_IN} blocks into rock, below the bot (it cannot dig straight down), or next to water or lava. Walk the bot to a cave or a wall face near them, or tunnel first` : `none within ${radius} blocks in the chunks this bot has loaded`, lastFail } };
        const r = await execute(bot, 'mine', { x: pick.x, y: pick.y, z: pick.z }, { cancel });
        if (r.ok) {
            // The drop lay out of pickup range (the instruction does not walk): the pickup is its own instruction, the router's. A miss here costs the one drop, never the block that was broken.
            if (r.detail && r.detail.drop_missed && r.detail.drop) await execute(bot, 'pickup', { item: r.detail.drop }, { cancel }).catch(() => null);
            mined++; unreached = 0; onProgress({ got: got(), want: count, mined }); continue;
        }
        lastFail = r.reason; lastDetail = r.detail || null;
        if (r.reason === 'missing_tool' || r.reason === 'died' || r.reason === 'disconnected' || r.reason === 'cancelled') return { ok: false, reason: r.reason, detail: { ...(r.detail || {}), got: got(), want: count, mined } };
        skip.add(`${pick.x},${pick.y},${pick.z}`);                                         // this one cannot be done from here: try the next
        // Iron seen in a cave 20 levels down is "exposed" and nearest, yet no walk leads there; every attempt costs a minute and the cap is count * 4 + 20 attempts (acceptance world 4, 2026-11-13: eight minutes
        // circling a hill with 256 ores in sight, the goal layer never got to its own prospecting). Ore around a failed one is in the same place: skip it too, and after three failures in a row give the
        // goal layer the answer so that it looks elsewhere (a staircase down, a tunnel).
        for (const c of all) if (Math.abs(c.x - pick.x) <= 5 && Math.abs(c.y - pick.y) <= 5 && Math.abs(c.z - pick.z) <= 5) skip.add(`${c.x},${c.y},${c.z}`);
        if (++unreached >= 3) return { ok: got() > 0, reason: got() > 0 ? null : 'unreachable', detail: { got: got(), want: count, mined, lastDetail: lastDetail ? JSON.stringify(lastDetail).slice(0, 500) : null, why: `${unreached} picks in a row could not be reached from here (last: ${lastFail})` } };
    }
    return { ok: true, reason: null, detail: { got: got(), want: count, mined, tunnelled, seconds: Math.round((Date.now() - t0) / 1000) } };
}

module.exports = { resolve, find, survey, gather, digPath, withHeadroom, workable, nearReach, REACH, MAX_DIG_IN };
