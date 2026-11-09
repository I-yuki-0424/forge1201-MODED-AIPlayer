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
    { name: 'come', group: 'Movement', meta: true, doc: 'Walk to the operator (a player on the server).', args: [{ name: 'player', type: 'player', optional: true }] },
    { name: 'say', group: 'Chat', meta: true, doc: 'Say something in chat (not a command: text starting with / is refused).', args: [{ name: 'text', type: 'text' }] },
    { name: 'teleport', group: 'Operator', meta: true, rcon: true, doc: 'Teleport the bot (server command): to a player, or to coordinates.', args: [{ name: 'player', type: 'player', optional: true }, { name: 'x', type: 'int', optional: true }, { name: 'y', type: 'int', optional: true }, { name: 'z', type: 'int', optional: true }] },
    { name: 'journey', group: 'Movement', meta: true, doc: 'A long walk to x, y, z, in legs (a plain walk fails where the chunks are not loaded). Choose another dimension and the route goes through a tagged portal that leads there; "by the Nether" shortens a long overworld walk when gates are tagged on both sides. Experimental.', args: [{ name: 'x', type: 'int' }, { name: 'z', type: 'int' }, { name: 'y', type: 'int', optional: true }, { name: 'dim', type: 'dim', optional: true }, { name: 'viaNether', type: 'bool', optional: true }] },
    { name: 'set_spawn', group: 'Operator', meta: true, doc: 'Set the respawn point at a bed (touch it; at night the bot lies down and gets up at once). Bots sent together line up at the bed in name order, one at a time, each with a time limit; one that fails is sent away and the next goes. Give the bed\'s x y z, or none for the nearest bed.', args: [{ name: 'x', type: 'int', optional: true }, { name: 'y', type: 'int', optional: true }, { name: 'z', type: 'int', optional: true }] },
    { name: 'stop', group: 'Movement', meta: true, doc: 'Cancel what the bot is doing right now.', args: [] },
];

function catalog() {
    const out = Object.entries(COMMANDS).map(([name, c]) => ({
        name, group: DOC[name][0], doc: DOC[name][1],
        args: Object.entries(c.args).map(([a, t]) => ({ name: a, type: t.replace('?', ''), optional: t.endsWith('?'), hint: HINT[a] || a })),
        oneOf: c.oneOf || null, allOrNone: c.allOrNone || null,
    }));
    return [...out, ...META].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

module.exports = { catalog, META };
