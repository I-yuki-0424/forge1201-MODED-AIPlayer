'use strict';
// The environment of a real Mineflayer bot for the worker (worker.js) and the jobs: the action layer's `execute`, the recovery ladder
// (jump, sidestep, back to the last good place), defence (guard.js), discard, tools, the inventory. Everything a job may ask of a bot is here;
// the loop that claims units and retries is worker.js.
const janitor = require('./janitor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment of a real Mineflayer bot on the action layer. */
function botEnv(bot, { cancel = { cancelled: false }, rcon = null, avoid = null, others = null, guard: withGuard = false, defend = true } = {}) {
    const { execute } = require('../../skills');
    const { fromBot } = require('../../skills/world');
    const { feetCell } = require('../../skills/motion');
    const w = fromBot(bot);
    let good = null;                                             // the feet cell where the bot last finished a unit: a place it can stand and work
    const hold = async (key, ms) => { bot.setControlState(key, true); await sleep(ms); bot.setControlState(key, false); };
    /** One basic fix per level, then the caller waits: 2 jump, 3 step to a safe neighbouring cell, 4+ walk back to the last good place. */
    async function recover(level) {
        if (cancel && cancel.cancelled) return;
        if (level === 2) { await hold('jump', 350); await sleep(250); await hold('jump', 350); return; }
        if (level === 3) {
            const f = feetCell(bot.entity.position), dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5);
            for (const [dx, dz] of dirs) {                       // free feet and head cell ahead, solid floor, no fluid or danger: safe to step into
                const k = (y) => w.kindAt(f.x + dx, f.y + y, f.z + dz);
                if (k(0) === 'air' && k(1) === 'air' && k(-1) === 'solid') {
                    await bot.look(Math.atan2(-dx, -dz), 0, true); await hold('forward', 350); return;
                }
            }
            await hold('jump', 350); return;
        }
        if (good) {
            const here = feetCell(bot.entity.position);
            if (Math.abs(here.x - good.x) + Math.abs(here.z - good.z) + Math.abs(here.y - good.y) > 2) await execute(bot, 'move_to', { x: good.x, y: good.y, z: good.z }, { cancel });
        }
    }
    const { items: dropsNear } = require('./drops');
    // Defence (guard.js): while `defend` is on, a command that runs when the bot is attacked is stopped (reason `cancelled`) and the worker fights first.
    let defendOn = !!defend;
    const gd = withGuard ? require('./guard').attach(bot, { cancel }) : null;
    // A unit is interrupted when the operator cancels, when the bot is attacked (guard), or when it is under water with its air running out (below 9 of 20): the
    // worker then runs the water rescue before the next unit (the live pit drowned two bots mid-dig: the water check only ran between units).
    const drowning = () => { const o = bot.oxygenLevel; return typeof o === 'number' && o < 9 && (!!bot.entity.isInWater || require('./water').inWater(w, feetCell(bot.entity.position))); };
    const unitCancel = { get cancelled() { return cancel.cancelled || (gd && defendOn && gd.interrupt.cancelled) || drowning(); } };
    /** Can this item harvest that block (registry harvestTools)? True when nothing is asked or the block needs no tool. */
    const canHarvest = (itemName, block) => {
        if (!block) return true;
        const reg = bot.registry, b = reg && reg.blocksByName[String(block).replace(/^minecraft:/, '')], it = reg && reg.itemsByName[itemName];
        return !b || !b.harvestTools || (!!it && !!b.harvestTools[it.id]);
    };
    const have = (item) => bot.inventory.items().reduce((n, i) => n + (i.name === item ? i.count : 0), 0);
    const disc = require('./discard');
    const feet = () => feetCell(bot.entity.position);
    const envObj = {
        w, now: Date.now, recover, temp: new Map(),
        discard: disc.makeClear({ rcon, name: bot.username, count: have }),
        dumpSpot: avoid ? () => disc.dumpSpot(w, feet(), { avoid: avoid(), others: others ? others() : [] }) : null,
        threat: gd ? () => (defendOn ? gd.threat() : null) : null,
        defend: gd ? () => gd.defend((name, args) => execute(bot, name, args, { cancel })) : null,
        dispose: () => { if (gd) gd.detach(); }, rememberGood: () => { good = feetCell(bot.entity.position); },
        inWater: () => !!bot.entity.isInWater || require('./water').inWater(w, feetCell(bot.entity.position)),
        items: (near, r) => dropsNear(bot, near, r),
        configure: (o) => { if (o && typeof o.defend === 'boolean') defendOn = o.defend; return require('../../skills/options').configure(bot, o); },
        run: (name, args) => require('./moves').runMove(bot, name, args, { cancel }),
        climb: (t) => require('./moves').climbTo(envObj, t),
        // Back to a place the bot left (script step go_back): the server moves it (a road-less pit cannot be entered on foot); without RCON it walks.
        back: async (o) => {
            if (!rcon || !Number.isInteger(o.x) || !Number.isInteger(o.y) || !Number.isInteger(o.z)) return execute(bot, 'move_to', o, { cancel });
            try { await rcon(`tp ${bot.username} ${o.x + 0.5} ${o.y} ${o.z + 0.5}`); } catch (e) { return { ok: false, reason: 'refused', detail: { message: String(e.message).slice(0, 80) } }; }
            for (let i = 0; i < 30; i++) { await sleep(100); const p = bot.entity.position; if (Math.abs(p.x - o.x - 0.5) < 2 && Math.abs(p.y - o.y) < 2 && Math.abs(p.z - o.z - 0.5) < 2) return { ok: true }; }
            return { ok: false, reason: 'not_confirmed' };
        },
        // A tool counts only if it is not worn out AND, when a script is asked to fix a missing tool for a block (`this.need`, set by the worker and the service), it can
        // harvest that block: a stone pickaxe is no replacement for the one that was missing for gold ore (live 2026-11-07: replace-tool answered ok and the bot waited on).
        usableCount: function (cls) { return bot.inventory.items().filter((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i) && canHarvest(i.name, this && this.need)).length; },
        gather: (a) => require('../jobs/gather').gather(bot, a, { cancel, execute: (b, n, x, o) => execute(b, n, x, o) }),
        usableTool: function (cls) { return bot.inventory.items().find((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i) && canHarvest(i.name, this && this.need)) || null; },
        canCraft: (item) => { const it = bot.registry.itemsByName[item]; return !!it && bot.recipesFor(it.id, null, 1, true).length > 0; },
        itemExists: (n) => !!bot.registry.itemsByName[n],
        // Another bot in (or next to) the cell the bot stands in: a block cannot be placed there (a pillar fails not_confirmed) until one of them steps aside.
        // Move the bot (server `tp`, position only) to the nearest cell where it can stand at the layer of a station that is far above or below it and cannot be
        // walked to: in a ragged open pit a floating pillar block cannot be climbed down and a shaft cannot be walked up. A cell needs air for the body and solid below.
        lift: async (S, { radius = 5, down = 0, up = 2 } = {}) => {
            if (!rcon) return { ok: false, reason: 'refused', detail: { why: 'no RCON' } };
            const oth = others ? others() : [], cand = [];
            for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let y = S.y - down; y <= S.y + up; y++) {
                const x = S.x + dx, z = S.z + dz;
                if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
                if (oth.some((o) => Math.hypot(o.x - (x + 0.5), o.z - (z + 0.5)) < 1.3)) continue;
                cand.push({ x, y, z, d: Math.hypot(dx, dz) + Math.abs(y - S.y) + (dx === 0 && dz === 0 ? 0 : 0) });
            }
            if (!cand.length) return { ok: false, reason: 'unreachable', detail: { why: 'no standable cell near the station' } };
            cand.sort((a, b) => a.d - b.d);
            const c = cand[0];
            try { await rcon(`tp ${bot.username} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); } catch (e) { return { ok: false, reason: 'refused', detail: { message: String(e.message).slice(0, 80) } }; }
            for (let i = 0; i < 30; i++) { await sleep(100); const p = bot.entity.position; if (Math.abs(p.x - c.x - 0.5) < 1.5 && Math.abs(p.y - c.y) < 1.5 && Math.abs(p.z - c.z - 0.5) < 1.5 && bot.entity.onGround) return { ok: true, to: { x: c.x, y: c.y, z: c.z } }; }
            return { ok: false, reason: 'not_confirmed' };
        },
        // Walk to the nearest standable cell that no other bot stands in or next to (two bots in one cell blocked each other's pillar for ten minutes).
        stepAside: async () => {
            const f = feetCell(bot.entity.position), oth = others ? others() : [];
            const free = (x, z) => !oth.some((o) => Math.hypot(o.x - (x + 0.5), o.z - (z + 0.5)) < 1.3);
            let tried = 0;
            for (let rad = 1; rad <= 3 && tried < 6; rad++) {
                for (let dx = -rad; dx <= rad && tried < 6; dx++) for (let dz = -rad; dz <= rad && tried < 6; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
                    for (const dy of [0, 1, -1]) {
                        const x = f.x + dx, y = f.y + dy, z = f.z + dz;
                        if (!free(x, z) || w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
                        tried++; const m = await execute(bot, 'move_to', { x, y, z }, { cancel });
                        if (m.ok) return { ok: true, to: { x, y, z } };
                        break;
                    }
                }
            }
            return { ok: false, reason: 'unreachable' };
        },
        crowded: () => !!others && others().some((o) => Math.hypot(o.x - bot.entity.position.x, o.z - bot.entity.position.z) < 0.9),
        pause: (ticks) => sleep(ticks * 50),                       // let the thing in the way (another bot, an item) move on
        unitCancel,
        exec: (name, args) => execute(bot, name, args, { cancel: unitCancel }),
        have,
        inv: () => janitor.inventoryOf(bot),
        here: feet,
        pos: () => ({ x: bot.entity.position.x, z: bot.entity.position.z }),
    };
    return envObj;
}

module.exports = { botEnv };
