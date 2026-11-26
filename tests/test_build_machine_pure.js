'use strict';
// Machines built safely (src/build/machine.js, TASK-20261125-081): a power source of a machine is placed last, an observer after the cell it watches, so no piston of the build
// fires while it is built (b081m, Fabric 1.21.1: its pistons moved blocks of iron-farm-34 mid-build). Negative controls: a wire waits for nothing; a source with its machine standing
// is ready; a torch far from any part is a machine of its own.
const assert = require('assert');
const { EventEmitter } = require('events');
const { Vec3 } = require('vec3');
const { Target } = require('../src/build/target');
const MC = require('../src/build/machine');

/** A 7 x 3 x 3 box at y 64: a stone floor; on it a sticky piston facing up at x 1 with a stone over it, a wire at x 2, a redstone torch at x 3; an observer at x 6 watching x 5. */
function farm() {
    const palette = [{ name: 'minecraft:air', props: {} }, { name: 'minecraft:stone', props: {} }, { name: 'minecraft:sticky_piston', props: { facing: 'up', extended: 'false' } },
        { name: 'minecraft:redstone_wire', props: { power: '0' } }, { name: 'minecraft:redstone_torch', props: { lit: 'true' } }, { name: 'minecraft:observer', props: { facing: 'west', powered: 'false' } }];
    const blocks = [];
    for (let x = 0; x < 7; x++) for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) blocks.push({ x, y, z, s: y === 0 ? 1 : 0 });
    const set = (x, y, z, s) => { blocks.find((b) => b.x === x && b.y === y && b.z === z).s = s; };
    set(1, 1, 1, 2); set(1, 2, 1, 1); set(2, 1, 1, 3); set(3, 1, 1, 4); set(5, 1, 1, 1); set(6, 1, 1, 5);
    return new Target({ size: [7, 3, 3], palette, blocks }, { x: 0, y: 64, z: 0 });
}
const tkOf = (t, x, y, z) => ({ k: `${x},${y},${z}`, x, y, z, i: t.idx(x, y, z), kind: 'place' });

const t = farm();
const open = new Set(['1,65,1', '1,66,1', '2,65,1', '5,65,1']);
const isOpen = (j) => { const c = t.cell(j); return open.has(`${c.x},${c.y},${c.z}`); };
assert.match(MC.waits(t, tkOf(t, 3, 65, 1), isOpen, 0) || '', /power source/, 'the torch waits while the piston, the stone it pushes and the wire are to place');
assert.strictEqual(MC.waits(t, tkOf(t, 2, 65, 1), isOpen, 0), null, 'negative control: the wire waits for nothing');
assert.match(MC.waits(t, tkOf(t, 6, 65, 1), isOpen, 0) || '', /observer/, 'the observer waits for the cell it watches');
open.clear();
assert.strictEqual(MC.waits(t, tkOf(t, 3, 65, 1), isOpen, 10000), null, 'negative control: the machine stands, the torch goes in');
assert.strictEqual(MC.waits(t, tkOf(t, 6, 65, 1), isOpen, 10000), null, 'the watched cell stands');
console.log('  ok a power source last, an observer after the cell it watches; a wire waits for nothing');

// the watch: a piston that extends before any power source of the build stands is counted as mid-build, a cell that turns into moving_piston as moved
const job = { t, stats: {} }, logs = [], bot = new EventEmitter(), world = new Map();
bot.blockAt = (p) => { const n = world.get(`${p.x},${p.y},${p.z}`) || 'air'; return { name: n, getProperties: () => ({}) }; };
const stop = MC.attach(job, bot, (s) => logs.push(s));
const blk = (name, x, y, z, props = {}) => ({ name, position: new Vec3(x, y, z), getProperties: () => props });
bot.emit('blockUpdate', blk('sticky_piston', 1, 65, 1, { extended: 'false' }), blk('sticky_piston', 1, 65, 1, { extended: 'true' }));
bot.emit('blockUpdate', blk('stone', 1, 66, 1), blk('moving_piston', 1, 66, 1));
assert.deepStrictEqual(job.stats.machine, { moved: 1, fires: 1, movedPowered: 0, firesPowered: 0 }, JSON.stringify(job.stats));
assert.match(logs[0], /mid-build/);
world.set('3,65,1', 'redstone_torch');          // the torch stands: what moves now is the finished machine running
bot.emit('blockUpdate', blk('stone', 2, 66, 1), blk('moving_piston', 2, 66, 1));
assert.strictEqual(job.stats.machine.movedPowered, 1); assert.strictEqual(job.stats.machineMoved, 1, 'the progress counter: mid-build moves only');
bot.emit('blockUpdate', blk('stone', 9, 65, 1), blk('moving_piston', 9, 65, 1));
assert.strictEqual(job.stats.machine.movedPowered, 1, 'negative control: outside the box');
stop();
console.log('  ok a piston firing and a moved cell are counted, mid-build apart from the finished machine');
console.log('test_build_machine_pure: 2 passed');
