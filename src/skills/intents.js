'use strict';
// Intents: the LLM's action vocabulary on top of the command layer (TASK-20261031-017).
// The LLM names things the way a player does ("collect oak_log 5", "come Steve", "kill zombie"); an intent resolves those
// names against what the bot can see (nearest block of that kind, the player's entity, the nearest chest) and runs the
// 14 commands of src/skills. Every intent ends with one line in the wording AgentManager classifies:
//   "Successfully ..."            done (no further LLM call)
//   "Partially collected 3/5 x"   progress (the LLM plans the remainder)
//   "Failed <intent>: <reason>"   failure (the LLM corrects, 3 in a row stop the bot)
// Names that are not in this table are refused with the list of supported intents: nothing falls back to old code.
const Vec3 = require('vec3');
const { execute } = require('./index');
const { standable } = require('./world');
const { count, resolveItemName } = require('./commands/item');

const FIND_RANGE = 32;
const CONTAINERS = /^(chest|trapped_chest|barrel)$/;
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'turtle', 'leather'];

class Cancelled extends Error {}

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
const qty = (a, d = 1) => num(a.quantity ?? a.count, d);
const reasonText = (r) => `${r.reason}${r.detail && r.detail.why ? ` (${r.detail.why})` : ''}`;
const hd = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/** Block names an LLM target means: the exact name, else every block named "*_<target>" ("log" -> oak_log, birch_log, ...). */
function blockNames(registry, target) {
    let t = String(target || '').toLowerCase().replace(/^minecraft:/, '');
    if (!registry.blocksByName[t] && t.endsWith('s')) t = t.slice(0, -1);       // "logs" -> "log" (but "glass" stays)
    if (registry.blocksByName[t]) return [t];
    const alias = { wood: 'log', logs: 'log', ore: 'ore' }[t] || t;
    return Object.keys(registry.blocksByName).filter((n) => n.endsWith(`_${alias}`));
}

/** Standing cells within `r` of `around` (same height +-1), nearest to `from` first, excluding `around`'s own column. */
function cellsNear(world, around, r, from) {
    const c0 = { x: Math.floor(around.x), y: Math.floor(around.y + 1e-6), z: Math.floor(around.z) };
    const out = [];
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) for (const dy of [0, 1, -1]) {
        if (!dx && !dz) continue;
        const c = { x: c0.x + dx, y: c0.y + dy, z: c0.z + dz };
        if (standable(world, c.x, c.y, c.z)) out.push(c);
    }
    return out.sort((a, b) => hd(a, from) - hd(b, from));
}

/** Highest standing cell of the column x,z at or below `top`, or null (also when the chunk is not loaded). */
function surface(world, x, z, top) {
    for (let y = Math.min(top, 318); y > -64; y--) {
        if (world.kindAt(x, y, z) === 'unknown') return null;
        if (standable(world, x, y, z)) return y;
    }
    return null;
}

/** The context an intent runs with: `run(command, args)` executes one command and stops the intent on cancel. */
function makeRunner(bot, opts) {
    const world = require('./world').fromBot(bot);
    const results = [];
    const run = async (name, args) => {
        const r = await execute(bot, name, args, { cancel: opts.cancel, onEvent: opts.onEvent });
        results.push({ command: name, args, ok: r.ok, reason: r.reason, detail: r.detail, ticks: r.ticks });
        if (opts.onCommand) opts.onCommand(name, args, r);
        if (r.reason === 'cancelled') throw new Cancelled();
        return r;
    };
    return { bot, world, run, results, deadline: (s) => Date.now() + s * 1000 };
}

/** Walk next to an entity (a player): a standing cell within 2 blocks of it. */
async function approachEntity(I, ent, label) {
    for (let round = 0; round < 3; round++) {
        if (hd(I.bot.entity.position, ent.position) <= 2.5 && Math.abs(I.bot.entity.position.y - ent.position.y) < 1.5) return { ok: true };
        let last = null;
        for (const c of cellsNear(I.world, ent.position, 2, I.bot.entity.position).slice(0, 4)) {
            last = await I.run('move_to', c);
            if (last.ok) break;
        }
        if (last && !last.ok) return last;
        if (!last) return { ok: false, reason: 'unreachable', detail: { why: `no place to stand next to ${label}` } };
    }
    return { ok: hd(I.bot.entity.position, ent.position) <= 3.5, reason: 'stuck', detail: { why: `${label} keeps moving` } };
}

const player = (bot, name) => bot.players[name] && bot.players[name].entity;

const INTENTS = {
    chat: {
        doc: '[{"action":"chat","message":"text"}]',
        async run(I, a) { I.bot.chat(String(a.message || '').slice(0, 240)); return { quiet: true }; },
    },
    status: {
        doc: '[{"action":"status"}]                                        -- say position, health, food and inventory',
        async run(I) {
            const b = I.bot, p = b.entity.position;
            const inv = b.inventory.items().slice(0, 8).map((i) => `${i.count}x${i.name}`).join(', ') || 'empty';
            b.chat(`At ${Math.round(p.x)} ${Math.round(p.y)} ${Math.round(p.z)}, health ${Math.round(b.health)}, food ${b.food}. Inventory: ${inv}`.slice(0, 240));
            return { quiet: true };
        },
    },
    come: {
        doc: '[{"action":"come","target":"PlayerName"}]                   -- walk next to that player (once; repeat to follow)',
        async run(I, a) {
            const ent = player(I.bot, a.target);
            if (!ent) return { fail: `player ${a.target} not in view` };
            const r = await approachEntity(I, ent, a.target);
            return r.ok ? { msg: `Successfully arrived at destination next to ${a.target}.` } : { fail: reasonText(r) };
        },
    },
    goto: {
        doc: '[{"action":"goto","x":10,"z":20}] or {"action":"goto","x":10,"y":64,"z":20}  -- walk there (any distance, in legs of up to 32 blocks)',
        async run(I, a) {
            const tx = Math.floor(Number(a.x)), tz = Math.floor(Number(a.z)), ty = a.y === undefined ? null : Math.floor(Number(a.y));
            if (!Number.isFinite(tx) || !Number.isFinite(tz)) return { fail: 'invalid_args (x and z are required)' };
            const until = I.deadline(num(a.timeout, 300));
            for (let leg = 0; leg < 64 && Date.now() < until; leg++) {
                const p = I.bot.entity.position, d = Math.hypot(tx + 0.5 - p.x, tz + 0.5 - p.z);
                if (d <= 1.5 && (ty === null || Math.abs(Math.floor(p.y) - ty) <= 1)) return { msg: `Successfully arrived at destination ${tx} ${ty ?? Math.floor(p.y)} ${tz}.` };
                const step = Math.min(d, 32), base = Math.atan2(tz + 0.5 - p.z, tx + 0.5 - p.x);
                let moved = false, last = null;
                for (const off of [0, 0.45, -0.45, 0.9, -0.9]) {
                    const px = Math.floor(p.x + step * Math.cos(base + off)), pz = Math.floor(p.z + step * Math.sin(base + off));
                    const top = (step === d && ty !== null ? ty : Math.floor(p.y)) + 8;
                    const cand = [{ x: px, z: pz }, ...[[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].map(([dx, dz]) => ({ x: px + dx, z: pz + dz }))]
                        .map((c) => ({ ...c, y: step === d && ty !== null && standable(I.world, c.x, ty, c.z) ? ty : surface(I.world, c.x, c.z, top) }))
                        .filter((c) => c.y !== null);
                    if (!cand.length) continue;
                    last = await I.run('move_to', cand[0]);
                    if (last.ok) { moved = true; break; }
                }
                if (!moved) return { fail: last ? reasonText(last) : 'unreachable (no standing place toward the target in loaded chunks)' };
            }
            return { fail: 'timed out' };
        },
    },
    collect: {
        doc: '[{"action":"collect","target":"oak_log","quantity":8}]       -- mine the nearest blocks of that kind and pick up the drops ("log" = any log)',
        async run(I, a) {
            const names = blockNames(I.bot.registry, a.target), want = qty(a);
            if (!names.length) return { fail: `unknown block ${a.target}` };
            const ids = names.map((n) => I.bot.registry.blocksByName[n].id);
            const skip = new Set(), until = I.deadline(num(a.timeout, 120));
            let got = 0, misses = 0, last = null;
            while (got < want && Date.now() < until && misses < 8) {
                const pos = I.bot.findBlocks({ matching: ids, maxDistance: FIND_RANGE, count: 64 }).find((v) => !skip.has(v.toString()));
                if (!pos) break;
                last = await I.run('mine', { x: pos.x, y: pos.y, z: pos.z });
                if (last.ok) got += Math.max(1, last.detail.got || 0);
                else { skip.add(pos.toString()); misses++; }
            }
            if (got >= want) return { msg: `Successfully collected ${got} ${a.target}.` };
            if (got > 0) return { msg: `Partially collected ${got}/${want} ${a.target}.` };
            return { fail: last ? reasonText(last) : `${a.target} not found within ${FIND_RANGE} blocks` };
        },
    },
    kill: {
        doc: '[{"action":"kill","target":"zombie","quantity":1}]           -- fight the nearest mobs of that kind with the best weapon at hand',
        async run(I, a) {
            const want = qty(a), name = String(a.target || '').toLowerCase().replace(/^minecraft:/, '');
            const skip = new Set(), until = I.deadline(num(a.timeout, 120));
            let killed = 0, last = null;
            while (killed < want && Date.now() < until) {
                const me = I.bot.entity.position;
                const ent = Object.values(I.bot.entities).filter((e) => e !== I.bot.entity && e.type !== 'player' && e.name === name && !skip.has(e.id)
                    && e.position.distanceTo(me) <= FIND_RANGE).sort((x, y) => x.position.distanceTo(me) - y.position.distanceTo(me))[0];
                if (!ent) break;
                last = await I.run('attack', { entity: ent.id });
                if (last.ok) killed++; else skip.add(ent.id);
            }
            if (killed >= want) return { msg: `Successfully eliminated ${killed} ${name}.` };
            if (killed > 0) return { msg: `Partially killed ${killed}/${want} ${name}.` };
            return { fail: last ? reasonText(last) : `${name} not found within ${FIND_RANGE} blocks` };
        },
    },
    give: {
        doc: '[{"action":"give","target":"PlayerName","item":"oak_log","quantity":8}]  -- walk to the player, face them, drop the items',
        async run(I, a) {
            const item = resolveItemName(I.bot, a.item), want = qty(a), have = count(I.bot, item);
            if (!have) return { fail: `${item} not in inventory` };
            const ent = player(I.bot, a.target);
            if (!ent) return { fail: `player ${a.target} not in view` };
            const r = await approachEntity(I, ent, a.target);
            if (!r.ok) return { fail: reasonText(r) };
            await I.run('look_at', { entity: ent.id });
            const n = Math.min(want, have), t = await I.run('toss', { item, count: n });
            return t.ok ? { msg: `Successfully gave ${n}${n < want ? ` of ${want}` : ''} ${item} to ${a.target}.` } : { fail: reasonText(t) };
        },
    },
    equip: {
        doc: '[{"action":"equip","target":"diamond_pickaxe"}] or {"action":"equip","target":"shield","dest":"off_hand"}  (dest: hand off_hand head chest legs feet)',
        async run(I, a) {
            const item = resolveItemName(I.bot, a.target || a.item);
            const dest = a.dest || (/_helmet$/.test(item) ? 'head' : /_chestplate$|^elytra$/.test(item) ? 'chest' : /_leggings$/.test(item) ? 'legs' : /_boots$/.test(item) ? 'feet' : 'hand');
            const r = await I.run('equip', { item, dest });
            return r.ok ? { msg: `Successfully equipped ${item}.` } : { fail: reasonText(r) };
        },
    },
    equip_armor: {
        doc: '[{"action":"equip_armor"}]                                   -- wear the best armour in the inventory',
        async run(I) {
            const worn = [];
            for (const [dest, re] of [['head', /_helmet$/], ['chest', /_chestplate$/], ['legs', /_leggings$/], ['feet', /_boots$/]]) {
                const best = I.bot.inventory.items().filter((i) => re.test(i.name))
                    .sort((x, y) => ARMOR_TIERS.findIndex((t) => x.name.startsWith(t)) - ARMOR_TIERS.findIndex((t) => y.name.startsWith(t)))[0];
                if (best && (await I.run('equip', { item: best.name, dest })).ok) worn.push(best.name);
            }
            return worn.length ? { msg: `Successfully equipped ${worn.join(', ')}.` } : { fail: 'no armour in inventory (not in inventory)' };
        },
    },
    eat: {
        doc: '[{"action":"eat"}] or [{"action":"eat","target":"cooked_beef"}]',
        async run(I, a) {
            const r = await I.run('eat', a.target ? { item: resolveItemName(I.bot, a.target) } : {});
            return r.ok ? { msg: `Successfully ate ${r.detail.item}.` } : { fail: r.reason === 'missing_item' ? 'no food available' : reasonText(r) };
        },
    },
    craft: {
        doc: '[{"action":"craft","target":"wooden_pickaxe","quantity":1}]  -- 2x2 grid, or the nearest crafting table within 16 blocks',
        async run(I, a) {
            const item = resolveItemName(I.bot, a.target || a.item);
            const r = await I.run('craft', { item, count: qty(a) });
            return r.ok ? { msg: `Successfully crafted ${r.detail.made} ${item}.` } : { fail: reasonText(r) };
        },
    },
    smelt: {
        doc: '[{"action":"smelt","target":"raw_iron","quantity":4}]        -- nearest furnace (a furnace in the inventory is placed first), fuel from the inventory',
        async run(I, a) {
            const item = resolveItemName(I.bot, a.target || a.item), n = qty(a);
            let r = await I.run('smelt', { item, count: n });
            if (r.reason === 'no_station' && count(I.bot, 'furnace') > 0) {
                const placed = await placeNearby(I, 'furnace');
                if (!placed.ok) return { fail: `no furnace and could not place one: ${reasonText(placed)}` };
                r = await I.run('smelt', { item, count: n });
            }
            return r.ok ? { msg: `Successfully smelted ${r.detail.made} ${item} into ${r.detail.output}.` } : { fail: r.reason === 'no_station' ? 'no furnace within 16 blocks' : reasonText(r) };
        },
    },
    place: {
        doc: '[{"action":"place","target":"crafting_table"}] or with "x","y","z"  -- place the block there, or on free ground next to the bot',
        async run(I, a) {
            const item = resolveItemName(I.bot, a.target || a.item);
            const r = a.x !== undefined ? await I.run('place', { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z), item }) : await placeNearby(I, item);
            return r.ok ? { msg: `Successfully placed ${item}.` } : { fail: reasonText(r) };
        },
    },
    withdraw: {
        doc: '[{"action":"withdraw","item":"stone","quantity":16}] (+ "x","y","z" of the chest/barrel, else the nearest one within 16 blocks)',
        aliases: ['withdraw_from_container'],
        async run(I, a) {
            const at = containerAt(I, a);
            if (!at) return { fail: 'could not find a chest or barrel within 16 blocks' };
            const item = resolveItemName(I.bot, a.item), r = await I.run('withdraw', { item, count: qty(a), ...at });
            return r.ok ? { msg: `Successfully withdrew ${qty(a)} ${item}.` } : { fail: r.reason === 'missing_item' ? `container did not contain ${qty(a)} ${item}` : reasonText(r) };
        },
    },
    deposit: {
        doc: '[{"action":"deposit","item":"stone","quantity":16}] (+ "x","y","z", else the nearest chest/barrel within 16 blocks)',
        aliases: ['deposit_to_container', 'store_in_container'],
        async run(I, a) {
            const at = containerAt(I, a);
            if (!at) return { fail: 'could not find a chest or barrel within 16 blocks' };
            const item = resolveItemName(I.bot, a.item), n = Math.min(qty(a), count(I.bot, item) || qty(a));
            const r = await I.run('deposit', { item, count: n, ...at });
            return r.ok ? { msg: `Successfully deposited ${n} ${item}.` } : { fail: reasonText(r) };
        },
    },
    activate: {
        doc: '[{"action":"activate","x":10,"y":65,"z":20}] (+ "item":"create:wrench", "sneak":true for mod tools)  -- right-click the block',
        aliases: ['activate_block'],
        async run(I, a) {
            const args = { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) };
            if (a.item) args.item = String(a.item).toLowerCase();
            if (a.sneak !== undefined) args.sneak = !!a.sneak;
            const r = await I.run('activate', args);
            return r.ok ? { msg: `Successfully activated ${r.detail.block}${r.detail.now !== r.detail.block ? ` (now ${r.detail.now})` : ''}.` } : { fail: reasonText(r) };
        },
    },
    pickup: {
        doc: '[{"action":"pickup","target":"diamond"}]                     -- walk over the nearest dropped stack of that item',
        async run(I, a) {
            const r = await I.run('pickup', { item: resolveItemName(I.bot, a.target || a.item) });
            return r.ok ? { msg: `Successfully collected ${r.detail.got} ${r.detail.item} from the ground.` } : { fail: r.reason === 'invalid_target' ? `no dropped ${a.target} in view` : reasonText(r) };
        },
    },
    wait: {
        doc: '[{"action":"wait"}]                                          -- stand still until the next instruction',
        async run() { return { quiet: true }; },
    },
};

const BY_NAME = {};
for (const [name, it] of Object.entries(INTENTS)) { BY_NAME[name] = it; for (const al of it.aliases || []) BY_NAME[al] = it; }

/** Place `item` on free ground next to the bot (the cells around it at distance 2, then 3). */
async function placeNearby(I, item) {
    const me = I.bot.entity.position;
    let last = { ok: false, reason: 'invalid_target', detail: { why: 'no free cell next to the bot' } };
    for (const c of cellsNear(I.world, me, 3, me).filter((c) => hd({ x: c.x + 0.5, z: c.z + 0.5 }, me) >= 1.5).slice(0, 6)) {
        last = await I.run('place', { ...c, item });
        if (last.ok) return last;
    }
    return last;
}

function containerAt(I, a) {
    if (a.x !== undefined && a.y !== undefined && a.z !== undefined) return { x: Math.floor(a.x), y: Math.floor(a.y), z: Math.floor(a.z) };
    const b = I.bot.findBlock({ matching: (blk) => CONTAINERS.test(blk.name), maxDistance: 16 });
    return b ? { x: b.position.x, y: b.position.y, z: b.position.z } : null;
}

/**
 * Run one intent object ({action, ...}). Resolves to {ok, message, quiet, results}: `message` is the System line for
 * AgentManager (null when quiet), `results` the commands that ran with their outcomes (for logs and the WebUI).
 */
async function runIntent(bot, a, opts = {}) {
    const it = a && BY_NAME[a.action];
    if (!it) {
        return { ok: false, message: `Failed ${a && a.action}: not available in the new action layer. Use one of: ${Object.keys(INTENTS).join(', ')}.`, results: [] };
    }
    const I = makeRunner(bot, opts);
    try {
        const out = await it.run(I, a);
        if (out.quiet) return { ok: true, quiet: true, message: null, results: I.results };
        if (out.fail) return { ok: false, message: `Failed ${a.action}${a.target ? ` ${a.target}` : ''}: ${out.fail}.`, results: I.results };
        return { ok: true, message: out.msg, results: I.results };
    } catch (e) {
        if (e instanceof Cancelled) return { ok: false, cancelled: true, message: null, results: I.results };
        return { ok: false, message: `Failed ${a.action}: internal error (${String(e.message || e).slice(0, 160)}).`, results: I.results };
    }
}

/** The action catalogue for the LLM prompt, generated from the table above (the single source of truth). */
function catalogue() {
    return Object.entries(INTENTS).map(([, it]) => it.doc).join('\n') + '\n[{"action":"stop"}]                                          -- cancel everything and stand still';
}

module.exports = { runIntent, catalogue, INTENTS, blockNames, cellsNear, surface };
