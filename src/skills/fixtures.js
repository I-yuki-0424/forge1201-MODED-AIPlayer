'use strict';
// Fixtures (owner rule, 2026-11-09): a chest, barrel, ender chest, Ender Storage chest or shulker box that the bot did not place itself belongs to the owner's
// build. The bot may use what is inside, but it never breaks the block. A box the bot carried, placed and used is its own: it is picked up again promptly.
// The work layer sets `fixture` in the per-bot options (options.js); without it (RL bots, the legacy actuator) nothing changes.
// Own boxes are remembered in `bot.__placed` (a Set of "x,y,z"; the work service shares one Set between its bots and keeps it across restarts).
const BOX = /^((minecraft:)?(chest|trapped_chest|barrel|ender_chest|(?:[a-z]+_)?shulker_box)|enderstorage:ender_(chest|tank))$/;

// A bed is a fixture too (owner 2026-11-10: a bot broke the bed of its respawn point and was stuck): never broken, whoever placed it.
const BED = /(^|:)[a-z_]*_bed$/;
const isBed = (name) => BED.test(String(name || ''));
// A container that cannot be opened with a block on top of it (chest, trapped chest, Ender chest, shulker box): nothing is ever placed on top of one (`place`, the pillar).
const CONTAINER_TOP = /(^|:)(chest|trapped_chest|ender_chest|(?:[a-z]+_)?shulker_box)$/;
/** Would a block at `cell` sit on top of such a container? `w`: world model or anything with blockAt(x, y, z) -> {name}. */
const coversContainer = (w, cell) => { const b = w && w.blockAt ? w.blockAt(cell.x, cell.y - 1, cell.z) : null; return !!b && CONTAINER_TOP.test(String(b.name || '')); };
/** The short dimension name of a bot (overworld, nether, end, or the full id): the key the shared list of placed blocks uses. */
const dimOf = (bot) => { const d = String((bot && bot.game && bot.game.dimension) || 'overworld').replace(/^minecraft:/, ''); return d === 'the_nether' ? 'nether' : d === 'the_end' ? 'end' : d; };

const keyOf = (c) => `${c.x},${c.y},${c.z}`;
const isBox = (name) => BOX.test(String(name || ''));
const placedSet = (bot) => bot.__placed || (bot.__placed = new Set());
const isOwn = (bot, cell) => !!bot.__placed && bot.__placed.has(keyOf(cell));
/** A block the bot just placed from its pack: remembered while it is a box. */
const markPlaced = (bot, name, cell) => { if (isBox(name)) placedSet(bot).add(keyOf(cell)); };
/** The block is gone (broken, picked up): forget it. */
const unmark = (bot, cell) => { if (bot.__placed) bot.__placed.delete(keyOf(cell)); };

module.exports = { BOX, BED, isBed, CONTAINER_TOP, coversContainer, dimOf, isBox, isOwn, markPlaced, unmark, placedSet, keyOf };
