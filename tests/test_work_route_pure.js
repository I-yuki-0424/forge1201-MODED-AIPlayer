// Routes across dimensions (bot/route.js) and walking through a gate (bot/portal.js): tagged gates, the nearest gate that leads where it must, the Nether shortcut
// only when it is clearly shorter; the crossing walks beside the gate, presses forward until the dimension changes and walks out of the exit.
const assert = require('assert');
const { Sites } = require('../src/work/bot/sites');
const route = require('../src/work/bot/route');
const { cross, beside } = require('../src/work/bot/portal');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const throws = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('did not throw'); };

function gates() {
    const s = new Sites();
    s.add({ name: 'ow-home', x: 100, y: 64, z: 100, purpose: 'portal', dim: 'overworld' });
    s.add({ name: 'ne-home', x: 12, y: 70, z: 12, purpose: 'portal', dim: 'nether', twin: 'ow-home' });
    s.add({ name: 'ow-far', x: 4000, y: 70, z: 4000, purpose: 'portal', dim: 'overworld' });
    s.add({ name: 'ne-far', x: 500, y: 70, z: 500, purpose: 'portal', dim: 'nether', twin: 'ow-far' });
    s.add({ name: 'ow-home', x: 100, y: 64, z: 100, purpose: 'portal', dim: 'overworld', twin: 'ne-home' });
    s.add({ name: 'ow-far', x: 4000, y: 70, z: 4000, purpose: 'portal', dim: 'overworld', twin: 'ne-far' });
    return s;
}

(async () => {
    await test('gates: purpose portal with a dimension and a twin; unknown dimension, twin on a non-portal and a gate that is its own twin are refused; removing a gate unlinks its twin', () => {
        const s = gates();
        assert.deepStrictEqual([s.get('ne-home').dim, s.get('ne-home').twin, s.get('ow-home').twin], ['nether', 'ow-home', 'ne-home']);
        assert.strictEqual(s.add({ name: 'p', x: 1, y: 1, z: 1, purpose: 'portal' }).dim, 'overworld', 'overworld unless said');
        throws(() => s.add({ name: 'q', x: 2, y: 1, z: 1, purpose: 'portal', dim: 'mars' }), /dim: one of/);
        throws(() => s.add({ name: 'q', x: 2, y: 1, z: 1, purpose: 'ore', twin: 'p' }), /belongs to a portal/);
        throws(() => s.add({ name: 'q', x: 2, y: 1, z: 1, purpose: 'portal', twin: 'q' }), /own twin/);
        assert.strictEqual(s.add({ name: 'r', x: 3, y: 1, z: 1, purpose: 'portal', dim: 'minecraft:the_nether' }).dim, 'nether');
        s.remove('ne-home'); assert.strictEqual(s.get('ow-home').twin, undefined);
    });

    await test('plan: one walk in the same dimension; another dimension = walk to the nearest gate that leads there, cross, walk on; no gate = null', () => {
        const s = gates();
        assert.deepStrictEqual(route.plan(s, { dim: 'overworld', x: 0, z: 0 }, { dim: 'overworld', x: 300, y: 64, z: 10 }), [{ walk: { dim: 'overworld', x: 300, y: 64, z: 10 } }]);
        const p = route.plan(s, { dim: 'overworld', x: 90, y: 64, z: 90 }, { dim: 'nether', x: 40, z: 40 });
        assert.deepStrictEqual(p.map((x) => (x.cross ? `cross ${x.cross}` : `walk ${x.walk.dim}${x.walk.gate ? ' gate' : ''}`)), ['walk overworld gate', 'cross ow-home', 'walk nether']);
        assert.strictEqual(p[0].walk.x, 100, 'the home gate, not the far one');
        assert.strictEqual(route.plan(s, { dim: 'overworld', x: 0, z: 0 }, { dim: 'end', x: 0, z: 0 }), null);
        assert.strictEqual(route.plan(new Sites(), { dim: 'nether', x: 0, z: 0 }, { dim: 'overworld', x: 0, z: 0 }), null);
        const back = route.plan(s, { dim: 'nether', x: 20, z: 20 }, { dim: 'overworld', x: 130, z: 130 });
        assert.deepStrictEqual(back.map((x) => x.cross || x.walk.dim), ['nether', 'ne-home', 'overworld']);
    });

    await test('plan: through the Nether only when asked and clearly shorter (4000 blocks overworld = gates 100 and 4000 away, a short nether walk between)', () => {
        const s = gates();
        const far = route.plan(s, { dim: 'overworld', x: 110, y: 64, z: 110 }, { dim: 'overworld', x: 4040, y: 70, z: 4040 }, { viaNether: true });
        assert.deepStrictEqual(far.map((x) => x.cross || `walk ${x.walk.dim}`), ['walk overworld', 'ow-home', 'walk nether', 'ne-far', 'walk overworld']);
        assert.strictEqual(route.plan(s, { dim: 'overworld', x: 110, z: 110 }, { dim: 'overworld', x: 4040, z: 4040 }).length, 1, 'not asked: the plain walk');
        assert.strictEqual(route.plan(s, { dim: 'overworld', x: 110, z: 110 }, { dim: 'overworld', x: 300, z: 300 }, { viaNether: true }).length, 1, 'a short walk is not shortened by a detour');
    });

    await test('cross: beside the gate, forward until the dimension changes, out of the exit portal; a block that is not a portal, an unreachable gate and a portal that never opens are reported', async () => {
        const mk = (over = {}) => {
            let dim = 'overworld', here = { x: 0, y: 64, z: 0 }; const calls = [];
            const blocks = new Map([['5,64,5', 'nether_portal']]);
            const w = { nameAt: (x, y, z) => blocks.get(`${x},${y},${z}`) || 'air', kindAt: (x, y, z) => (blocks.has(`${x},${y},${z}`) ? 'danger' : y <= 63 ? 'solid' : 'air') };
            const env = { w, here: () => ({ ...here }), dimension: () => dim, exec: async (n, a) => { calls.push([n, a.x, a.y, a.z]); here = { x: a.x, y: a.y, z: a.z }; return { ok: true }; },
                // walking into the gate changes the dimension and leaves the bot in the exit portal; walking toward a free cell leaves a portal
                walkInto: async (cell, o) => { const into = cell.x === 5 && cell.y === 64 && cell.z === 5; calls.push(['walkInto', into ? 'gate' : 'out']); if (into && !over.never) { dim = 'nether'; here = { x: 5, y: 64, z: 5 }; return true; } if (!into) { here = { x: cell.x, y: cell.y, z: cell.z }; return !blocks.has(`${here.x},${here.y},${here.z}`); } return false; }, ...over };
            return { env, calls, get dim() { return dim; } };
        };
        const a = mk(); const r = await cross(a.env, { x: 5, y: 64, z: 5 });
        assert.deepStrictEqual([r.ok, r.from, r.to], [true, 'overworld', 'nether'], JSON.stringify(r)); assert.strictEqual(a.calls[0][0], 'move_to'); assert.deepStrictEqual(a.calls.filter((c) => c[0] === 'walkInto').map((c) => c[1]), ['gate', 'out'], 'in, then out of the exit portal');
        assert.strictEqual(beside(a.env.w, { x: 5, y: 64, z: 5 }, { x: 0, z: 0 }).length, 4);
        // a bot that arrives standing in a portal steps out first, then walks in again
        const e = mk(); e.env.here = (() => { let h = { x: 5, y: 64, z: 5 }; e.env.exec = async (n, q) => { h = { x: q.x, y: q.y, z: q.z }; return { ok: true }; }; const orig = e.env.walkInto; e.env.walkInto = async (c, o) => { const r = await orig(c, o); if (c.x !== 5 || c.z !== 5) h = { x: c.x, y: c.y, z: c.z }; return r; }; return () => ({ ...h }); })();
        const re = await cross(e.env, { x: 5, y: 64, z: 5 }); assert.ok(re.ok, JSON.stringify(re)); assert.strictEqual(e.calls.find((c) => c[0] === 'walkInto')[1], 'out', 'out first');
        const b = mk(); b.env.w.nameAt = () => 'stone'; assert.strictEqual((await cross(b.env, { x: 5, y: 64, z: 5 })).reason, 'invalid_target');
        const c = mk({ never: true }); const rc = await cross(c.env, { x: 5, y: 64, z: 5 }, { ms: 50 }); assert.strictEqual(rc.reason, 'timeout');
        const d = mk({ exec: async () => ({ ok: false, reason: 'unreachable' }) }); d.env.here = () => ({ x: 90, y: 64, z: 90 }); assert.strictEqual((await cross(d.env, { x: 5, y: 64, z: 5 })).reason, 'unreachable');
    });
    console.log('\nwork route: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
