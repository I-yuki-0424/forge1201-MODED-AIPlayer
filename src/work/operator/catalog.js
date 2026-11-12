'use strict';
// The commands a person can send to bots from the console, as data the page turns into forms (dropdowns, coordinate pickers), so
// nobody has to remember a syntax. The 15 action-layer commands come from src/skills/index.js (their argument schemas are the single
// source); `META` adds the operator conveniences that are not action-layer commands (come, say, teleport, stop).
const { COMMANDS } = require('../../skills');

const DOC = {
    move_to: ['Movement', 'Walk to a block (x, y, z); the planner finds the way and swims or climbs where it must.'],
    look_at: ['Movement', 'Turn the head to a block, or to an entity.'],
    mine: ['Blocks', 'Walk up to a block, pick the right tool, dig it and collect the drop.'],
    tunnel: ['Blocks', 'Dig one step of a tunnel in a direction (level, down or up).'],
    place: ['Blocks', 'Place a block item into a cell, against any solid neighbour. Mod items use their full name (create:cogwheel).'],
    activate: ['Blocks', 'Right-click a block (door, lever, chest, ...), optionally holding an item, optionally sneaking.'],
    pickup: ['Items', 'Walk to a dropped item (by entity, or by item name) and pick it up.'],
    attack: ['Combat', 'Fight an entity until it is dead (pick it from the nearby list).'],
    equip: ['Items', 'Hold an item or put it on (hand, off hand, armour slot).'],
    eat: ['Items', 'Eat food from the inventory (any food, or a chosen one).'],
    toss: ['Items', 'Drop items on the ground.'],
    craft: ['Items', 'Craft an item (at a crafting table if x y z is given, otherwise in the 2x2 grid).'],
    smelt: ['Items', 'Smelt in a furnace (x y z) with fuel from the inventory.'],
    deposit: ['Items', 'Walk to a chest and put items into it.'],
    withdraw: ['Items', 'Walk to a chest and take items out.'],
};
const HINT = { x: 'x', y: 'y (feet level)', z: 'z', entity: 'nearby entity', item: 'item', count: 'count', dest: 'where', dir: 'direction', dy: 'slope', fluid: 'fill water or lava', sneak: 'sneak', collect: 'pick up the drop (default yes)', blind: 'dig without line of sight' };

const META = [
    { name: 'gather', group: 'Blocks', meta: true, doc: 'Collect a number of an item: finds the blocks that give it in the chunks the bot has loaded, walks to the nearest and digs everything within reach before it walks on.', args: [{ name: 'target', type: 'item', hint: 'block or item (iron_ore, raw_iron, oak_log, cobblestone, sand ...)' }, { name: 'count', type: 'count', optional: true, hint: 'how many (default 16)' }, { name: 'radius', type: 'int', optional: true, hint: 'search radius in blocks (default 32, at most 64)' }] },
    { name: 'obtain', group: 'Items', meta: true, doc: 'Have this many of an item in the pack: it is mined, smelted or crafted as the item needs (a crafting table or furnace is made and put down when none is near, fuel is found). wood, stone (smelted), iron (ingots) are accepted names.', args: [{ name: 'item', type: 'item', hint: 'oak_log, cobblestone, stone, iron_ingot, iron_block, crafting_table ... (wood = any log)' }, { name: 'count', type: 'count', hint: 'how many to have in the pack' }] },
    { name: 'expert_walk', group: 'Movement', meta: true, doc: 'Walk to a cell with the trained movement expert (round ponds and hills, digging only where the way is closed). Within about 4 chunks.', args: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int', hint: 'y (feet level)' }, { name: 'z', type: 'int' }] },
    { name: 'expert_escape', group: 'Movement', meta: true, doc: 'Get out of a hole, shaft or sealed pocket with the trained stuck-escape expert (digs and climbs). Without a cell: the open ground around.', args: [{ name: 'x', type: 'int', optional: true }, { name: 'y', type: 'int', optional: true, hint: 'y (feet level)' }, { name: 'z', type: 'int', optional: true }] },
    { name: 'come', group: 'Movement', meta: true, doc: 'Walk to the operator (a player on the server).', args: [{ name: 'player', type: 'player', optional: true }] },
    { name: 'say', group: 'Chat', meta: true, doc: 'Say something in chat (not a command: text starting with / is refused).', args: [{ name: 'text', type: 'text' }] },
    { name: 'teleport', group: 'Operator', meta: true, rcon: true, doc: 'Teleport the bot (server command): to a player, or to coordinates. Refused while "Server moves" on the Automation page is off (the default since 2026-11-10).', args: [{ name: 'player', type: 'player', optional: true }, { name: 'x', type: 'int', optional: true }, { name: 'y', type: 'int', optional: true }, { name: 'z', type: 'int', optional: true }, { name: 'dim', type: 'dim', optional: true, hint: 'another dimension (with x, y, z): overworld, nether, end or an id' }] },
    { name: 'journey', group: 'Movement', meta: true, doc: 'A long walk to x, y, z, in legs (a plain walk fails where the chunks are not loaded). Choose another dimension (the Nether, the End, or any id such as twilightforest:twilight_forest) and the route goes through a tagged portal that leads there; with "by the server" (and y) the server puts the bot there when no gate does. "by the Nether" shortens a long overworld walk when gates are tagged on both sides. The bot stays in the dimension it was sent to. Experimental.', args: [{ name: 'x', type: 'int' }, { name: 'z', type: 'int' }, { name: 'y', type: 'int', optional: true }, { name: 'dim', type: 'dim', optional: true }, { name: 'viaNether', type: 'bool', optional: true, hint: 'by the Nether (long overworld walks)' }, { name: 'viaServer', type: 'bool', optional: true, hint: 'by the server (needs y; no gate needed)' }] },
    { name: 'bridge', group: 'Blocks', meta: true, doc: 'Work over a gap (an abyss: End islands, a lava sea): lay a bridge of temporary blocks from where the bot stands, level, to the cell beside the block at x y z, mine it / place a block there / do nothing, then walk back and stop. The bridge stays. Bot start: a cell with a solid floor. WIP, not run live.', args: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int' }, { name: 'job', type: 'text', optional: true, hint: 'mine (default none), place or none' }, { name: 'item', type: 'item', optional: true, hint: 'block to place (job place)' }] },
    { name: 'trades', group: 'Items', meta: true, doc: 'Walk to a villager (the nearest, or the one picked) and list what it offers: the list goes to the log. WIP.', args: [{ name: 'entity', type: 'entity', optional: true, hint: 'villager (nearest if none)' }] },
    { name: 'trade', group: 'Items', meta: true, doc: 'Trade with a villager: name the trade by its number from "trades", or by the item it gives (get) or takes (give); count is how many times. The cheapest open trade that matches is used. Fails, with the reason, when it is sold out or the bot cannot pay. WIP.', args: [{ name: 'get', type: 'item', optional: true, hint: 'item the trade gives (emerald, bread ...)' }, { name: 'give', type: 'item', optional: true, hint: 'item the trade takes' }, { name: 'index', type: 'int', optional: true, hint: 'trade number from "trades"' }, { name: 'count', type: 'count', optional: true, hint: 'times (default 1)' }, { name: 'maxPrice', type: 'int', optional: true, hint: 'most of the first payment item per use' }, { name: 'entity', type: 'entity', optional: true, hint: 'villager (nearest if none)' }] },
    { name: 'break_bedrock', group: 'Operator', meta: true, doc: 'Break the bedrock block at x y z (an exploit; only the frame exists, no method is implemented: it refuses with the reason). Off unless "Bedrock breaking (exploit)" is switched on on the Automation page; radius designates a box around the block (default: the block only).', args: [{ name: 'x', type: 'int' }, { name: 'y', type: 'int' }, { name: 'z', type: 'int' }, { name: 'radius', type: 'int', optional: true, hint: '0..8' }] },
    { name: 'set_spawn', group: 'Operator', meta: true, doc: 'Set the respawn point at a bed (touch it; at night the bot lies down and gets up at once). Bots sent together line up at the bed in name order, one at a time, each with a time limit; one that fails is sent away and the next goes. Give the bed\'s x y z, or none for the nearest bed.', args: [{ name: 'x', type: 'int', optional: true }, { name: 'y', type: 'int', optional: true }, { name: 'z', type: 'int', optional: true }] },
    { name: 'stop', group: 'Movement', meta: true, doc: 'Cancel what the bot is doing right now.', args: [] },
];

// Operator-only arguments added to an action-layer command (the RL action space is unchanged: the work service takes them off before the command runs).
const EXTRA = { move_to: [{ name: 'dim', type: 'dim', optional: true, hint: 'another dimension: the bot walks to a tagged gate that leads there, goes through and walks on to x y z (never a server move)' }] };

function catalog() {
    const out = Object.entries(COMMANDS).map(([name, c]) => ({
        name, group: DOC[name][0], doc: DOC[name][1] + (EXTRA[name] ? ' Choose a dimension to go through a tagged gate (portal) that leads there.' : ''),
        args: [...Object.entries(c.args).map(([a, t]) => ({ name: a, type: t.replace('?', ''), optional: t.endsWith('?'), hint: HINT[a] || a })), ...(EXTRA[name] || [])],
        oneOf: c.oneOf || null, allOrNone: c.allOrNone || null,
    }));
    return [...out, ...META].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

module.exports = { catalog, META };
