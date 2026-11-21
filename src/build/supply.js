'use strict';
// What the materials containers hold, read by a bot that opens them: loose stacks and the contents of shulker boxes inside them (their `container` component; the boxes are not
// moved). In creative mode an item that the containers hold is taken as a creative player takes it (the creative inventory, pick-block): the containers stay as they are.
const fly = require('./fly');
const { eyeOf, boxDist, sleep } = require('./act');

const SHULKER = /(^|_)shulker_box$/;

/** { item: count } of a shulker box stack. */
function boxHolds(bot, it) {
    const c = (it.components || []).find((k) => k && k.type === 'container'), out = {};
    for (const s of (c && c.data && c.data.contents) || []) { if (!s || typeof s !== 'object') continue; const r = bot.registry.items[s.itemId]; if (r) out[r.name] = (out[r.name] || 0) + (s.itemCount || 1); }
    return out;
}

/** A feet cell next to container `c` from which it can be opened. */
function nearCell(bot, c) {
    for (const [dx, dy, dz] of [[0, 1, -2], [0, 1, 2], [-2, 1, 0], [2, 1, 0], [0, 2, 0], [-1, 1, -1], [1, 1, 1], [-2, 0, 0], [2, 0, 0], [0, 0, -2], [0, 0, 2], [0, 3, 0]]) {
        const f = { x: c.x + dx, y: c.y + dy, z: c.z + dz };
        if (fly.fits(bot, f.x, f.y, f.z) && boxDist(eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }), c) <= 4) return f;
    }
    return null;
}

/**
 * Read every container of `sites` ([{x, y, z}]). Returns { totals: {item: n}, boxes, read: [{at, stacks}], failed: [{at, why}] }.
 */
async function readSupply(bot, sites, { cancel, log = () => {}, fly: flyOpts = {} } = {}) {
    const totals = {}, read = [], failed = [];
    let boxes = 0;
    for (const s of sites) {
        if (cancel && cancel.cancelled) break;
        const f = nearCell(bot, s) || { x: s.x, y: s.y + 1, z: s.z - 2 };          // none free: the flight tunnels to one
        const fr = await fly.flyTo(bot, f, { cancel, ...flyOpts });
        if (!fr.ok) { failed.push({ at: s, why: `flight ${fr.reason}` }); continue; }
        await sleep(150);
        const block = bot.blockAt(new (require('vec3').Vec3)(s.x, s.y, s.z));
        if (!block) { failed.push({ at: s, why: 'not loaded' }); continue; }
        let win;
        try { win = await Promise.race([bot.openContainer(block), sleep(5000).then(() => { throw new Error('no window'); })]); }
        catch (e) { failed.push({ at: s, why: String(e.message).slice(0, 60) }); continue; }
        let stacks = 0;
        try {
            for (const it of win.containerItems()) {
                stacks++;
                if (SHULKER.test(it.name)) { boxes++; for (const [k, n] of Object.entries(boxHolds(bot, it))) totals[k] = (totals[k] || 0) + n; }
                totals[it.name] = (totals[it.name] || 0) + it.count;
            }
        } finally { try { bot.closeWindow(win); } catch (_) { /* gone */ } }
        read.push({ at: s, stacks });
        log(`supply: ${s.x} ${s.y} ${s.z}: ${stacks} stacks`);
    }
    return { totals, boxes, read, failed };
}

// The block that closes a fluid off (the outer seal, a fluid inside that must go): plain, solid, not burning, not falling; the first the containers hold.
const SEALS = ['smooth_stone', 'stone', 'cobblestone', 'deepslate', 'netherrack', 'obsidian', 'stone_bricks', 'andesite', 'diorite', 'granite', 'white_concrete', 'glass'];
const sealFrom = (totals) => SEALS.find((s) => totals[s] > 0) || null;

module.exports = { readSupply, boxHolds, sealFrom, SEALS };
