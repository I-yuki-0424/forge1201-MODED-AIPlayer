'use strict';
// "Have N of X": the goal layer above the instructions (docs/proposed/ACCEPTANCE-v1.md, tests 3 and 4). The router calls it when an instruction answers `item_in_pack` (a `place` of an item the bot
// does not carry), and the operator calls it directly (`obtain`). Rule-based, like the router: the rules are the teacher a learned planner is later judged against.
//   natural      the blocks that give it are found in the loaded chunks and mined (gather: logs, cobblestone, raw iron, coal ...)
//   smelted      its input is obtained, a furnace is made and placed if none is near, fuel is obtained, the batch is smelted (stone <- cobblestone, iron_ingot <- raw_iron ...)
//   crafted      the registry's recipe: every ingredient is obtained first, a crafting table is made and placed when the recipe needs one and none is near
// Each step is an instruction through the router (`deps.command`), so reach, tool in hand and being sealed in are the router's business, not this file's.
const ALIAS = Object.freeze({ wood: 'log', logs: 'log', smelted_stone: 'stone', iron: 'iron_ingot', redstone_dust: 'redstone', cobble: 'cobblestone' });
const SMELT = Object.freeze({ stone: 'cobblestone', iron_ingot: 'raw_iron', gold_ingot: 'raw_gold', copper_ingot: 'raw_copper', glass: 'sand', charcoal: 'log', smooth_stone: 'stone', brick: 'clay_ball' });
const FUEL_VALUE = Object.freeze({ coal: 1600, charcoal: 1600, coal_block: 16000, oak_planks: 300, spruce_planks: 300, birch_planks: 300, jungle_planks: 300, acacia_planks: 300, dark_oak_planks: 300, mangrove_planks: 300, cherry_planks: 300 });
const LOG = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry)_log$/, PLANKS = /_planks$/;
const MAX_DEPTH = 6, BATCH = 64;
const { surface, prospect, back, ORE_LEVEL } = require('./explore');

const count = (bot, pred) => bot.inventory.items().reduce((n, i) => n + (pred(i.name) ? i.count : 0), 0);
/** `log` and `planks` are pseudo items: any kind of wood / any kind of planks (a recipe takes whichever the bot has). */
const have = (bot, item) => (item === 'log' ? count(bot, (n) => LOG.test(n)) : item === 'planks' ? count(bot, (n) => PLANKS.test(n)) : count(bot, (n) => n === item));
const fail = (reason, detail) => ({ ok: false, reason, detail });

/** Free cells next to the bot where a block can be put: air, air above (nothing in the way), solid below; nearest first. */
function freeCells(deps, near = 2) {
    const w = deps.w, me = deps.here(), out = [];
    for (let dx = -near; dx <= near; dx++) for (let dz = -near; dz <= near; dz++) {
        if (!dx && !dz) continue;
        const c = { x: me.x + dx, y: me.y, z: me.z + dz };
        if (w.kindAt(c.x, c.y, c.z) === 'air' && w.kindAt(c.x, c.y + 1, c.z) === 'air' && w.kindAt(c.x, c.y - 1, c.z) === 'solid') out.push({ ...c, d: Math.abs(dx) + Math.abs(dz) });
    }
    return out.sort((a, b) => a.d - b.d);
}

/** A station block (crafting table, furnace) within 5 blocks of the bot: its cell, or null. Not 16: a furnace found 12 blocks away across a cliff was "found" and then "unreachable" (acceptance world 4, 2026-11-13); a new one costs eight cobblestone. */
function stationNear(deps, name) {
    const p = deps.bot.findBlock ? deps.bot.findBlock({ matching: (b) => b && b.name === name, maxDistance: 5 }) : null;
    return p ? { x: p.position.x, y: p.position.y, z: p.position.z } : null;
}

/** Make sure a station of this kind stands near the bot: reuse one, or craft the item and place it. */
async function station(deps, name, depth) {
    const s = stationNear(deps, name);
    if (s) return { ok: true, cell: s };
    const made = await obtain(deps, name, 1, depth + 1);
    if (!made.ok) return made;
    const cells = freeCells(deps);
    if (!cells.length) return fail('invalid_target', { why: `no free cell next to the bot to put the ${name} in` });
    for (const c of cells.slice(0, 4)) {
        const r = await deps.command('place', { x: c.x, y: c.y, z: c.z, item: name });
        if (r.ok) return { ok: true, cell: c, placed: true };
    }
    return fail('invalid_target', { why: `the ${name} could not be placed next to the bot` });
}

/** Fuel for `smelts` items. The smelt instruction fuels the whole batch from ONE kind of item (coal, or one kind of planks), so a mix that adds up is no fuel: acceptance world 3, 2026-11-13, "no fuel for the batch" after
 *  the goal layer had counted coal and planks together. Coal first (1,600 ticks = 8 items), else planks (300 ticks = 1.5 items). */
async function fuelFor(deps, smelts, depth) {
    const bot = deps.bot;
    const single = () => bot.inventory.items().some((i) => (FUEL_VALUE[i.name] || 0) > 0 && count(bot, (n) => n === i.name) * FUEL_VALUE[i.name] / 200 >= smelts);
    if (single()) return { ok: true };
    const coal = await obtain(deps, 'coal', Math.ceil(smelts * 200 / FUEL_VALUE.coal), depth + 1);
    if (coal.ok && single()) return { ok: true };
    const p = await obtain(deps, 'planks', Math.ceil(smelts * 200 / FUEL_VALUE.oak_planks), depth + 1);
    return p.ok && single() ? { ok: true } : fail('missing_materials', { why: 'no one kind of fuel covers the batch', smelts, coal: have(bot, 'coal'), planks: have(bot, 'planks') });
}

/**
 * Have at least `n` of `item` in the pack. Resolves to {ok, detail: {steps}} or {ok: false, reason, detail}. deps: { bot, w, here(), command(name, args), gather(args), exec(name, args), cancelled() }.
 */
async function obtain(deps, item, n, depth = 0) {
    item = ALIAS[item] || item;
    const bot = deps.bot, steps = [];
    const log = (s) => { steps.push(s); if (deps.say) deps.say(`${item} x${n}${depth ? ` (step ${depth})` : ''}: ${s}`); };
    if (depth > MAX_DEPTH) return fail('invalid_args', { why: `${item}: the recipe chain is too deep (a loop?)` });
    if (!bot.registry.itemsByName[item] && item !== 'log' && item !== 'planks') return fail('invalid_args', { why: `${item} is not an item of this world` });
    const missing = () => n - have(bot, item);
    if (missing() <= 0) return { ok: true, detail: { steps: [`${item}: already ${have(bot, item)}`] } };
    if (deps.cancelled && deps.cancelled()) return fail('cancelled', {});

    // any planks: from whatever log the bot has (one log = four planks)
    if (item === 'planks') {
        const logs = await obtain(deps, 'log', Math.ceil(missing() / 4), depth + 1); log(`log: ${logs.ok ? 'ok' : logs.reason}`);
        if (!logs.ok) return fail(logs.reason, { ...(logs.detail || {}), steps });
        const wood = firstLog(bot).replace(/_log$/, '');
        const r = await deps.exec('craft', { item: `${wood}_planks`, count: missing() }); log(`craft ${wood}_planks: ${r.ok ? 'ok' : r.reason}`);
        return missing() <= 0 ? { ok: true, detail: { steps } } : fail(r.reason || 'missing_materials', { ...(r.detail || {}), steps });
    }
    // natural: blocks that give the item (logs, cobblestone, raw iron, coal, sand ...)
    if (item === 'log' || (!SMELT[item] && !craftable(bot, item)) || ['cobblestone', 'raw_iron', 'coal', 'sand', 'clay_ball'].includes(item)) {
        const mineAll = async () => {
            const targets = item === 'log' ? bestLogTargets(deps) : [item];
            for (const t of targets) {
                const g = await deps.gather({ target: t, count: missing(), radius: 64 });
                log(`gather ${t}: ${g.ok ? 'ok' : g.reason}${g.detail && g.detail.got !== undefined ? ` (${g.detail.got}/${g.detail.want})` : ''}${!g.ok && g.detail && g.detail.why ? ` - ${String(g.detail.why).slice(0, 160)}` : ''}${!g.ok && g.detail && (g.detail.lastFail || g.detail.lastDetail) ? ` [last: ${g.detail.lastFail || ''}${g.detail.lastDetail ? ' ' + g.detail.lastDetail : ''}]` : ''}`);
                if (missing() <= 0) return null;
                if (g.reason === 'cancelled' || g.reason === 'died' || g.reason === 'disconnected') return g.reason;
            }
            return null;
        };
        let stop = await mineAll();
        // Not within reach: look further. Ores: down a staircase to the depth where they are common and along a tunnel; the rest: out on rings over the surface.
        for (let round = 0; round < 12 && missing() > 0 && !stop && deps.travel && deps.survey; round++) {
            // Ores count only when gather could work them (a block the bot can walk up to, or dig to from a cell it can walk to): iron in a cave 20 levels down is "found" and unreachable.
            const nearest = deps.nearestOre ? async () => (ORE_LEVEL[item] !== undefined ? deps.nearestOre(item, 24) : null) : null;
            const nearby = async () => { const ts = item === 'log' ? bestLogTargets(deps) : [item]; if (deps.workable) { for (const t of ts) if ((await deps.workable(t, 24)) > 0) return true; return false; } return ts.some((t) => ((deps.survey(t, 24) || {}).total || 0) > 0); };
            if (ORE_LEVEL[item] !== undefined) {
                let p = await prospect({ ...deps, nearest }, nearby, ORE_LEVEL[item]); log(`prospect ${item}: ${p.found ? 'found' : p.why || 'nothing'} (${p.stairs} stairs, ${p.tunnel} tunnel${p.fails.length ? `, ${p.fails.length} refusals: ${[...new Set(p.fails.map((f) => f.replace(/^\w+( -?\d)?: /, '')))].slice(0, 4).join(' | ').slice(0, 260)}` : ''})`);
                const entry = p.entry, trail = p.trail.slice();
                stop = await mineAll();
                // Stay down while the count is short: the next vein is a few tunnel steps from the last one, and the way up and down again costs minutes per iron (acceptance world 3/4, 2026-11-13: one to three
                // ore per round trip, six rounds allowed). prospect() from where the bot stands skips the staircase (it is at the ore level) and tunnels toward the ore it can see.
                for (let k = 0; k < 60 && missing() > 0 && !stop && p.found; k++) {
                    const m0 = missing();
                    p = await prospect({ ...deps, nearest }, nearby, ORE_LEVEL[item]); trail.push(...p.trail);
                    log(`prospect on ${item}: ${p.found ? 'found' : p.why || 'nothing'} (${p.tunnel} tunnel)`);
                    if (!p.found) break;
                    stop = await mineAll();
                    if (missing() >= m0 && p.stairs + p.tunnel === 0) break;                  // nothing moved, nothing mined: the next round would be the same
                }
                if (!stop) { const b = await back(deps, entry, trail); log(`back to the surface: ${b.ok ? 'ok' : b.reason}`); if (!b.ok && missing() > 0) break; }
                if (!p.found && ['died', 'disconnected', 'cancelled'].includes(p.why)) break;
                if (!p.found && missing() > 0) { const h = deps.here(); await deps.travel({ x: h.x + (round % 2 ? 30 : -30), z: h.z + (round % 4 < 2 ? 30 : -30) }, { near: 4 }); log(`another site for the shaft (round ${round + 1})`); }          // a failed shaft is not the end of the search: dig the next one elsewhere
            } else {
                const s = await surface(deps, nearby); log(`explore for ${item}: ${s.found ? 'found' : s.why} (${s.stops.length} stops)`);
                if (!s.found) break;
                stop = await mineAll();
            }
        }
        if (stop) return fail(stop, { steps });
        return missing() <= 0 ? { ok: true, detail: { steps } } : fail('unreachable', { why: `${missing()} of ${item} still missing after gathering and looking further`, steps });
    }
    // smelted
    if (SMELT[item]) {
        const input = SMELT[item];
        while (missing() > 0) {
            const k = Math.min(BATCH, missing());
            // Enough input for THIS batch, counting what the pack holds: "what it holds plus the batch" mined 64 more raw iron with 64 in the pack and put 700 cobblestone into one smelt (acceptance
            // worlds 3-5, 2026-11-13). The furnace, when none stands near, is made of 8 cobblestone first: for cobblestone that is 8 more.
            const a = await obtain(deps, input, k + (input === 'cobblestone' && item !== 'furnace' && !stationNear(deps, 'furnace') ? 8 : 0), depth + 1); log(`${input}: ${a.ok ? 'ok' : a.reason}`);
            if (!a.ok) return fail(a.reason, { ...a.detail, steps });
            const f = await fuelFor(deps, k, depth); log(`fuel: ${f.ok ? 'ok' : f.reason}`);
            if (!f.ok) return fail(f.reason, { ...f.detail, steps });
            const s = await station(deps, 'furnace', depth); log(`furnace: ${s.ok ? (s.placed ? 'placed' : 'found') : s.reason}`);
            if (!s.ok) return fail(s.reason, { ...s.detail, steps });
            const before = have(bot, item);
            const r = await deps.exec('smelt', { item: input === 'log' ? firstLog(bot) : input, count: k, x: s.cell.x, y: s.cell.y, z: s.cell.z }); log(`smelt ${k} ${input}: ${r.ok ? 'ok' : r.reason}`);
            if (!r.ok) return fail(r.reason, { ...(r.detail || {}), steps });
            if (have(bot, item) <= before) return fail('not_confirmed', { why: `nothing of ${item} came out`, steps });
        }
        return { ok: true, detail: { steps } };
    }
    // crafted: the registry's recipe
    const it = bot.registry.itemsByName[item], recipes = bot.recipesAll(it.id, null, true);
    if (!recipes.length) return fail('invalid_args', { why: `no recipe and no natural source for ${item}` });
    const recipe = recipes.find((r) => r.requiresTable === false) || recipes[0], per = recipe.result.count, times = Math.ceil(missing() / per);
    const need = new Map();
    for (const d of recipe.delta || []) if (d.count < 0) need.set(d.id, (need.get(d.id) || 0) - d.count * times);
    for (const [id, c] of need) {
        const raw = bot.registry.items[id].name, name = PLANKS.test(raw) ? 'planks' : raw, a = await obtain(deps, name, c, depth + 1);        // any planks stand in for the recipe's own kind
        log(`${name} x${c}: ${a.ok ? 'ok' : a.reason}`);
        if (!a.ok && have(bot, name) < c) return fail(a.reason, { ...(a.detail || {}), steps });
    }
    let at = {};
    if (recipe.requiresTable !== false) { const s = await station(deps, 'crafting_table', depth); log(`crafting_table: ${s.ok ? (s.placed ? 'placed' : 'found') : s.reason}`); if (!s.ok) return fail(s.reason, { ...s.detail, steps }); at = { x: s.cell.x, y: s.cell.y, z: s.cell.z }; }
    const r = await deps.exec('craft', { item, count: missing(), ...at }); log(`craft ${item}: ${r.ok ? 'ok' : r.reason}`);
    return r.ok || missing() <= 0 ? { ok: true, detail: { steps } } : fail(r.reason, { ...(r.detail || {}), steps });
}

const craftable = (bot, item) => { const it = bot.registry.itemsByName[item]; return !!it && bot.recipesAll(it.id, null, true).length > 0; };
const firstLog = (bot) => { const i = bot.inventory.items().find((x) => LOG.test(x.name)); return i ? i.name : 'oak_log'; };
/** The log kinds worth mining, the one with most blocks near the bot first. */
function bestLogTargets(deps) {
    const reg = deps.bot.registry, names = Object.keys(reg.blocksByName).filter((b) => LOG.test(b));
    if (!deps.survey) return ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log'];
    return names.map((t) => ({ t, n: (deps.survey(t, 64) || {}).total || 0 })).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).map((x) => x.t);
}

module.exports = { obtain, ALIAS, SMELT, have, freeCells };
