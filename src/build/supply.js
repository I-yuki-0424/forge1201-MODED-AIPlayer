'use strict';
// Survival supply: what the materials containers hold (loose stacks and the contents of shulker boxes inside them), and a bot's trip to fill its pack with what it needs.
// A shulker box is unpacked as a player does it: take the box out of the chest, set it down beside the chest, open it, take, break it (it drops itself with what is left),
// pick it up, put it back into the chest. One bot at a chest at a time (the caller locks). Items only ever come out of the containers; nothing is made from nothing.
const { Vec3 } = require('vec3');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHULKER = /(^|_)shulker_box$/;
const TOOL = /(_pickaxe|_axe|_shovel|_hoe|shears)$/;

/** { item: count } of a shulker box stack (its `container` component). */
function boxHolds(bot, it) {
    const c = (it.components || []).find((k) => k && k.type === 'container'), out = {};
    for (const s of (c && c.data && c.data.contents) || []) { if (!s || typeof s !== 'object') continue; const r = bot.registry.items[s.itemId]; if (r) out[r.name] = (out[r.name] || 0) + (s.itemCount || 1); }
    return out;
}
/** What the bot carries: { item: count } (shulker boxes count as boxes, not as what is inside). */
function carried(bot) { const o = {}; for (const it of bot.inventory.items()) o[it.name] = (o[it.name] || 0) + it.count; return o; }
const freeSlots = (bot) => 36 - bot.inventory.items().filter((i) => i.slot >= 9 && i.slot < 45).length;
const boxes = (bot) => bot.inventory.items().filter((i) => SHULKER.test(i.name));

/** Open the container at c (the mover has brought the bot within reach). */
async function open(bot, c) {
    const block = bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (!block) throw new Error('not loaded');
    return Promise.race([bot.openContainer(block), sleep(5000).then(() => { throw new Error('the container did not open'); })]);
}
/** Next to container c (within reach, nothing between): a depot box opened from the far side of the chest did not open (live 2026-11-22). */
async function near(bot, mover, c) {
    const p = bot.entity.position, d = Math.hypot(c.x + 0.5 - p.x, c.y + 0.5 - (p.y + 1.62), c.z + 0.5 - p.z);
    if (d <= 3) return;
    const v = mover.view();
    const adj = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dz]) => ({ x: c.x + dx, y: c.y, z: c.z + dz })).filter((q) => v.fits(q.x, q.y, q.z) && v.stands(q.x, q.y - 1, q.z)).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
    for (const q of adj.slice(0, 3)) { const r = await mover.goto(q, { maxNodes: 5000 }); if (r.ok) return; }
}

/** Shift-click window slot `slot` (into the pack, or from the pack into the container). */
async function shift(bot, slot) { await bot.clickWindow(slot, 0, 1); await sleep(80); }

/** What the containers hold: { totals: {item: n}, read, failed } (opened one by one, nothing moved). `reach(c)` brings the bot within reach of container c. */
async function readSupply(bot, sites, reach, { log = () => {} } = {}) {
    const totals = {}, read = [], failed = [];
    for (const s of sites) {
        const r = await reach(s);
        if (!r.ok) { failed.push({ at: s, why: r.why }); continue; }
        let win; try { win = await open(bot, s); } catch (e) { failed.push({ at: s, why: e.message }); continue; }
        try { for (const it of win.containerItems()) { totals[it.name] = (totals[it.name] || 0) + it.count; if (SHULKER.test(it.name)) for (const [k, n] of Object.entries(boxHolds(bot, it))) totals[k] = (totals[k] || 0) + n; } }
        finally { bot.closeWindow(win); }
        read.push(s); log(`supply: ${s.x} ${s.y} ${s.z} read`);
    }
    return { totals, read, failed };
}

/** Every shulker box the bot carries back into the container at site. */
async function putBack(bot, site) {
    const win = await open(bot, site);
    try { for (const it of boxes(bot)) await shift(bot, win.inventoryStart + (it.slot - 9)); }
    finally { bot.closeWindow(win); }
}

/**
 * Fill the pack from the container at `site` with `needs` ({item: count}, as much as fits). Shulker boxes are set down beside the chest as a DEPOT and stay there while the build
 * runs (`depot`: the cells of boxes already standing, shared by the crew); the bots take from them like from a chest. Nothing is dropped, so nothing can be lost (a box broken
 * beside the chest fell into the Nether's lava with what was left in it, live 2026-11-22). The boxes go back into the chest at the end (`repack`).
 * `mover`: the bot's Mover; `spot()`: a free cell for the next depot box. Returns { got: {item: n}, short: {item: n} }.
 */
async function fetch(bot, site, needs, mover, spot, { log = () => {}, depot = [] } = {}) {
    const got = {}, want = { ...needs }, present = {};
    const still = () => Object.entries(want).filter(([, n]) => n > 0);
    const took = (name, n) => { got[name] = (got[name] || 0) + n; if (want[name] !== undefined) want[name] = Math.max(0, want[name] - n); };
    const saw = (name, n) => { if (needs[name] !== undefined) present[name] = (present[name] || 0) + n; };
    const takeFrom = async (c) => {
        await near(bot, mover, c);
        const w = await open(bot, c);
        try { for (const it of w.containerItems()) { saw(it.name, it.count); if (freeSlots(bot) <= 1 || !still().length) continue; if (want[it.name] > 0 && !SHULKER.test(it.name)) { await shift(bot, it.slot); took(it.name, it.count); } } }
        finally { bot.closeWindow(w); await sleep(250); }
    };
    // 1. the depot boxes already standing
    for (const c of depot) { if (!still().length || freeSlots(bot) <= 1) break; const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!b || !SHULKER.test(b.name)) continue; try { await takeFrom(c); } catch (e) { log(`supply: depot box at ${c.x},${c.y},${c.z}: ${e.message}`); } }
    if (!still().length) return { got, short: {}, absent: [] };
    // 2. loose stacks in the chest, and which boxes hold the rest
    let win = await open(bot, site);
    const useful = [];
    try {
        for (const it of win.containerItems()) {
            if (SHULKER.test(it.name)) for (const [k, n] of Object.entries(boxHolds(bot, it))) saw(k, n); else saw(it.name, it.count);
            if (freeSlots(bot) <= 1) continue;
            if (SHULKER.test(it.name)) { const h = boxHolds(bot, it), score = still().reduce((a, [k, n]) => a + Math.min(n, h[k] || 0), 0); if (score > 0) useful.push({ slot: it.slot, h, score }); }
            else if (want[it.name] > 0) { await shift(bot, it.slot); took(it.name, it.count); }
        }
    } finally { bot.closeWindow(win); await sleep(250); }
    // 3. a box out of the chest into the depot, then taken from
    useful.sort((a, b) => b.score - a.score);
    for (const bx of useful) {
        if (!still().length || freeSlots(bot) <= 2) break;
        const n0 = boxes(bot).length;
        win = await open(bot, site);
        try { await shift(bot, bx.slot); } finally { bot.closeWindow(win); await sleep(250); }
        const box = boxes(bot)[0];
        if (!box || boxes(bot).length <= n0) { log(`supply: the box in slot ${bx.slot} did not come out`); continue; }
        const at = spot(), pr = at ? await mover.placeItem(box.name, at, { facing: 'up' }) : 'no free cell for the depot';          // facing up: a box opens toward its facing (one set down sideways against rock never opened, live 2026-11-22)
        if (pr !== true) { log(`supply: could not set a box down${at ? ` at ${at.x},${at.y},${at.z}` : ''}: ${pr}`); await putBack(bot, site); break; }
        depot.push(at);
        try { await takeFrom(at); } catch (e) { log(`supply: the box at ${at.x},${at.y},${at.z} did not open: ${e.message}`); }
    }
    // absent: what none of the containers holds any more (only these are "out of stock"; a full pack is not the chest being empty)
    return { got, short: Object.fromEntries(still()), absent: Object.keys(needs).filter((k) => !present[k] && !got[k]) };
}

/** The end of a build: every depot box broken (the bot next to it: the drop lands in its reach) and put back into the chest. Returns the boxes not brought back. */
async function repack(bot, site, depot, mover, { log = () => {} } = {}) {
    let lost = 0;
    for (const c of [...depot]) {
        const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
        if (!b || !SHULKER.test(b.name)) { depot.splice(depot.indexOf(c), 1); continue; }
        const v = mover.view(), p = bot.entity.position;
        const adj = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({ x: c.x + dx, y: c.y, z: c.z + dz })).filter((q) => v.fits(q.x, q.y, q.z) && v.stands(q.x, q.y - 1, q.z)).sort((a, q) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(q.x - p.x, q.z - p.z))[0];
        if (adj) await mover.goto(adj, { maxNodes: 5000 });
        const n0 = boxes(bot).length;
        await mover.dig(c);
        for (let i = 0; i < 30 && boxes(bot).length <= n0; i++) await sleep(100);
        if (boxes(bot).length <= n0) { lost++; log(`supply: the depot box from ${c.x},${c.y},${c.z} was not picked up`); }
        depot.splice(depot.indexOf(c), 1);
        if (boxes(bot).length >= 6 || !depot.length) await putBack(bot, site);
    }
    if (boxes(bot).length) await putBack(bot, site);
    return lost;
}

/** Throw away what the job has no use for (rubble of clearing) when the pack is getting full; keeps `keep(name)`, tools and boxes. Thrown items despawn after five minutes. */
async function dropRubble(bot, keep, { minFree = 6 } = {}) {
    if (freeSlots(bot) >= minFree) return 0;
    let n = 0;
    for (const it of bot.inventory.items()) { if (keep(it.name, it.count) || TOOL.test(it.name) || SHULKER.test(it.name)) continue; try { await bot.tossStack(it); n++; } catch (_) { /* busy */ } if (freeSlots(bot) >= minFree + 4) break; }
    return n;
}

// The temporary block: plain, solid, not falling, not in the blueprint; the first the containers hold.
const TEMPS = ['dirt', 'cobblestone', 'pumpkin', 'netherrack', 'cobbled_deepslate', 'stone', 'andesite', 'diorite', 'granite', 'oak_planks', 'spruce_planks', 'birch_planks'];
const tempFrom = (totals, used) => TEMPS.find((s) => totals[s] > 0 && !used.has(s)) || null;

module.exports = { readSupply, fetch, repack, putBack, dropRubble, boxHolds, carried, freeSlots, tempFrom, TEMPS, SHULKER, TOOL };
