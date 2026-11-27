// mine_b's grader (scripts/t26/fixtures_kept.js, orchestrator ruling 2026-11-28): a cell `mine` refuses by rule (skills/commands/block.js refusal) is "kept", not dirty.
// The rule is the action layer's own, through the same per-bot fixture option the work service sets (service/bots.js -> library.isFixture).
const assert = require('assert');
const { fixturesKept } = require('../scripts/t26/fixtures_kept');
const { refusal } = require('../src/skills/commands/block');
const opts = require('../src/skills/options'), fx = require('../src/skills/fixtures');
function test(name, fn) { console.log(`--- test: ${name} ---`); fn(); console.log('[OK]'); }

const placed = new Set();
const bot = {}; opts.configure(bot, { fixture: (n, x, y, z) => !placed.has(`${x},${y},${z}`) && (fx.isBox(n) || fx.isBed(n)) });
const refuse = (c, n) => !!refusal(bot, c, n);
const box = { x0: 0, z0: 0, x1: 3, z1: 3 };
const world = (cells) => (x, y, z) => (cells[`${x},${y},${z}`] !== undefined ? cells[`${x},${y},${z}`] : 'air');

test('a layer whose only block is a natural chest (or a loot barrel) is clean, the chest is listed as kept (mbc075k w3: 4 layers dirty for one chest)', () => {
    const r = fixturesKept([-15, -14], box, world({ '1,-15,2': 'minecraft:chest', '2,-14,1': 'barrel', '0,-14,0': 'cave_air' }), refuse);
    assert.deepStrictEqual(r.dirty, []); assert.deepStrictEqual(r.fixtures, [[1, -15, 2, 'chest'], [2, -14, 1, 'barrel']]);
});
test('negative controls: stone or water beside the chest keeps the layer dirty; a chest the bot placed itself is no fixture; an unloaded cell is no judgement', () => {
    assert.deepStrictEqual(fixturesKept([5], box, world({ '1,5,2': 'chest', '3,5,3': 'stone' }), refuse).dirty, [5]);
    assert.deepStrictEqual(fixturesKept([5], box, world({ '0,5,0': 'water' }), refuse).dirty, [5]);
    placed.add('1,6,2'); assert.deepStrictEqual(fixturesKept([6], box, world({ '1,6,2': 'chest' }), refuse).dirty, [6], 'its own chest it must take away');
    assert.deepStrictEqual(fixturesKept([7], box, (x, y, z) => (x === 2 ? null : 'air'), refuse).dirty, [7]);
});
test('a pit worker outside its work area: the cell is refused (outside the work area) and kept, as mine would leave it', () => {
    const w = { __mineBox: { x0: 10, x1: 20, z0: 10, z1: 20, top: 60, bottom: 0 } }; opts.configure(w, { fixture: () => false });
    assert.deepStrictEqual(fixturesKept([1], box, world({ '0,1,0': 'stone' }), (c, n) => !!refusal(w, c, n)).fixtures, [[0, 1, 0, 'stone']]);
});
console.log('fixtures kept: all tests passed');
