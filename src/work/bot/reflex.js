'use strict';
// Reflexes (owner 2026-11-08, 3.3): what a person does without thinking when a foot slips on an edge or the floor turns to lava. One watcher per bot, on the physics tick,
// independent of what the bot is doing. When it fires, the running command is stopped (`bot.__preempt`, read by skills/runner.js each tick), the reflex does its
// small job, undoes it (the water it placed is picked up again, the held item is put back) and lets go; the worker then runs the unit again, "as if nothing had happened".
//   fall    falling with 5 or more blocks of air under the feet: with a water bucket, look down and put the water on the ground just before landing, then take it up
//           again; without one, put any block into the cell under the feet against the wall the bot just left (it lands on it)
//   lava    feet in lava: drink a fire resistance potion if there is one, else walk out to the nearest dry cell (experimental)
// Nothing here decides anything about the job. The pure parts (`dropBelow`, `landingHeight`, `escapeCell`) are tested without a bot; the actions are checked live
// (scripts/work/reflex_live.js).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FALL_MIN = 5;                    // blocks of free fall that are worth a reflex (3 hurt a little, 23 kill from full health)
const WATER_AT = 3.2;                  // put the water down when the feet are this far above the ground
const BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'deepslate', 'sandstone', 'oak_planks'];

/** Free cells under (x, y, z): how many blocks until something solid (or a fluid) is met; `limit` when nothing within it; null when a chunk is not loaded. */
function dropBelow(kindAt, x, y, z, limit = 40) {
    for (let d = 1; d <= limit; d++) {
        const k = kindAt(x, y - d, z);
        if (k === 'unknown') return null;
        if (k !== 'air' && k !== 'climb') return d - 1;
    }
    return limit;
}

/** Where to go when standing in lava: the nearest cell (within `r`) that is air with a solid floor and no lava beside it, or null. */
function escapeCell(kindAt, f, r = 5) {
    let best = null;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (let dy = -2; dy <= 5; dy++) {      // a pool can be a few blocks deep: the way out is up
        const x = f.x + dx, y = f.y + dy, z = f.z + dz;
        if (kindAt(x, y, z) !== 'air' || kindAt(x, y + 1, z) !== 'air' || kindAt(x, y - 1, z) !== 'solid') continue;
        if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([a, b]) => kindAt(x + a, y, z + b) === 'danger' || kindAt(x + a, y - 1, z + b) === 'danger')) continue;
        const d = Math.hypot(dx, dz) + Math.abs(dy);
        if (!best || d < best.d) best = { x, y, z, d };
    }
    return best;
}

/** Wire a reflex watcher to a bot. `o.world`: the skills world model (kindAt); `o.enabled()`; `o.onEvent(name, detail)`. Returns {state, detach}. */
function attach(bot, { world, enabled = () => true, onEvent = () => {} } = {}) {
    const st = { active: false, fired: 0, last: null, since: 0 };
    bot.__preempt = false;
    const kind = (x, y, z) => world.kindAt(x, y, z);
    const feet = () => { const p = bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }; };
    const item = (re) => bot.inventory.items().find((i) => re.test(i.name));
    const done = (name, extra) => { st.active = false; bot.__preempt = false; st.last = { name, at: Date.now(), ...extra }; onEvent('reflex_end', st.last); };

    async function fall(drop) {
        const bucket = bot.inventory.items().find((i) => i.name === 'water_bucket');
        const held = bot.heldItem, quick = bot.quickBarSlot;
        onEvent('reflex', { kind: 'fall', drop, bucket: !!bucket });
        if (bucket) {
            try { await bot.equip(bucket, 'hand'); } catch (_) { /* the hand is busy: try with what is held */ }
            await bot.look(bot.entity.yaw, -Math.PI / 2, true);
            const t0 = Date.now();
            while (!bot.entity.onGround && Date.now() - t0 < 6000) {
                const y = bot.entity.position.y, d = dropBelow(kind, Math.floor(bot.entity.position.x), Math.floor(y), Math.floor(bot.entity.position.z));
                if (d !== null && d <= WATER_AT && (bot.heldItem && bot.heldItem.name === 'water_bucket')) { bot.activateItem(); await sleep(150); break; }
                await sleep(25);
            }
            await sleep(500);                                                       // landed in the water
            const empty = bot.inventory.items().find((i) => i.name === 'bucket');
            if (empty) {                                                            // the water source is taken up again (one try per second, three tries)
                for (let i = 0; i < 3; i++) {
                    try { await bot.equip(empty, 'hand'); await bot.look(bot.entity.yaw, -Math.PI / 2, true); bot.activateItem(); } catch (_) { /* try again */ }
                    await sleep(700);
                    if (bot.inventory.items().some((x) => x.name === 'water_bucket')) break;
                }
            }
        } else {
            // No bucket: a block into the cell under the feet, against the wall beside it (the one the bot just left). Tried each tick while the drop lasts.
            const tb = require('./tempblocks').choose(bot.inventory.items().map((i) => ({ name: i.name, count: i.count })), bot.registry, { valueOf: require('./janitor').valueOf }),
                mat = (tb && bot.inventory.items().find((i) => i.name === tb)) || BLOCKS.map((n) => item(new RegExp(`^${n}$`))).find(Boolean);
            const t0 = Date.now();
            if (mat) {
                try { await bot.equip(mat, 'hand'); } catch (_) { /* hold what is held */ }
                // The block goes in a few cells BELOW the feet (the bot is faster than the packet: 1 to 2 blocks per tick after the first second), against the wall beside that cell;
                // a placement that does not answer within 250 ms is given up for the next, lower, try.
                let placed = 0;
                while (!bot.entity.onGround && Date.now() - t0 < 3000 && placed < 3) {
                    const f = feet(), vy = Math.abs(bot.entity.velocity ? bot.entity.velocity.y : 1);
                    const c = { x: f.x, y: f.y - Math.min(4, 2 + Math.floor(vy * 3)), z: f.z };
                    if (kind(c.x, c.y, c.z) === 'air') {
                        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            if (kind(c.x + dx, c.y, c.z + dz) !== 'solid') continue;
                            const ref = bot.blockAt(bot.entity.position.floored().offset(dx, c.y - f.y, dz));
                            if (!ref) continue;
                            const ok = await Promise.race([bot.placeBlock(ref, { x: -dx, y: 0, z: -dz }).then(() => true, () => false), sleep(250).then(() => false)]);
                            if (ok) { placed++; if (bot.__temps) bot.__temps.add({ dim: require('../../skills/fixtures').dimOf(bot), x: c.x, y: c.y, z: c.z, item: mat && mat.name, kind: 'reflex', by: bot.username }); onEvent('reflex_placed', c); }
                            break;
                        }
                    }
                    await sleep(20);
                }
            }
        }
        try { if (held && quick !== undefined) bot.setQuickBarSlot(quick); } catch (_) { /* nothing to put back */ }
        done('fall', { drop, bucket: !!bucket });
    }

    async function lava() {
        onEvent('reflex', { kind: 'lava' });
        const potion = bot.inventory.items().find((i) => i.name === 'potion' && /fire_resistance/.test(JSON.stringify(i.nbt || i.components || {})));
        if (potion) {
            try { await bot.equip(potion, 'hand'); bot.activateItem(); await sleep(1800); } catch (_) { /* fall through to walking out */ }
        }
        const t0 = Date.now();
        while (Date.now() - t0 < 6000) {
            const f = feet();
            if (kind(f.x, f.y, f.z) !== 'danger' && kind(f.x, f.y + 1, f.z) !== 'danger') break;
            const c = escapeCell(kind, f);
            if (!c) break;
            await bot.look(Math.atan2(-(c.x + 0.5 - bot.entity.position.x), -(c.z + 0.5 - bot.entity.position.z)), 0, true);
            bot.setControlState('forward', true); bot.setControlState('jump', true); await sleep(100);
        }
        bot.setControlState('forward', false); bot.setControlState('jump', false);
        done('lava', { potion: !!potion });
    }

    // Breath: the head under water for eight seconds (the air lasts fifteen). Swim straight up while the head is in water, for at most 25 s. Five of the six deaths on the acceptance worlds (2026-11-13) were
    // "drowned": a bot at the bottom of a flooded shaft or a pocket opened in an aquifer, no rescue because an operator command has none (the worker's rescue is water.js).
    let wet = 0;
    const headWet = () => { const h = bot.blockAt(bot.entity.position.offset(0, 1.62, 0)); return !!h && h.name === 'water'; };
    async function breath() {
        onEvent('reflex', { kind: 'breath' });
        const t0 = Date.now();
        bot.setControlState('jump', true);
        while (Date.now() - t0 < 25000 && headWet()) await sleep(100);
        bot.setControlState('jump', false);
        done('breath', {});
    }
    const inLava = () => { const f = feet(); return bot.blockAt && (bot.blockAt(bot.entity.position.floored()) || {}).name === 'lava'; };
    const tick = () => {
        if (st.active || !enabled() || !bot.entity || !bot.entity.position) return;
        if (bot.__noReflexUntil && Date.now() < bot.__noReflexUntil) return;                       // a forced fall (service/force.js): the bot is meant to drop
        const e = bot.entity;
        if (!e.isInWater) wet = 0;
        if (!e.onGround && e.velocity && e.velocity.y < -0.55 && !e.isInWater) {
            const f = feet(), d = dropBelow(kind, f.x, f.y, f.z);
            if (d !== null && d >= FALL_MIN) { st.active = true; bot.__preempt = true; st.fired++; st.since = Date.now(); fall(d).catch(() => done('fall', { error: true })); }
        } else if (e.isInWater && headWet() && ++wet >= 160) { wet = 0; st.active = true; bot.__preempt = true; st.fired++; st.since = Date.now(); breath().catch(() => done('breath', { error: true })); }
        else if (inLava()) { st.active = true; bot.__preempt = true; st.fired++; st.since = Date.now(); lava().catch(() => done('lava', { error: true })); }
    };
    bot.on('physicsTick', tick);
    return { state: st, detach: () => { bot.removeListener('physicsTick', tick); bot.__preempt = false; } };
}

module.exports = { attach, dropBelow, escapeCell, FALL_MIN, WATER_AT };
