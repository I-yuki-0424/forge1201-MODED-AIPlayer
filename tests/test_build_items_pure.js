'use strict';
// The crew's item entities on the site (src/build/items.js, TASK-20261125-081): every dropped stack near the build gets a cause at its spawn (toss, dig with a full pack, death,
// popped off a block that lost its support) and an end (picked up, despawned), so the material ledger can name where each missing item went (b081q5: 23 of 81 repeaters lost
// with no death). Negative controls: an entity far from the site is not counted; a toss long before the spawn is not its cause; a block dug by the crew is 'dig', not 'popped'.
const assert = require('assert');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { ItemWatch, DESPAWN_MS } = require('../src/build/items');

let now = 1000000;
const logs = [];
const job = { t: { box: { x: 0, y: 64, z: 0, sx: 10, sy: 10, sz: 10 }, items: new Map([['repeater', 10], ['smooth_stone', 50]]), inside: (x, y, z) => x >= 0 && x < 10 && y >= 64 && y < 74 && z >= 0 && z < 10 }, drops: [], log: (m) => logs.push(m) };
const W = new ItemWatch(job, { now: () => now });
const bot = new EventEmitter();
bot.entity = { position: new Vec3(3.5, 65, 3.5) };
let dug = 0, tossed = 0;
bot.dig = async () => { dug++; }; bot.toss = async () => { tossed++; }; bot.tossStack = async () => { tossed++; };
let giving = false, free = 5;
const stop = W.attach('A', bot, { crew: (n) => n === 'A' || n === 'B', giver: () => giving, free: () => free });
const ent = (id, x, y, z, name, count) => ({ id, name: 'item', position: new Vec3(x, y, z), getDroppedItem: () => (name ? { name, count } : null) });
const blk = (name, x, y, z) => ({ name, position: new Vec3(x, y, z) });

// 1. popped: the repeater's support (smooth stone under it) went, then the repeater turned into air without a dig, and its item appears in its cell
bot.emit('blockUpdate', blk('smooth_stone', 5, 64, 5), blk('air', 5, 64, 5));
now += 50;
bot.emit('blockUpdate', blk('repeater', 5, 65, 5), blk('air', 5, 65, 5));
now += 50;
const e1 = ent(1, 5.5, 65.1, 5.5, null, 0);
bot.emit('entitySpawn', e1);
W.refresh();
assert.ok(!W.ground().repeater, 'the kind is not known before the metadata');
e1.getDroppedItem = () => ({ name: 'repeater', count: 1 });
W.refresh();
assert.strictEqual(W.recs.get('1').cause, 'popped');
assert.ok(/smooth_stone->air at 5,64,5/.test(W.recs.get('1').detail), W.recs.get('1').detail);
assert.strictEqual(W.ground().repeater, 1);
assert.ok(logs.some((l) => /^\[items\] popped 1 repeater at 5,65,5/.test(l)), logs.join('\n'));
console.log('  ok a block that pops off its support is "popped", with the support named');

// 2. dig with a full pack: the crew dug the cell (bot.dig wrapped), the drop lies there; negative control for 'popped'
now += 5000; free = 0;
bot.dig({ position: new Vec3(2, 66, 2) });
now += 400;
bot.emit('blockUpdate', blk('smooth_stone', 2, 66, 2), blk('air', 2, 66, 2));
bot.emit('entitySpawn', ent(2, 2.5, 66.2, 2.5, 'smooth_stone', 1));
W.refresh();
assert.strictEqual(W.recs.get('2').cause, 'dig'); assert.strictEqual(W.recs.get('2').by, 'A'); assert.ok(/0 slots free/.test(W.recs.get('2').detail));
assert.strictEqual(dug, 1, 'the real dig still runs');
console.log('  ok a dug block whose drop lies on the ground is "dig" (with the free slots), not "popped"');

// 3. a toss: hand-over when the bot is a giver, else a drop; a toss 10 s before is not the cause (negative control)
now += 5000; giving = true;
bot.toss(1, null, 3);
now += 300;
bot.emit('entitySpawn', ent(3, 3.6, 66.0, 4.4, 'repeater', 3));
W.refresh();
assert.strictEqual(W.recs.get('3').cause, 'toss'); assert.strictEqual(W.recs.get('3').detail, 'hand-over'); assert.strictEqual(tossed, 1);
giving = false; now += 10000;
bot.emit('entitySpawn', ent(4, 3.6, 66.0, 4.4, 'repeater', 2));
W.refresh();
assert.strictEqual(W.recs.get('4').cause, 'unknown', 'negative control: a toss long before');
console.log('  ok a toss is "toss" (hand-over or drop), an old toss is not the cause');

// 4. death: a pack where a crew member died
now += 1000; job.drops.push({ x: 7, y: 64, z: 7, at: now, by: 'B', n: 40, items: {} });
bot.emit('entitySpawn', ent(5, 7.2, 64.5, 7.8, 'smooth_stone', 20));
W.refresh();
assert.strictEqual(W.recs.get('5').cause, 'death');
// negative control: far from the site
bot.emit('entitySpawn', ent(6, 500, 64, 500, 'repeater', 1));
assert.ok(!W.recs.has('6'), 'an entity far from the site is not counted');
console.log('  ok a dead bot\'s pack is "death"; an entity far away is not counted');

// 5. ends: picked up by the crew, despawned after five minutes, gone early (merged); the ground count follows
W.collect(3, 'B', true);
assert.strictEqual(W.byItem.get('repeater').picked.crew, 3);
bot.emit('entityGone', { id: 2, name: 'item' });
assert.strictEqual(W.byItem.get('smooth_stone').early, 1, 'gone young without a pickup: merged or burnt, not despawned');
now += DESPAWN_MS + 1000;
bot.emit('entityGone', { id: 1, name: 'item' });
assert.strictEqual(W.despawned().repeater, 1);
assert.ok(logs.some((l) => /^\[items\] despawned 1 repeater at 5,65,5 \(popped\)/.test(l)));
assert.strictEqual(W.ground().repeater, 2, 'only the untouched old stack is still lying');
// a stack still seen by another bot is not gone when one bot loses sight of it
const bot2 = new EventEmitter(); bot2.entity = { position: new Vec3(0, 65, 0) };
const stop2 = W.attach('B', bot2, {});
bot2.emit('entitySpawn', ent(4, 3.6, 66.0, 4.4, 'repeater', 2));
bot.emit('entityGone', { id: 4, name: 'item' });
assert.ok(!W.recs.get('4').fate, 'B still sees it');
const s = W.summary((it) => it === 'repeater').repeater;
assert.deepStrictEqual(s.spawned, { popped: 1, toss: 3, unknown: 2 });
stop(); stop2();
assert.strictEqual(typeof bot.dig, 'function');
console.log('  ok ends: picked up, despawned, merged; a stack another bot still sees stays on the ground');
console.log('test_build_items_pure: 5 passed');
