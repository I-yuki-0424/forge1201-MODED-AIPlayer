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
    const unitCancel = gd ? { get cancelled() { return cancel.cancelled || (defendOn && gd.interrupt.cancelled); } } : cancel;
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
        usableTool: (cls) => bot.inventory.items().find((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i)) || null,
        canCraft: (item) => { const it = bot.registry.itemsByName[item]; return !!it && bot.recipesFor(it.id, null, 1, true).length > 0; },
        itemExists: (n) => !!bot.registry.itemsByName[n],
        pause: (ticks) => sleep(ticks * 50),                       // let the thing in the way (another bot, an item) move on
        exec: (name, args) => execute(bot, name, args, { cancel: unitCancel }),
        have,
        inv: () => janitor.inventoryOf(bot),
        here: feet,
        pos: () => ({ x: bot.entity.position.x, z: bot.entity.position.z }),
    };
    return envObj;
}

module.exports = { botEnv };
