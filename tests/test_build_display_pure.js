'use strict';
// The in-game display during a structure build (src/build): the service's displayState answers for a construct job (it threw there and the overlay drew nothing, 2026-11-22) with the
// box and one claim region per bot in that bot's colour; the mover's planned way reaches the bot's path.
const assert = require('assert');
const { DisplayPart } = require('../src/work/service/display');

const build = {
    t: { box: { x: 10, y: 60, z: 20, sx: 8, sy: 4, sz: 6 } }, frontier: 61,
    claims: new Map([['11,61,21', 'A'], ['13,62,22', 'A'], ['16,61,24', 'B']]),
    bots: new Map([['A', { station: [{ x: 12, y: 63, z: 20 }, { x: 12, y: 64, z: 20 }] }], ['B', { station: null }]]),
};
const self = {
    bots: new Map([['A', { name: 'A', state: 'online', bot: { entity: { position: { x: 12, y: 63, z: 20 } }, game: { dimension: 'minecraft:overworld' } }, worker: {}, path: { cells: [[12, 63, 20], [13, 63, 20]], at: Date.now() } }],
        ['B', { name: 'B', state: 'online', bot: { entity: { position: { x: 16, y: 62, z: 24 } }, game: { dimension: 'minecraft:overworld' } }, worker: {} }]]),
    jobs: new Map([['j1', { id: 'j1', kind: 'construct', state: 'running', spec: { dim: 'overworld' }, impl: { build } }]]),
    sites: { list: () => [] },
};
const st = DisplayPart.prototype.displayState.call(self);
const claimA = st.lanes.find((l) => l.id === 'claim A'), claimB = st.lanes.find((l) => l.id === 'claim B'), box = st.lanes.find((l) => l.id === 'build');
assert.deepStrictEqual(claimA.box, { x0: 11, x1: 13, z0: 20, z1: 22 }, 'A: its two cells and its stance');
assert.strictEqual(claimA.rim, 63); assert.strictEqual(claimA.activeY, 61);
assert.strictEqual(claimA.color, 0); assert.strictEqual(claimB.color, 1, 'each claim in its bot colour');
assert.deepStrictEqual(box.box, { x0: 10, x1: 17, z0: 20, z1: 25 }); assert.strictEqual(box.rim, 63); assert.strictEqual(box.activeY, 61);
assert.ok(st.lanes.indexOf(box) > st.lanes.indexOf(claimA), 'the claims come before the box (the layer has a cap)');
assert.strictEqual(st.bots.find((b) => b.name === 'A').path.cells.length, 2);
console.log('test_build_display_pure: 1 passed (6 checks)');
