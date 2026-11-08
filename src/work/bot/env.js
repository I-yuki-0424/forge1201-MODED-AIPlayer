'use strict';
// The environment of a real Mineflayer bot for the worker (worker.js) and the jobs: the action layer's `execute`, the recovery ladder
// (jump, sidestep, back to the last good place), defence (guard.js), discard, tools, the inventory. Everything a job may ask of a bot is here;
// the loop that claims units and retries is worker.js.
const janitor = require('./janitor');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment of a real Mineflayer bot on the action layer. */
function botEnv(bot, { cancel = { cancelled: false }, rcon = null, avoid = null, others = null, guard: withGuard = false, defend = true, moved = null, teleport = () => 'near' } = {}) {
    const { execute } = require('../../skills');
    const { fromBot } = require('../../skills/world');
    const { feetCell } = require('../../skills/motion');
    const w = fromBot(bot);
    let good = null;                                             // the feet cell where the bot last finished a unit: a place it can stand and work
    const hold = async (key, ms) => { bot.setControlState(key, true); await sleep(ms); bot.setControlState(key, false); };
    /**
     * One basic fix per call, then the caller waits. The first failure in a place gets the gentlest (level 2 jump, 3 step aside, 4 back to the last good place);
     * the same failure in the same place again gets a different one (escape.js: step back, a pause, a server lift ...), not the same fix over and over.
     */
    const escapes = new Map();
    async function recover(level, failure) {
        if (cancel && cancel.cancelled) return;
        const esc = require('./escape'), f = feetCell(bot.entity.position);
        const { fix, h } = esc.pick(escapes, level, failure, f);
        const stepTo = async (dx, dz, ms) => { await bot.look(Math.atan2(-dx, -dz), 0, true); await hold('forward', ms); };
        const roomAt = (dx, dz) => { const k = (y) => w.kindAt(f.x + dx, f.y + y, f.z + dz); return k(0) === 'air' && k(1) === 'air' && k(-1) === 'solid'; };   // free feet and head cell, solid floor
        const sidestep = async (ms) => {
            for (let i = 0; i < 4; i++) { const [dx, dz] = esc.freshDirection(h); if (roomAt(dx, dz)) { await stepTo(dx, dz, ms); return true; } }
            return false;
        };
        if (fix === 'jump') { await hold('jump', 350); await sleep(250); await hold('jump', 350); return; }
        if (fix === 'sidestep') { if (!await sidestep(350)) await hold('jump', 350); return; }
        if (fix === 'back_off') { if (!await sidestep(800)) await hold('jump', 350); return; }          // two cells away: the next approach comes from another side
        if (fix === 'wait') { await sleep(1500 + Math.floor(Math.random() * 2000)); return; }          // something in the way moves on, the server catches up
        if (fix === 'lift') {
            if (rcon && envObj.lift) { const l = await envObj.lift(f, { radius: 4, up: 2, down: 1, purpose: 'recover', why: `escape after ${(failure && failure.reason) || 'a failed move'}` }); if (l.ok) return; }
            if (!await sidestep(800)) await hold('jump', 350);
            return;
        }
        if (good) {
            const here = feetCell(bot.entity.position);
            const dist = Math.abs(here.x - good.x) + Math.abs(here.z - good.z) + Math.abs(here.y - good.y);
            // Far (three levels or more, or 24 blocks): not on foot. From the surface the planner walked 30 levels down into the pit and a bot fell 86 blocks (live pit 2026-11-07).
            if (dist > 2 && rcon && (Math.abs(here.y - good.y) >= 3 || Math.hypot(here.x - good.x, here.z - good.z) > 24)) await envObj.back(good, { purpose: 'recover', why: `back to the last good place after ${(failure && failure.reason) || 'a failed move'}` });
            else if (dist > 2) await execute(bot, 'move_to', { x: good.x, y: good.y, z: good.z }, { cancel });
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
    /** A cell with air for the body and solid below, and no drop of more than three beside it (no ledge, tree top or pillar edge to walk off: two bots fell to their death after a lift). */
    const safeStand = (x, y, z) => {
        if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') return false;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            if (w.kindAt(x + dx, y, z + dz) === 'water' || w.kindAt(x + dx, y, z + dz) === 'liquid' || w.kindAt(x + dx, y, z + dz) === 'danger') return false;
            if (![1, 2, 3].some((k) => w.kindAt(x + dx, y - k, z + dz) === 'solid')) return false;
        }
        return true;
    };
    // A standing cell the bot can walk out of: a neighbour on the same level, one step up (with room overhead) or one step down. A one-cell pocket by a chest was
    // chosen as 'nearest standable' and held two bots for good (live pit 2026-11-07).
    const walkable = (x, y, z) => w.kindAt(x, y, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid';
    const hasExit = (x, y, z) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => walkable(x + dx, y, z + dz) || (walkable(x + dx, y + 1, z + dz) && w.kindAt(x, y + 2, z) === 'air') || walkable(x + dx, y - 1, z + dz)) ? 1 : 0;
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
        stations: bot.__stations || (bot.__stations = {}),           // crafting table / furnace the bot placed and has not taken back: reused by the next script run (script.js)
        discard: disc.makeClear({ rcon, name: bot.username, count: have }),
        dumpSpot: avoid ? () => disc.dumpSpot(w, feet(), { avoid: avoid(), others: others ? others() : [] }) : null,
        threat: gd ? () => (bot.__preempt ? { reflex: true } : defendOn ? gd.threat() : null) : null,
        // A reflex that has the body (a fall, lava) finishes first; then the fight, if there is one; then the worker runs the stopped unit again.
        defend: gd ? async () => { for (let i = 0; i < 100 && bot.__preempt; i++) await sleep(100); return gd.defend((name, args) => execute(bot, name, args, { cancel })); } : null,
        dispose: () => { if (gd) gd.detach(); }, rememberGood: () => { good = feetCell(bot.entity.position); escapes.clear(); },
        inWater: () => !!bot.entity.isInWater || require('./water').inWater(w, feetCell(bot.entity.position)),
        items: (near, r) => dropsNear(bot, near, r),
        configure: (o) => { if (o && typeof o.defend === 'boolean') defendOn = o.defend; return require('../../skills/options').configure(bot, o); },
        run: (name, args) => require('./moves').runMove(bot, name, args, { cancel }),
        climb: (t) => require('./moves').climbTo(envObj, t),
        dimension: () => String((bot.game && bot.game.dimension) || 'overworld').replace('minecraft:', '').replace('the_', ''),
        // Face a cell and press forward until `until()` is true or `ms` is up (a portal is entered by walking into it); `ahead`: keep the heading the bot has.
        walkInto: async (cell, { until, ms = 8000 } = {}) => {
            const t0 = Date.now();
            try {
                while (!(cancel && cancel.cancelled) && Date.now() - t0 < ms) {
                    if (until && until()) return true;
                    if (!cell.ahead) { const p = bot.entity.position; await bot.look(Math.atan2(-(cell.x + 0.5 - p.x), -(cell.z + 0.5 - p.z)), 0, true); }
                    bot.setControlState('forward', true); await sleep(100);
                }
                return !!(until && until());
            } finally { bot.setControlState('forward', false); }
        },
        cross: (gate, o) => require('./portal').cross(envObj, gate, o),
        // A long walk in legs inside the loaded chunks (travel.js): a move_to beyond the view distance fails for want of chunks.
        travel: (t, o) => require('./travel').travel({ exec: envObj.exec, here: envObj.here, w, cancel: unitCancel }, t, o),
        // Back to a place the bot left (script step go_back): the server moves it (a road-less pit cannot be entered on foot); without RCON it walks.
        back: async (o, opt = {}) => {
            if (!rcon || !Number.isInteger(o.x) || !Number.isInteger(o.y) || !Number.isInteger(o.z)) return execute(bot, 'move_to', o, { cancel });
            // Not to the exact cell it left: its floor may be gone by now (dug away, flooded) and a bot put there falls to its death (it did, twice). The nearest standable
            // cell around it, the cell itself first (distance 0).
            const l = await envObj.lift(o, { radius: 3, down: 3, up: 2, purpose: opt.purpose || 'job', why: opt.why || 'back to the last good place' });
            return l.ok ? { ok: true, to: l.to } : l;
        },
        // A tool counts only if it is not worn out AND, when a script is asked to fix a missing tool for a block (`this.need`, set by the worker and the service), it can
        // harvest that block: a stone pickaxe is no replacement for the one that was missing for gold ore (live 2026-11-07: replace-tool answered ok and the bot waited on).
        canHarvest: function (itemName) { return canHarvest(itemName, this && this.need); },
        usableCount: function (cls) { return bot.inventory.items().filter((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i) && canHarvest(i.name, this && this.need)).length; },
        gather: (a) => require('../jobs/gather').gather(bot, a, { cancel, execute: (b, n, x, o) => execute(b, n, x, o) }),
        usableTool: function (cls) { return bot.inventory.items().find((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i) && canHarvest(i.name, this && this.need)) || null; },
        canCraft: (item) => { const it = bot.registry.itemsByName[item]; return !!it && bot.recipesFor(it.id, null, 1, true).length > 0; },
        itemExists: (n) => !!bot.registry.itemsByName[n],
        // Another bot in (or next to) the cell the bot stands in: a block cannot be placed there (a pillar fails not_confirmed) until one of them steps aside.
        // Move the bot (server `tp`, position only) to the nearest cell where it can stand at the layer of a station that is far above or below it and cannot be
        // walked to: in a ragged open pit a floating pillar block cannot be climbed down and a shaft cannot be walked up. A cell needs air for the body and solid below.
        // `purpose`: 'job' (a station in another layer, a way out of the pit, the water rescue) is always allowed; 'recover' (the escape ladder after a failed move) follows the
        // operator's `teleport` setting: off = never, near = within 16 blocks across and 6 up or down, any = as far as it takes. Every server move is reported to `moved`
        // (owner 2026-11-08: "the bot moves as if teleporting"; it was this, and nothing said so).
        lift: async (S, { radius = 5, down = 0, up = 2, purpose = 'job', why = '' } = {}) => {
            if (!rcon) return { ok: false, reason: 'refused', detail: { why: 'no RCON' } };
            const mode = teleport();
            if (purpose === 'recover' && mode === 'off') return { ok: false, reason: 'refused', detail: { why: 'server moves are off for recovery (setting teleport)' } };
            const oth = others ? others() : [], cand = [];
            for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let y = S.y - down; y <= S.y + up; y++) {
                const x = S.x + dx, z = S.z + dz;
                if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
                if (oth.some((o) => Math.hypot(o.x - (x + 0.5), o.z - (z + 0.5)) < 1.3)) continue;
                cand.push({ x, y, z, safe: safeStand(x, y, z), exit: hasExit(x, y, z), d: Math.hypot(dx, dz) + Math.abs(y - S.y) });
            }
            if (!cand.length) return { ok: false, reason: 'unreachable', detail: { why: 'no standable cell near the station' } };
            cand.sort((a, b) => (b.exit - a.exit) || (b.safe - a.safe) || (a.d - b.d));      // a cell that can be left on foot first (not a sealed pocket), then one without an edge or fluid beside it, then the nearest
            const c = cand[0], p0 = bot.entity.position, dist = Math.round(Math.hypot(c.x + 0.5 - p0.x, c.y - p0.y, c.z + 0.5 - p0.z));
            if (purpose === 'recover' && mode === 'near' && (Math.hypot(c.x + 0.5 - p0.x, c.z + 0.5 - p0.z) > 16 || Math.abs(c.y - p0.y) > 6)) return { ok: false, reason: 'refused', detail: { why: `${dist} blocks is too far for a recovery move (setting teleport: near)`, dist } };
            const from = { x: Math.round(p0.x), y: Math.round(p0.y), z: Math.round(p0.z) };
            try { await rcon(`tp ${bot.username} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); } catch (e) { return { ok: false, reason: 'refused', detail: { message: String(e.message).slice(0, 80) } }; }
            if (moved) { try { moved({ kind: 'server_tp', from, to: { x: c.x, y: c.y, z: c.z }, dist, purpose, why: why || purpose }); } catch (_) { /* reporting must not break the move */ } }
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
