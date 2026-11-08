// Varied escapes (src/work/bot/escape.js): the same failure in the same place is not answered with the same fix again and again.
const assert = require('assert');
const { pick, freshDirection, areaKey, ORDER } = require('../src/work/bot/escape');

function test(name, fn) { console.log(`--- test: ${name} ---`); fn(); console.log('[OK]'); }

test('first failure: level 2 jump, 3 step aside, 4 and more back to the last good place (as before)', () => {
    const at = { x: 10, y: 5, z: 10 };
    assert.deepStrictEqual([2, 3, 4, 5, 9].map((l) => pick(new Map(), l, { reason: 'stuck' }, at).fix), ['jump', 'sidestep', 'return', 'return', 'return']);
});

test('the same failure in the same place goes through different fixes and wraps round; another place or reason starts again', () => {
    const hist = new Map(), at = { x: 10, y: 5, z: 10 }, f = { reason: 'unreachable' };
    const seq = Array.from({ length: 7 }, () => pick(hist, 2, f, at).fix);
    assert.deepStrictEqual(seq, ['jump', 'sidestep', 'return', 'back_off', 'wait', 'lift', 'jump']);
    assert.strictEqual(new Set(seq.slice(0, 6)).size, 6, 'six different fixes before one repeats');
    assert.strictEqual(pick(hist, 2, f, { x: 40, y: 5, z: 10 }).fix, 'jump', 'another place');
    assert.strictEqual(pick(hist, 2, { reason: 'stuck' }, at).fix, 'jump', 'another reason');
    assert.strictEqual(pick(hist, 2, f, { x: 11, y: 5, z: 9 }).fix, 'sidestep', 'one block away is the same area (3x3x3)');
});

test('the history is forgotten after two minutes and stays small', () => {
    const hist = new Map(), at = { x: 0, y: 0, z: 0 }, f = { reason: 'stuck' };
    pick(hist, 2, f, at, 1000); assert.strictEqual(pick(hist, 2, f, at, 2000).fix, 'sidestep');
    assert.strictEqual(pick(hist, 2, f, at, 2000 + 121000).fix, 'jump', 'a new episode');
    for (let i = 0; i < 200; i++) pick(hist, 2, { reason: 'stuck' }, { x: i * 30, y: 0, z: 0 });
    assert.ok(hist.size <= 64);
});

test('sidesteps try a direction not used yet here before any is used twice', () => {
    const h = { dirs: [] }, seen = [];
    for (let i = 0; i < 4; i++) seen.push(freshDirection(h).join());
    assert.strictEqual(new Set(seen).size, 4, seen.join(' '));
    assert.strictEqual(freshDirection(h).length, 2, 'then any');
    assert.ok(areaKey(null, null).startsWith('none@') && ORDER.length === 6);
});

console.log('\nwork escape: all tests passed');
