'use strict';
// The preconditions of the instructions that act on a target (docs/implemented/COMMAND-STACK-v1.md). One rule: each condition is decidable from the current state alone, with no
// knowledge of why it fails or what would fix it. `unmet(bot, name, args)` returns [] when the instruction may run, else the unmet conditions, each with the measured value:
//   { need: 'chunk_loaded', cell }                      the block is not in a loaded chunk
//   { need: 'in_reach', dist, max }                     the target is farther than the bot can reach from where it stands
//   { need: 'tool_held', item } | { need: 'item_held', item }   the right tool / the item to place or use is not in the hand
//   { need: 'item_in_pack', item, count }               the item to place or use is not in the pack at all
// (`line_of_sight` comes from the command itself, which holds the aim geometry.) Nothing here walks, equips or names a remedy: the router does, from the whole state.
// Conditions the command already reports on its own (air, a fixture, no tool in the pack at all, no solid neighbour) stay with the command: they are not precondition failures.
const { EYE, ENTITY_REACH, distToBox, entityBox } = require('./geometry');
const { AIM_REACH, feetCell } = require('./motion');
const { fromBot } = require('./world');
const skillOpts = require('./options');
const { bestTool, supports, tunnelCells, tunnelProblem } = require('./commands/block');
const { bestWeapon } = require('./commands/entity');
const { count, resolveItemName } = require('./commands/item');

const BLIND_REACH = 5.0;                       // the same figure `mine` uses for a blind dig
const r2 = (v) => Math.round(v * 100) / 100;

const eyeOf = (bot) => { const p = bot.entity.position; return { x: p.x, y: p.y + EYE, z: p.z }; };
/** Distance from `eye` to the nearest point of the block cube at `c`. */
function cubeDist(eye, c) {
    const d = (a, lo) => Math.max(lo - a, 0, a - (lo + 1));
    return Math.hypot(d(eye.x, c.x), d(eye.y, c.y), d(eye.z, c.z));
}
const held = (bot, name, ok = () => true) => !!bot.heldItem && bot.heldItem.name === name && ok(bot.heldItem);
const reach = (eye, c, max) => { const d = cubeDist(eye, c); return d > max ? { need: 'in_reach', dist: r2(d), max: r2(max) } : null; };

function unmet(bot, name, args) {
    const w = fromBot(bot), eye = eyeOf(bot), out = [], notWorn = (i) => !skillOpts.isWorn(bot, i);
    const push = (u) => { if (u) out.push(u); };
    switch (name) {
        case 'mine': {
            const cell = { x: args.x, y: args.y, z: args.z }, b = w.blockAt(cell.x, cell.y, cell.z);
            if (!b) return [{ need: 'chunk_loaded', cell }];
            if (/^(air|cave_air|void_air)$/.test(b.name) || !b.diggable || ['liquid', 'water'].includes(w.kindAt(cell.x, cell.y, cell.z))) return [];   // the command says invalid_target
            push(reach(eye, cell, args.blind ? BLIND_REACH : AIM_REACH));
            const t = bestTool(bot, b);
            if (t && t.name && !held(bot, t.name, notWorn)) out.push({ need: 'tool_held', item: t.name });
            return out;
        }
        case 'place': {
            const cell = { x: args.x, y: args.y, z: args.z };
            // the item is reported even when the target is far away: the router makes it first (a craft takes minutes), then walks
            if (!w.blockAt(cell.x, cell.y, cell.z)) return [...(count(bot, args.item) < 1 ? [{ need: 'item_in_pack', item: args.item, count: 1 }] : []), { need: 'chunk_loaded', cell }];
            const refs = supports(w, cell);
            if (refs.length) {
                const near = refs.map((r) => cubeDist(eye, r.cell)).sort((a, b) => a - b)[0];
                if (near > AIM_REACH) out.push({ need: 'in_reach', dist: r2(near), max: r2(AIM_REACH) });
            }
            if (count(bot, args.item) < 1) out.push({ need: 'item_in_pack', item: args.item, count: 1 });         // the router gets it: gather, smelt or craft (src/stack/obtain.js)
            else if (!held(bot, args.item)) out.push({ need: 'item_held', item: args.item });
            return out;
        }
        case 'activate': {
            const cell = { x: args.x, y: args.y, z: args.z };
            if (!w.blockAt(cell.x, cell.y, cell.z)) return [{ need: 'chunk_loaded', cell }];
            push(reach(eye, cell, AIM_REACH));
            if (args.item) { const n = resolveItemName(bot, args.item); if (count(bot, n) < 1) out.push({ need: 'item_in_pack', item: n, count: 1 }); else if (!held(bot, n)) out.push({ need: 'item_held', item: n }); }
            return out;
        }
        case 'attack': {
            const e = bot.entities[args.entity];
            if (!e || e === bot.entity) return [];                                   // the command says invalid_target
            const d = distToBox(eye, entityBox(e.position, e.width || 0.6, e.height || 1.8));
            if (d > ENTITY_REACH - 0.2) out.push({ need: 'in_reach', dist: r2(d), max: r2(ENTITY_REACH - 0.2) });
            const wp = bestWeapon(bot);
            if (wp.name && !held(bot, wp.name)) out.push({ need: 'tool_held', item: wp.name });
            return out;
        }
        case 'tunnel': {
            const f = feetCell(bot.entity.position);
            if (tunnelProblem(w, f, args.dir, args.dy)) return [];                   // the command says why (no floor, fluid behind, nothing to dig)
            for (const c of tunnelCells(f, args.dir, args.dy).clear) {
                const b = w.blockAt(c.x, c.y, c.z);
                if (!b || w.kindAt(c.x, c.y, c.z) !== 'solid') continue;
                const t = bestTool(bot, b);
                if (t && t.name && !held(bot, t.name, notWorn)) { out.push({ need: 'tool_held', item: t.name }); break; }
            }
            return out;
        }
        default: return [];
    }
}

module.exports = { unmet, cubeDist, eyeOf, BLIND_REACH };
