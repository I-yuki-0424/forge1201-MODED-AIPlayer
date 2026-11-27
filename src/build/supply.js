'use strict';
// Survival supply: what the materials containers hold (loose stacks and the contents of shulker boxes inside them), and a bot's trip to fill its pack with what it needs.
// A shulker box is unpacked as a player does it: take the box out of the chest, set it down beside the chest, open it, take, break it (it drops itself with what is left),
// pick it up, put it back into the chest. One bot at a chest at a time (the caller locks). Items only ever come out of the containers; nothing is made from nothing.
const { Vec3 } = require('vec3');

const sleep = (ms, label = 'server: container') => require('./pauses').sleep(ms, label);
const SHULKER = /(^|_)shulker_box$/;
const SUP_TOOLISH = /(_pickaxe|_axe|_shovel|_hoe|shears|shulker_box)$/;
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
// the supply's boxes the bot carries (with something inside); an empty box is a building material like any other block (the Nether blueprint has shulker boxes in it)
const boxes = (bot) => bot.inventory.items().filter((i) => SHULKER.test(i.name) && Object.keys(boxHolds(bot, i)).length > 0);
const emptyBox = (bot, it) => SHULKER.test(it.name) && Object.keys(boxHolds(bot, it)).length === 0;

/** Open the container at c (the mover has brought the bot within reach). */
async function open(bot, c) {
    const block = bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (!block) throw new Error('not loaded');
    const w = await require('./pauses').within('server: container opens', () => Promise.race([bot.openContainer(block), sleep(5000).then(() => { throw new Error('the container did not open'); })]));
    // the window's items can come a moment after it opens: an empty window is read again before it counts as empty (eight bots took a full chest for empty and stood idle,
    // owner 2026-11-23 problem 8)
    for (let i = 0; i < 6 && !w.containerItems().length; i++) await sleep(150);
    return w;
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
/** Take n of stack `it` from window w: the whole stack by shift-click, part of it by clicks (a bot that took whole stacks took every repeater and torch; the rest of the crew
 * found none and stood idle, live 2026-11-22 sE2). Returns the count taken. */
async function take(bot, w, it, n) {
    // whole stacks by shift-click only: a partial withdraw on the 26.1 server moved several stacks (832 smooth stone for 282, live 2026-11-23 ha2 w4); a stack is taken while
    // at least a quarter of it is wanted (scarce items: `needs` is already the bot's share)
    if (n * 4 < it.count && it.count > 4) {
        // a small part of a stack (4 glowstone of 48, 1 torch of 23): a partial withdraw, checked against the pack (a quarter rule without it left a Nether anchor uncharged
        // for good, 107 trips, live 2026-11-23 ha5 w1)
        const c0 = carried(bot)[it.name] || 0;
        try { await require('./pauses').within('server: container', () => w.withdraw(it.type, null, n)); } catch (_) { return 0; }
        await sleep(250);
        const got = (carried(bot)[it.name] || 0) - c0;
        return got > 0 ? got : n;
    }
    await shift(bot, it.slot); return it.count;
}

/** What the containers hold: { totals: {item: n}, read, failed } (opened one by one, nothing moved). `reach(c)` brings the bot within reach of container c. */
async function readSupply(bot, sites, reach, { log = () => {} } = {}) {
    const totals = {}, read = [], failed = [];
    for (const s of sites) {
        const r = await reach(s);
        if (!r.ok) { failed.push({ at: s, why: r.why }); continue; }
        let win; try { win = await open(bot, s); } catch (e) { failed.push({ at: s, why: e.message }); continue; }
        try { for (const it of win.containerItems()) { if (SHULKER.test(it.name) && !emptyBox(bot, it)) { for (const [k, n] of Object.entries(boxHolds(bot, it))) totals[k] = (totals[k] || 0) + n; } else totals[it.name] = (totals[it.name] || 0) + it.count; } }
        finally { bot.closeWindow(win); }
        read.push(s); log(`supply: ${s.x} ${s.y} ${s.z} read`);
    }
    return { totals, read, failed };
}

/** Items by name back into the container at site (what the bot carries of them, all of it). Returns { item: count } put back. */
async function deposit(bot, site, names) {
    const win = await open(bot, site), out = {};
    try { for (const it of bot.inventory.items()) { if (!names.includes(it.name)) continue; await shift(bot, win.inventoryStart + (it.slot - 9)); out[it.name] = (out[it.name] || 0) + it.count; } }
    finally { bot.closeWindow(win); await sleep(250); }
    return out;
}

/** Every shulker box the bot carries back into the container at site. */
async function putBack(bot, site) {
    const win = await open(bot, site);
    try { for (const it of boxes(bot)) await shift(bot, win.inventoryStart + (it.slot - 9)); }
    finally { bot.closeWindow(win); }
}

/** How many of `name` one slot holds. */
function stackOf(bot, name) { const r = bot.registry && bot.registry.itemsByName[name]; return r ? r.stackSize || 64 : 64; }
const counts = (w) => { const o = {}; for (const it of w.containerItems()) o[it.name] = (o[it.name] || 0) + it.count; return o; };

/**
 * Fill the pack from the container at `site` with `needs` ({item: count}, as much as fits). Shulker boxes are set down beside the chest as a DEPOT and stay there while they hold
 * something (`depot`: shared by the crew, each with what it was last seen holding, `holds`); the bots take from them like from a chest. A box that holds nothing the bot wants is
 * not opened, and a box emptied is broken by the bot that emptied it, picked up and put back into the chest (empty boxes stood round the chest in heaps, were opened by every
 * bot on every trip and held the turn at the supply, owner 2026-11-23 list 4 problems 2 and 3). Several bots fetch at once: one bot per box (`locks`), the chest open to all.
 * What it got is counted from the pack (another bot may have taken a stack a moment before). `mover`: the bot's Mover; `spot()`: a free cell for the next depot box.
 * Returns { got: {item: n}, short: {item: n}, absent: [item] }.
 */
async function fetch(bot, site, needs, mover, spot, { log = () => {}, depot = [], locks = new Map(), me = bot.username, cancel = { cancelled: false } } = {}) {
    const before = carried(bot), want = { ...needs }, present = {};
    const end = Date.now() + 120000;          // a trip has two minutes at the supply; the turn goes to the next bot
    const over = () => cancel.cancelled || Date.now() > end;
    let complete = true;                  // every container that may hold the items was looked into (only then is an item missing from all of them "absent")
    let retired = 0;                      // empty depot boxes picked up on this trip (they go back into the chest)
    let reshelve = false;                 // a full box taken up (it did not open): back into the chest at the end of the trip
    const still = () => Object.entries(want).filter(([, n]) => n > 0);
    // what is still wanted is counted from the pack, not from what the clicks meant to move (stale windows moved several stacks per click: 832 smooth stone for 282, ha2 w4)
    // counted by what was clicked (the pack's own count lags the clicks: counted from it, one bot took 14 pickaxes and another 1 088 dirt, live 2026-11-23 ha3 w2); `reconcile` at
    // the end hands back whole stacks over the need
    const took = (name, n) => { if (want[name] !== undefined) want[name] = Math.max(0, want[name] - n); };
    const saw = (name, n) => { if (needs[name] !== undefined) present[name] = (present[name] || 0) + n; };
    const lock = (c) => { const k = `${c.x},${c.y},${c.z}`, h = locks.get(k); if (h && h.by !== me && h.until > Date.now()) return false; locks.set(k, { by: me, until: Date.now() + 30000 }); return true; };
    const unlock = (c) => { const k = `${c.x},${c.y},${c.z}`; if ((locks.get(k) || {}).by === me) locks.delete(k); };
    const waitLock = async (c, ms) => { const t = Date.now() + ms; while (!lock(c)) { if (Date.now() > t || over()) return false; await sleep(250, 'wait: chest held by another bot'); } return true; };
    // more than it asked for (a window two bots had open at once moved whole stacks: one bot took 1 152 smooth stone for 364 and the crew ran short, live 2026-11-23 ha1 w2):
    // whole stacks of the surplus go back into the window at once
    const giveBack = async (w, name) => {
        if (needs[name] === undefined) return;
        let over = carried(bot)[name] - (before[name] || 0) - needs[name];
        for (const it of bot.inventory.items()) { if (over < it.count || it.name !== name) continue; await shift(bot, w.inventoryStart + (it.slot - 9)); over -= it.count; }
    };
    const takeFrom = async (c) => {
        await near(bot, mover, c);
        const w = await open(bot, c);
        try {
            const names = new Set();
            for (const it of w.containerItems()) { saw(it.name, it.count); if (freeSlots(bot) <= 1 || !still().length) continue; if (want[it.name] > 0 && (!SHULKER.test(it.name) || emptyBox(bot, it))) { took(it.name, await take(bot, w, it, want[it.name])); names.add(it.name); } }
            await sleep(300); for (const n of names) await giveBack(w, n);
            await sleep(120); c.holds = counts(w);
        } finally { bot.closeWindow(w); await sleep(250); }
    };
    // an emptied box: broken (the bot is beside it, the drop lands in its reach), picked up, out of the depot
    const retire = async (c) => {
        const n0 = bot.inventory.items().filter((i) => SHULKER.test(i.name)).length;
        if (!(await mover.dig(c))) return;
        for (let i = 0; i < 30 && bot.inventory.items().filter((x) => SHULKER.test(x.name)).length <= n0; i++) await sleep(100);
        const k = depot.indexOf(c); if (k >= 0) depot.splice(k, 1);
        if (bot.inventory.items().filter((x) => SHULKER.test(x.name)).length > n0) retired++; else log(`supply: the emptied box from ${c.x},${c.y},${c.z} was not picked up`);
    };
    const useBox = async (c) => {
        try { await takeFrom(c); } catch (e) {
            // a box opens only into a free lid cell: a block someone put there (a pillar, rubble) is dug away and the box tried once more (the crew's whole stock of dirt sat in a
            // box that never opened, live 2026-11-23 fy3 w5)
            const L = { x: c.x + (c.fx || 0), y: c.y + (c.fy ?? 1), z: c.z + (c.fz || 0) }, lid = bot.blockAt(new Vec3(L.x, L.y, L.z));
            let again = false;
            if (lid && lid.boundingBox === 'block' && !SHULKER.test(lid.name) && !/chest|barrel/.test(lid.name)) { log(`supply: depot box at ${c.x},${c.y},${c.z} is shut by ${lid.name} at ${L.x},${L.y},${L.z}: dug away`); again = await mover.dig(L); }
            if (again) { try { await takeFrom(c); } catch (_) { again = false; } }
            if (!again) {
                complete = false; log(`supply: depot box at ${c.x},${c.y},${c.z}: ${e.message}`);
                // a box that does not open (something on its lid we may not dig, a bot on it): broken with what it holds (a shulker box keeps it), picked up and put back into
                // the chest, from where the next trip sets it down somewhere free (the crew's last dirt sat in a box that never opened: trips came back empty, live 2026-11-24 ha18 w4)
                const n0 = boxes(bot).length;
                if (await mover.dig(c)) { for (let i = 0; i < 30 && boxes(bot).length <= n0; i++) await sleep(100); const k = depot.indexOf(c); if (k >= 0) depot.splice(k, 1); if (boxes(bot).length > n0) { reshelve = true; log(`supply: the box from ${c.x},${c.y},${c.z} was taken up to be set down again`); } }
                return;
            }
        }
        if (c.holds && !Object.keys(c.holds).length) await retire(c);
    };
    // 1. the depot boxes already standing: only those that hold something it wants (or were never looked into), one bot per box
    const toolFirst = (c) => (c.holds && still().some(([k]) => TOOL.test(k) && c.holds[k] > 0) ? 0 : 1);
    for (const c of [...depot].sort((a, b) => toolFirst(a) - toolFirst(b))) {
        if (!still().length || freeSlots(bot) <= 1 || over()) { complete = false; break; }
        const b = bot.blockAt(new Vec3(c.x, c.y, c.z)); if (!b || !SHULKER.test(b.name)) { depot.splice(depot.indexOf(c), 1); continue; }
        if (c.holds) { for (const [k, n] of Object.entries(c.holds)) saw(k, n); if (!still().some(([k]) => c.holds[k] > 0)) { if (!Object.keys(c.holds).length && lock(c)) { try { await near(bot, mover, c); await retire(c); } finally { unlock(c); } } continue; } }
        if (!(await waitLock(c, 5000))) { complete = false; continue; }
        try { await useBox(c); } finally { unlock(c); }
    }
    // 2. loose stacks in the chest, and which boxes hold the rest
    const useful = [];
    // the chest: one bot in it at a time (its window's slots go stale when another takes from it), a short turn
    let chestLocked = false;
    if (still().length && freeSlots(bot) > 1 && !over() && (chestLocked = await waitLock(site, 20000))) try {
        await near(bot, mover, site);
        const win = await open(bot, site);
        if (!win.containerItems().length) complete = false;
        // what the chest holds, its boxes' contents included (the build's material ledger, drive.js materials)
        { const all = {}; for (const it of win.containerItems()) { if (SHULKER.test(it.name) && !emptyBox(bot, it)) { for (const [k, n] of Object.entries(boxHolds(bot, it))) all[k] = (all[k] || 0) + n; } else all[it.name] = (all[it.name] || 0) + it.count; } site.holdsAll = all; site.holdsAt = Date.now(); }
        try {
            for (const it of win.containerItems()) {
                if (SHULKER.test(it.name) && !emptyBox(bot, it)) for (const [k, n] of Object.entries(boxHolds(bot, it))) saw(k, n); else saw(it.name, it.count);
                if (freeSlots(bot) <= 1) continue;
                if (emptyBox(bot, it) && want[it.name] > 0) { took(it.name, await take(bot, win, it, want[it.name])); continue; }
                if (SHULKER.test(it.name)) { const h = boxHolds(bot, it), score = still().reduce((a, [k, n]) => a + Math.min(n, h[k] || 0) * (TOOL.test(k) ? 1000 : 1), 0); if (score > 0) useful.push({ slot: it.slot, h, score }); }          // tools first (bots dug stone by hand for minutes)
                else if (want[it.name] > 0) took(it.name, await take(bot, win, it, want[it.name]));
            }
            await sleep(300); for (const n of Object.keys(needs)) if (!SUP_TOOLISH.test(n)) await giveBack(win, n);
        } finally { bot.closeWindow(win); await sleep(250); }
    } finally { unlock(site); } else if (still().length) complete = false;
    // 3. a box out of the chest into the depot, then taken from
    useful.sort((a, b) => b.score - a.score);
    for (const bx of useful) {
        if (!still().length || freeSlots(bot) <= 2 || over()) break;
        if (!still().some(([k]) => bx.h[k] > 0)) continue;          // what it held was taken from other boxes meanwhile
        const n0 = boxes(bot).length;
        await near(bot, mover, site);                 // back beside the chest (the last box may have been set down a few cells away)
        if (!(await waitLock(site, 20000))) break;
        try { const win = await open(bot, site); try { const cur = win.slots[bx.slot]; if (cur && SHULKER.test(cur.name) && !emptyBox(bot, cur)) await shift(bot, bx.slot); } finally { bot.closeWindow(win); await sleep(250); } } finally { unlock(site); }
        const box = boxes(bot).find((i) => i.slot !== undefined);
        if (!box || boxes(bot).length <= n0) { log(`supply: the box in slot ${bx.slot} did not come out (another bot took it)`); continue; }
        const at = await spot(), pr = at ? await mover.placeItem(box.name, at, { facing: at.facing || 'up' }) : 'no free cell for the depot';          // facing up: a box opens toward its facing (one set down sideways against rock never opened, live 2026-11-22)
        if (pr !== true) { log(`supply: could not set a box down${at ? ` at ${at.x},${at.y},${at.z}` : ''}: ${pr}`); await near(bot, mover, site); await putBack(bot, site); break; }
        const c = { ...at, holds: { ...bx.h } };
        depot.push(c);
        if (lock(c)) { try { await useBox(c); } finally { unlock(c); } }
    }
    // emptied boxes back into the chest (they are the supply's, and the Nether blueprint builds with shulker boxes)
    if (reshelve && (await waitLock(site, 20000))) { try { await near(bot, mover, site); await putBack(bot, site); } catch (e) { log(`supply: the box not put back: ${e.message}`); } finally { unlock(site); } }
    if (retired && (await waitLock(site, 20000))) { try { await near(bot, mover, site); await depositEmpty(bot, site, retired); } catch (e) { log(`supply: empty boxes not put back: ${e.message}`); } finally { unlock(site); } }
    // whole stacks over the need go back into the chest (whatever the windows did)
    await sleep(400);
    { const c0 = carried(bot), over = Object.keys(needs).filter((k) => !SUP_TOOLISH.test(k) && (c0[k] || 0) - (before[k] || 0) - needs[k] >= stackOf(bot, k));
      if (over.length && (await waitLock(site, 20000))) { try { await near(bot, mover, site); const w = await open(bot, site); try { for (const k of over) await giveBack(w, k); } finally { bot.closeWindow(w); await sleep(250); } log(`supply: surplus of ${over.join(', ')} handed back`); } catch (e) { log(`supply: surplus not handed back: ${e.message}`); } finally { unlock(site); } } }
    const after = carried(bot), got = {};
    for (const [k, n] of Object.entries(after)) if (n > (before[k] || 0) && needs[k] !== undefined) got[k] = n - (before[k] || 0);          // (not what it picked up on the way)
    const short = {}; for (const [k, n] of Object.entries(needs)) if (n - (got[k] || 0) > 0) short[k] = n - (got[k] || 0);
    // absent: what none of the containers holds any more (only these are "out of stock"; a full pack is not the chest being empty)
    return { got, short, absent: complete ? Object.keys(needs).filter((k) => !present[k] && !got[k]) : [] };
}

/** Up to n empty shulker boxes from the pack into the container at site. */
async function depositEmpty(bot, site, n) {
    const win = await open(bot, site);
    try { for (const it of bot.inventory.items()) { if (n <= 0) break; if (!emptyBox(bot, it)) continue; await shift(bot, win.inventoryStart + (it.slot - 9)); n -= it.count; } }
    finally { bot.closeWindow(win); await sleep(250); }
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
const tempFrom = (totals, used) => { const o = require('../work/bot/tempblocks').only(); return (o.length ? o : TEMPS).find((s) => totals[s] > 0 && !used.has(s)) || null; };

module.exports = { readSupply, fetch, repack, putBack, deposit, depositEmpty, dropRubble, boxHolds, carried, freeSlots, stackOf, tempFrom, TEMPS, SHULKER, TOOL };
