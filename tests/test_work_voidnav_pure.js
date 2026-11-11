// voidnav (src/work/bot/voidnav.js): the planner over walk / bridge / pillar for places with no ground, and its run-by-run executor, on a fake void world whose commands change the world as the real ones do.
const assert = require('assert');
const { plan, runs, walk } = require('../src/work/bot/voidnav');

setTimeout(() => { console.error('test watchdog: still running after 60 s'); process.exit(2); }, 60000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

/** A void with `solid` cells; the commands bridge / pillar / move_to of the fake bot lay blocks and move it like the action layer's. */
function voidWorld(solid = [], { pack = 64 } = {}) {
    const s = new Set(solid.map(([x, y, z]) => `${x},${y},${z}`)), log = [];
    const w = { kindAt: (x, y, z) => (s.has(`${x},${y},${z}`) ? 'solid' : 'air'), nameAt: () => 'end_stone' };
    const pos = { x: 0, y: 0, z: 0 };
    const stand = (x, y, z) => s.has(`${x},${y - 1},${z}`) && !s.has(`${x},${y},${z}`) && !s.has(`${x},${y + 1},${z}`);
    const env = {
        w, here: () => ({ ...pos }), have: () => pack, log, cancel: { cancelled: false },
        exec: async (n, a) => { log.push([n, a.x, a.y, a.z]); if (n !== 'move_to') return { ok: true }; if (!stand(a.x, a.y, a.z)) return { ok: false, reason: 'unreachable' }; Object.assign(pos, { x: a.x, y: a.y, z: a.z }); return { ok: true }; },
        run: async (n, a) => {
            log.push([n, a.y, JSON.stringify(a.cells || a.levels)]);
            if (n === 'bridge') { for (const c of a.cells) { if (!s.has(`${c.x},${a.y - 1},${c.z}`)) s.add(`${c.x},${a.y - 1},${c.z}`); pos.x = c.x; pos.z = c.z; } return { ok: true, detail: {} }; }
            if (n === 'pillar') { for (let i = 0; i < a.levels; i++) { s.add(`${pos.x},${pos.y},${pos.z}`); pos.y++; } return { ok: true, detail: { levels: a.levels } }; }
            return { ok: false, reason: 'invalid_args' };
        },
    };
    return { env, s, pos, w };
}
const plate = (x0, x1, z0, z1, y) => { const o = []; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) o.push([x, y, z]); return o; };

(async () => {
    await test('plan: a station on a floating block 7 levels up and 6 across is reached by bridging out and pillaring up beside it, never by walking down', () => {
        // the platform at y 48 (feet 49), a floating block at (6,55,0) (feet 56)
        const { w } = voidWorld([...plate(-2, 2, -2, 2, 48), [6, 55, 0]]);
        const p = plan(w, { x: 0, y: 49, z: 0 }, { x: 6, y: 56, z: 0 });
        assert.ok(p.ok, JSON.stringify(p));
        assert.ok(p.path.every((c) => c.y >= 49), 'no cell below the start level');
        assert.deepStrictEqual(p.path[p.path.length - 1], { x: 6, y: 56, z: 0, how: p.path[p.path.length - 1].how });
        assert.ok(p.path.filter((c) => c.how === 'pillar').length >= 6, 'climbs by pillar (six levels beside the block, then one step up onto it)');
        assert.ok(p.placed >= 7 && p.placed <= 20, `${p.placed} blocks`);
    });
    await test('plan: walking beats building: a floor all the way is walked (no block laid); a step up and a drop of up to three are walks; a drop of four is not', () => {
        const { w } = voidWorld([...plate(0, 6, 0, 0, -1), ...plate(7, 9, 0, 0, 0), ...plate(10, 12, 0, 0, -3)]);
        const p = plan(w, { x: 0, y: 0, z: 0 }, { x: 12, y: -2, z: 0 });
        assert.ok(p.ok); assert.strictEqual(p.placed, 0); assert.ok(p.path.every((c) => ['walk', 'step', 'drop'].includes(c.how)));
        const { w: w2 } = voidWorld([...plate(0, 3, 0, 0, -1), ...plate(4, 6, 0, 0, -5)]);
        const q = plan(w2, { x: 0, y: 0, z: 0 }, { x: 6, y: -4, z: 0 });
        assert.strictEqual(q.ok, false, 'a drop of four is no walk, and there is no way DOWN by building: it is named, not attempted');
    });
    await test('plan: no way, too few blocks, an unloaded or blocked target are named', () => {
        const { w } = voidWorld(plate(-1, 1, -1, 1, 10));
        assert.strictEqual(plan(w, { x: 0, y: 11, z: 0 }, { x: 0, y: 11, z: 0 }).ok, true, 'already there');
        assert.match(plan(w, { x: 0, y: 11, z: 0 }, { x: 8, y: 11, z: 0 }, { blocks: 3 }).why, /needs \d+ blocks/);
        const solidTarget = voidWorld([...plate(-1, 1, -1, 1, 10), [3, 11, 3]]).w;
        assert.match(plan(solidTarget, { x: 0, y: 11, z: 0 }, { x: 3, y: 11, z: 3 }).why, /not free/);
        const nothing = { kindAt: (x, y, z) => (y === 10 && Math.abs(x) <= 1 && Math.abs(z) <= 1 ? 'solid' : 'air') };
        assert.strictEqual(plan(nothing, { x: 0, y: 11, z: 0 }, { x: 4, y: 11, z: 0 }, { blocks: 0 }).ok, false);
    });
    await test('runs: a bridge run keeps the walks that lie inside it; a climb is one pillar run on one column', () => {
        const path = [{ x: 1, y: 5, z: 0, how: 'bridge' }, { x: 2, y: 5, z: 0, how: 'bridge' }, { x: 3, y: 5, z: 0, how: 'walk' }, { x: 3, y: 6, z: 0, how: 'pillar' }, { x: 3, y: 7, z: 0, how: 'pillar' }, { x: 4, y: 7, z: 0, how: 'walk' }];
        const r = runs(path, { x: 0, y: 5, z: 0 });
        assert.deepStrictEqual(r.map((q) => [q.kind, q.cells.length]), [['bridge', 3], ['pillar', 2], ['walk', 1]]);
    });
    await test('walk: from the platform to a floating block 7 up, executed with bridge and pillar commands, ends exactly on the cell (server-style check of the fake world)', async () => {
        const { env, pos, s } = voidWorld([...plate(-2, 2, -2, 2, 48), [6, 55, 0]]); Object.assign(pos, { x: 0, y: 49, z: 0 });
        const r = await walk(env, { x: 6, y: 56, z: 0 });
        assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.deepStrictEqual([pos.x, pos.y, pos.z], [6, 56, 0]);
        assert.ok(env.log.some((l) => l[0] === 'bridge') && env.log.some((l) => l[0] === 'pillar'), env.log.map((l) => l[0]).join());
        assert.ok(s.has('6,55,0'), 'the floating block is still the floor');
    });
    await test('walk: a run that ends elsewhere is planned again from where the bot stands; fatal reasons end it at once; nothing is attempted without the level', async () => {
        const { env, pos } = voidWorld(plate(-2, 8, -1, 1, 10)); Object.assign(pos, { x: 0, y: 11, z: 0 });
        let n = 0; const exec = env.exec;
        env.exec = async (nm, a) => { if (nm === 'move_to' && n++ === 0) { pos.x = 3; return { ok: false, reason: 'stuck' }; } return exec(nm, a); };
        const r = await walk(env, { x: 8, y: 11, z: 0 });
        assert.strictEqual(r.ok, true, JSON.stringify(r)); assert.ok(r.voidnav.replans >= 1);
        const dead = voidWorld(plate(-2, 8, -1, 1, 10)); Object.assign(dead.pos, { x: 0, y: 11, z: 0 }); dead.env.exec = async () => ({ ok: false, reason: 'died' });
        assert.strictEqual((await walk(dead.env, { x: 8, y: 11, z: 0 })).reason, 'died');
        assert.strictEqual((await walk(env, { x: 8, z: 0 })).reason, 'refused');
        const noway = voidWorld(plate(-1, 1, -1, 1, 10), { pack: 0 }); Object.assign(noway.pos, { x: 0, y: 11, z: 0 });
        const nr = await walk(noway.env, { x: 9, y: 11, z: 0 }); assert.strictEqual(nr.ok, false); assert.strictEqual(nr.reason, 'unreachable'); assert.match(nr.detail.why, /blocks/);
    });
    console.log('\nvoidnav: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
