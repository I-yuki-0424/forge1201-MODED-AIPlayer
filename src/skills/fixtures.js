'use strict';
// Fixtures (owner rule, 2026-11-09): a chest, barrel, ender chest, Ender Storage chest or shulker box that the bot did not place itself belongs to the owner's
// build. The bot may use what is inside, but it never breaks the block. A box the bot carried, placed and used is its own: it is picked up again promptly.
// The work layer sets `fixture` in the per-bot options (options.js); without it (RL bots, the legacy actuator) nothing changes.
// Own boxes are remembered in `bot.__placed` (a Set of "x,y,z"; the work service shares one Set between its bots and keeps it across restarts).
const BOX = /^((minecraft:)?(chest|trapped_chest|barrel|ender_chest|(?:[a-z]+_)?shulker_box)|enderstorage:ender_(chest|tank))$/;

const keyOf = (c) => `${c.x},${c.y},${c.z}`;
const isBox = (name) => BOX.test(String(name || ''));
const placedSet = (bot) => bot.__placed || (bot.__placed = new Set());
const isOwn = (bot, cell) => !!bot.__placed && bot.__placed.has(keyOf(cell));
/** A block the bot just placed from its pack: remembered while it is a box. */
const markPlaced = (bot, name, cell) => { if (isBox(name)) placedSet(bot).add(keyOf(cell)); };
/** The block is gone (broken, picked up): forget it. */
const unmark = (bot, cell) => { if (bot.__placed) bot.__placed.delete(keyOf(cell)); };

module.exports = { BOX, isBox, isOwn, markPlaced, unmark, placedSet, keyOf };
