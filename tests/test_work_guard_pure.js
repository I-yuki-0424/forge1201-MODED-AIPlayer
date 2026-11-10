// Owner 2026-11-11: no riding on another bot's scaffolding, mining only inside the pit, a post that cannot be reached is given up, the shared road stays. Pure.
const assert = require('assert');
const { standable } = require('../src/skills/world');
const { Ledger } = require('../src/work/jobs/crew');
const { Temps, KINDS, CLEAN_NEAR } = require('../src/work/bot/temps');

setTimeout(() => { console.error('test watchdog: still running after 20 s'); process.exit(2); }, 20000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

(async () => {
    await test('the planner does not stand on a floor the bot is told to avoid (another bot\'s scaffolding), and nothing changes without the hook', () => {
        const w = { kindAt: (x, y, z) => (y === 0 ? 'solid' : 'air'), avoidFloor: null };
        assert.ok(standable(w, 5, 1, 5));
        w.avoidFloor = (x, y, z) => x === 5 && y === 0 && z === 5;
        assert.ok(!standable(w, 5, 1, 5), 'flagged floor'); assert.ok(standable(w, 6, 1, 5), 'the next cell is fine');
    });
    await test('the hook the service sets: another bot\'s movement blocks are avoided; one\'s own, the road and seals are not', () => {
        const T = new Temps();
        const avoid = (me) => (x, y, z) => { const t = T.get('overworld', { x, y, z }); return !!t && !!t.by && t.by !== me && CLEAN_NEAR.has(t.kind); };
        for (const [k, i] of [['pillar', 0], ['scaffold', 1], ['reflex', 2], ['bridge', 3], ['road', 4], ['seal', 5], ['rescue', 6]]) T.add({ dim: 'overworld', x: i, y: 0, z: 0, kind: k, by: 'B' });
        T.add({ dim: 'overworld', x: 9, y: 0, z: 0, kind: 'pillar', by: 'A' });
        const a = avoid('A');
        assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 9].map((x) => a(x, 0, 0)), [true, true, true, true, false, false, false, false]);
        assert.ok(KINDS.has('road') && !CLEAN_NEAR.has('road'), 'a road is a kind, and no passer takes it away');
    });
    await test('a post that cannot be reached is given up: the range is free, the bot is offered another and not the same one again for ten minutes', () => {
        const L = new Ledger({ lanes: true });
        for (let i = 0; i < 3; i++) L.addRegion({ id: `r${i}`, anchor: { x: i * 100, z: 0 }, layers: 2, rows: 2 });
        const a = L.claim('A', { x: 400, z: 0 }, 0); assert.strictEqual(a.region, 'r2');
        L.leave('A', 1);
        assert.ok(L.forfeit('A', 2)); assert.deepStrictEqual(L.homes(), {});
        assert.ok(!L.forfeit('A', 3), 'no post: nothing to give up');
        const again = L.claim('A', { x: 400, z: 0 }, 4); assert.notStrictEqual(again.region, 'r2', 'not the range it gave up');
        const b = L.claim('B', { x: 400, z: 0 }, 5); assert.strictEqual(b.region, 'r2', 'the next bot may have it at once');
        const late = L.claim('A', { x: 400, z: 0 }, 2 + 600001); assert.ok(late, 'after ten minutes it may be offered again');
    });
})().catch((e) => { console.error(e); process.exit(1); });
