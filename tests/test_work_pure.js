// The pure-bot work layer (src/work, docs/proposed/WORKERS-v1.md) without a server: the crew ledger (leases, takeover, helpers,
// stuck units), a 100-bot simulation with deaths, the pit job (haul road, water rule) and the build job (blueprint, scaffold) on
// a fake world, and whole jobs run by real workers whose commands are fakes. The live check is scripts/work/*.
const assert = require('assert');
const { Ledger, DONE, STUCK } = require('../src/work/crew');
const pit = require('../src/work/pit');
const build = require('../src/work/build');
const janitor = require('../src/work/janitor');
const { runWorker } = require('../src/work/worker');

setTimeout(() => { console.error('test watchdog: still running after 90 s (a worker loop that does not end?)'); process.exit(2); }, 90000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

/** Fake world: a Map of "x,y,z" -> block name; below `ground` stone, above air. Reads like the skills' world model. */
function fakeWorld(ground = 0, init = {}) {
    const m = new Map(Object.entries(init));
    const key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n), cells: m };
}

(async () => {
    await test('ledger: layers wait for the layer above, helpers take the tail, late results are accepted', () => {
        const L = new Ledger({ leaseMs: 1000 });
        L.addRegion({ id: 'a', anchor: { x: 0, z: 0 }, layers: 2, rows: 4 });
        const a = L.claim('b1', { x: 0, z: 0 }, 0, { batch: 2 });
        assert.deepStrictEqual(a.units.map((u) => u.row), [0, 1]);
        assert.strictEqual(a.role, 'owner');
        const h = L.claim('b2', { x: 0, z: 0 }, 1);
        assert.strictEqual(h.role, 'helper'); assert.deepStrictEqual(h.units.map((u) => u.row), [3], 'the helper starts at the far end');
        const last = L.claim('b3', { x: 0, z: 0 }, 2); assert.deepStrictEqual(last.units.map((u) => u.row), [2]);
        assert.strictEqual(L.claim('b4', { x: 0, z: 0 }, 3), null, 'layer 1 waits while layer 0 has leased units');
        for (const [b, c] of [['b1', a], ['b2', h], ['b3', last]]) for (const u of c.units) L.done(b, 'a', u.unit, 4);
        const next = L.claim('b4', { x: 0, z: 0 }, 5); assert.strictEqual(next.units[0].layer, 1);
        // b1's lease on a layer-1 unit expires, b2 takes it over, then b1's late result arrives: accepted once, b2's is a no-op.
        const mine = L.claim('b1', { x: 0, z: 0 }, 6); const u = mine.units[0].unit;
        const taken = L.claim('b2', { x: 0, z: 0 }, 6 + 5000); // b1 never beat: its lease is gone
        L.done('b1', 'a', u, 6 + 5001); L.done('b2', 'a', u, 6 + 5002);
        assert.strictEqual(L.regions.get('a').state[u], DONE); assert.strictEqual(L.regions.get('a').doneN, 5);
        assert.ok(taken);
    });

    await test('ledger: a failing unit goes to another bot, three failures make it stuck and the layer below does not wait', () => {
        const L = new Ledger({ maxAttempts: 3 });
        L.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 2, rows: 1 });
        for (const b of ['A', 'B', 'C']) L.join(b);
        const c1 = L.claim('A', { x: 0, z: 0 }, 0); L.fail('A', 'r', c1.units[0].unit, 'unreachable', 1);
        assert.strictEqual(L.claim('A', { x: 0, z: 0 }, 2), null, 'the bot that failed is not offered the unit again while others live');
        const c2 = L.claim('B', { x: 0, z: 0 }, 3); L.fail('B', 'r', c2.units[0].unit, 'not_visible', 4);
        const c3 = L.claim('C', { x: 0, z: 0 }, 5); L.fail('C', 'r', c3.units[0].unit, 'stuck', 6, { cell: [1, 2, 3] });
        assert.strictEqual(L.stuck.length, 1); assert.strictEqual(L.stuck[0].reason, 'stuck');
        const below = L.claim('A', { x: 0, z: 0 }, 7); assert.strictEqual(below.units[0].layer, 1, 'stuck counts as settled');
        L.fail('A', 'r', below.units[0].unit, 'cancelled', 7.1);
        // "target chunk not loaded" says where the bot is, not what the unit needs: never counted.
        const far = L.claim('B', { x: 0, z: 0 }, 7.5); L.fail('B', 'r', far.units[0].unit, 'unreachable', 7.6, { why: 'target chunk not loaded' });
        assert.strictEqual(L.regions.get('r').attempts[far.units[0].unit], 0);
        const worn = L.claim('B', { x: 0, z: 0 }, 7.7); L.fail('B', 'r', worn.units[0].unit, 'missing_tool', 7.8, { block: 'stone' });
        assert.strictEqual(L.regions.get('r').attempts[worn.units[0].unit], 0, 'a worn-out pickaxe is the bot\'s problem');
        // A bot's own death is not the unit's fault.
        L.fail('A', 'r', below.units[0].unit, 'died', 8);
        assert.strictEqual(L.regions.get('r').attempts[below.units[0].unit], 0);
        assert.ok(L.claim('B', { x: 0, z: 0 }, 9), 'back in the pool at once');
        L.leave('B', 10);
        const again = L.claim('C', { x: 0, z: 0 }, 11); L.done('C', 'r', again.units[0].unit, 12);
        assert.ok(L.finished());
    });

    await test('100 bots, 100 chunks, 15 bots die for good, 10 die and come back: all work done, helping is never slower', () => {
        const run = (helpers) => {
            const rand = rng(7), L = new Ledger({ leaseMs: 30000, crowd: helpers ? 1e6 : 1e12 });
            for (let cx = 0; cx < 10; cx++) for (let cz = 0; cz < 10; cz++) L.addRegion({ id: `c${cx}_${cz}`, anchor: { x: cx * 16 + 8, z: cz * 16 + 8 }, layers: 6, rows: 16 });
            const N = 100, bots = [];
            // Uneven chunks: some regions take 4x as long per row (hard rock, water), so a static split leaves stragglers.
            const hard = (id) => (id.charCodeAt(1) + id.charCodeAt(3)) % 7 === 0 ? 4 : 1;
            for (let i = 0; i < N; i++) bots.push({ id: `bot${i}`, t: 0, pos: { x: (i % 10) * 16 + 8, z: Math.floor(i / 10) * 16 + 8 }, dead: false, back: null, cur: null });
            const doom = new Map(); for (let i = 0; i < 25; i++) doom.set(`bot${Math.floor(rand() * N)}`, { at: 60 + rand() * 600, forever: i < 15 });
            let wall = 0, claims = 0, safety = 0;
            const t0 = process.hrtime.bigint();
            const queue = bots.map((b) => ({ at: 0, bot: b }));
            while (queue.length && safety++ < 2e6) {
                queue.sort((a, b) => a.at - b.at || a.bot.id.localeCompare(b.bot.id));
                const ev = queue.shift(), b = ev.bot, now = ev.at; wall = Math.max(wall, now);
                const d = doom.get(b.id);
                if (d && !b.dead && now >= d.at) {      // dies mid-unit: no report, the lease just stops being renewed
                    b.dead = true; doom.delete(b.id);
                    if (d.forever) continue;
                    queue.push({ at: now + 45, bot: b }); b.back = true; continue;
                }
                if (b.cur) { L.done(b.id, b.cur.region, b.cur.u.unit, now * 1000); b.cur = null; }
                if (b.dead && b.back) { b.dead = false; b.back = null; }
                L.heartbeat(b.id, now * 1000);
                const c = L.claim(b.id, b.pos, now * 1000); claims++;
                if (!c) { if (!L.finished()) queue.push({ at: now + 5, bot: b }); continue; }
                const r = L.regions.get(c.region), walk = Math.hypot(r.anchor.x - b.pos.x, r.anchor.z - b.pos.z) / 4;
                b.pos = { x: r.anchor.x, z: r.anchor.z };
                b.cur = { region: c.region, u: c.units[0] };
                queue.push({ at: now + walk + (6 + rand() * 4) * hard(c.region), bot: b });
            }
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            return { L, wall, claims, ms };
        };
        const withHelp = run(true), noHelp = run(false);
        for (const r of [withHelp, noHelp]) {
            const p = r.L.progress();
            assert.ok(p.finished, `unfinished: ${JSON.stringify(p)}`); assert.strictEqual(p.done, p.total); assert.strictEqual(p.stuck, 0);
        }
        console.log(`    helpers: ${withHelp.wall.toFixed(0)} s, no helpers: ${noHelp.wall.toFixed(0)} s (units 9600, 85 bots survive); ${withHelp.claims} claims in ${withHelp.ms.toFixed(0)} ms`);
        assert.ok(withHelp.wall <= noHelp.wall + 1e-9, 'helping never makes it slower');
        assert.ok(withHelp.ms / withHelp.claims < 2, 'a claim costs well under 2 ms with 100 regions');
    });

    await test('pit: chunk regions, the haul road, row order, and a box that is too deep for its edge', () => {
        const p = pit.planPit({ x0: -5, z0: 3, x1: 40, z1: 20, top: 70, bottom: 63 });
        assert.deepStrictEqual(p.regions.map((r) => r.id).sort(), ['c-1_0', 'c-1_1', 'c0_0', 'c0_1', 'c1_0', 'c1_1', 'c2_0', 'c2_1']);
        assert.strictEqual(p.layers, 8);
        assert.strictEqual(p.road.cells.length, 8);
        assert.deepStrictEqual(p.road.cells.slice(0, 3), [{ x: -5, z: 3, keepTo: 70 }, { x: -4, z: 3, keepTo: 69 }, { x: -3, z: 3, keepTo: 68 }]);
        const reg = p.regions.find((r) => r.id === 'c-1_0');
        const row0 = pit.unitCells(p, reg, 0 * reg.rows + 0), row1 = pit.unitCells(p, reg, 1 * reg.rows + 1);
        assert.strictEqual(row0[0].y, 70); assert.strictEqual(row0.length, 5 - 1, 'region c-1_0 is x -5..-1; the first road cell (x -5) is never dug');
        assert.strictEqual(row1.length, 5); assert.strictEqual(row1[0].x > row1[row1.length - 1].x, true, 'odd rows walk back');
        assert.strictEqual(pit.unitCells(p, reg, 2 * reg.rows).length, 2, 'at layer 2 (y 68) the road keeps x -5..-3');
        assert.strictEqual(pit.unitCells(p, reg, 7 * reg.rows).length, 0, 'at layer 7 the road keeps all 5 cells of this row');
        assert.throws(() => pit.planPit({ x0: 0, z0: 0, x1: 2, z1: 2, top: 70, bottom: 50 }), /haul road/);
        assert.throws(() => pit.planPit({ x0: 0, z0: 0, x1: 2, z1: 2, top: 1, bottom: 5 }), /empty/);
    });

    await test('water rule: fluid beside or inside the cells is filled from the solid side first; an open lake is reported', () => {
        const w = fakeWorld(69, { '5,70,4': 'water', '5,70,5': 'water', '5,70,6': 'water' });     // a 3-cell stream on the ground, next to x=4
        const sp = pit.sealPlan(w, [{ x: 4, y: 70, z: 5 }]);
        assert.strictEqual(sp.unsupported.length, 0); assert.ok(sp.fill.some((c) => c.x === 5 && c.z === 5), 'the neighbour east is sealed');
        // The middle cell has only water and the filled cells beside it as neighbours on its row: it is filled after one of them.
        assert.ok(sp.fill.findIndex((c) => c.z === 5) >= 0);
        const lake = fakeWorld(-100, { '1,70,0': 'water', '1,69,0': 'water', '1,68,0': 'water', '1,70,1': 'water' });
        for (let y = 60; y < 70; y++) for (const z of [0, 1]) lake.set(1, y, z, 'water');
        const sl = pit.sealPlan(lake, [{ x: 0, y: 70, z: 0 }]);
        assert.ok(sl.unsupported.length > 0 && sl.fill.length === 0, 'water with no solid face anywhere cannot be sealed');
    });

    await test('pit unit on a fake world: mines the row, seals the stream before opening, is idempotent, reports a missing seal block', async () => {
        const w = fakeWorld(60, { '9,64,2': 'water' });                       // water in the layer-0 neighbour cell outside the box
        for (let x = 0; x <= 8; x++) for (let z = 0; z <= 3; z++) for (let y = 61; y <= 64; y++) w.set(x, y, z, 'stone');   // solid ground 61..64
        const box = { x0: 0, z0: 0, x1: 8, z1: 3, top: 64, bottom: 63 };
        const job = pit.createPitJob(box), reg = job.plan.regions[0];
        const inv = { cobblestone: 2 }, calls = [];
        const env = {
            w, have: (i) => inv[i] || 0,
            exec: async (name, a) => {
                calls.push([name, a.x, a.y, a.z]);
                if (name === 'mine') { if (w.nameAt(a.x, a.y, a.z) === 'air') return { ok: false, reason: 'invalid_target' }; w.set(a.x, a.y, a.z, 'air'); inv.cobblestone++; return { ok: true }; }
                if (name === 'place') { if (!inv[a.item]) return { ok: false, reason: 'missing_item' }; w.set(a.x, a.y, a.z, a.item); inv[a.item]--; return { ok: true }; }
                throw new Error(name);
            },
        };
        const row2 = 2;       // z=2: its east neighbour (9,64,2) is the stream
        const r1 = await job.runUnit(reg.id, { unit: row2, layer: 0, row: 2 }, env);
        assert.ok(r1.ok, JSON.stringify(r1));
        assert.strictEqual(w.nameAt(9, 64, 2), 'cobblestone', 'the stream cell is sealed');
        const firstMine = calls.findIndex((c) => c[0] === 'mine' && c[1] === 8), seal = calls.findIndex((c) => c[0] === 'place');
        assert.ok(seal >= 0 && seal < firstMine, 'sealed before the last cell next to it was opened');
        for (let x = 0; x <= 8; x++) assert.strictEqual(w.nameAt(x, 64, 2), 'air');
        const n = calls.length; const r2 = await job.runUnit(reg.id, { unit: row2, layer: 0, row: 2 }, env);
        assert.ok(r2.ok && r2.detail.mined === 0 && calls.length === n, 'second run does nothing');
        // No seal block at all.
        const w2 = fakeWorld(60, { '9,64,0': 'water' }); w2.set(8, 64, 0, 'stone'); w2.set(7, 64, 0, 'stone');
        const job2 = pit.createPitJob({ x0: 0, z0: 0, x1: 8, z1: 0, top: 64, bottom: 64 });
        const bad = await job2.runUnit(job2.plan.regions[0].id, { unit: 0 }, { w: w2, have: () => 0, exec: async (n, a) => { if (n === 'mine') w2.set(a.x, a.y, a.z, 'air'); return { ok: true }; } });
        assert.strictEqual(bad.ok, false); assert.strictEqual(bad.reason, 'missing_item');
    });

    await test('water in a pocket sealed inside the wall: not touched before the dig, filled through the opened cell, the cell dug again', async () => {
        // Live run p4: ring water in stone next to the last cell of a row. Before the dig it cannot be clicked (no open face);
        // the dig opens the cell, water flows in, the pocket is filled first, then the plug in the cell is dug out again.
        const w = fakeWorld(60);
        for (let x = 0; x <= 3; x++) for (let y = 61; y <= 64; y++) w.set(x, y, 0, 'stone');
        for (const [x, y, z] of [[4, 65, 0], [5, 64, 0], [4, 64, 1], [4, 64, -1]]) w.set(x, y, z, 'stone');     // the pocket in the ring is enclosed
        for (let y = 61; y <= 64; y++) w.set(4, y, 0, y === 64 ? 'water' : 'stone');
        const calls = [], inv = { cobblestone: 5 };
        const env = { w, have: (i) => inv[i] || 0, exec: async (name, a) => {
            calls.push(`${name}:${a.x},${a.y},${a.z}`);
            if (name === 'mine') { w.set(a.x, a.y, a.z, 'air'); if (a.x === 3 && a.y === 64 && w.nameAt(4, 64, 0) === 'water') w.set(3, 64, 0, 'water'); return { ok: true }; }   // the dug cell floods
            if (name === 'place') { w.set(a.x, a.y, a.z, a.item); inv[a.item]--; return { ok: true }; }
            throw new Error(name);
        } };
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 3, z1: 0, top: 64, bottom: 64 });
        const res = await job.runUnit(job.plan.regions[0].id, { unit: 0 }, env);
        assert.ok(res.ok, JSON.stringify(res));
        const firstPlace = calls.findIndex((c) => c.startsWith('place')), lastMine = calls.map((c) => c.startsWith('mine:3,64,0')).lastIndexOf(true);
        assert.ok(!calls.slice(0, calls.indexOf('mine:3,64,0')).some((c) => c.startsWith('place')), 'nothing placed before the cell is open');
        assert.strictEqual(calls[firstPlace], 'place:4,64,0', 'the pocket first');
        assert.ok(calls.indexOf('place:3,64,0') > firstPlace && lastMine > calls.indexOf('place:3,64,0'), 'then the cell, then it is dug again');
        assert.strictEqual(w.nameAt(4, 64, 0), 'cobblestone'); assert.strictEqual(w.nameAt(3, 64, 0), 'air');
    });

    await test('whole pit by 6 workers on a fake world; one worker dies in the middle; the rest finish, nothing is left standing but the road', async () => {
        const w = fakeWorld(40);
        const X = 40, Z = 20, box = { x0: 0, z0: 0, x1: X - 1, z1: Z - 1, top: 45, bottom: 42 };
        for (let x = -1; x <= X; x++) for (let z = -1; z <= Z; z++) for (let y = 41; y <= 45; y++) w.set(x, y, z, 'stone');
        const job = pit.createPitJob(box, { leaseMs: 60000 });
        const rand = rng(3);
        let killed = false, minesBy = {};
        const workers = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => {
            const env = {
                w, now: Date.now, have: () => 64, here: () => ({ x: 0, y: 46, z: 0 }), pos: () => ({ x: rand() * X, z: rand() * Z }), inv: () => ({ items: [], slotsFree: 30 }),
                exec: async (name, a) => {
                    await new Promise((r) => setImmediate(r));
                    if (id === 'w3' && !killed && (minesBy[id] || 0) > 30) { killed = true; return { ok: false, reason: 'died', detail: {} }; }
                    if (name === 'mine') { minesBy[id] = (minesBy[id] || 0) + 1; w.set(a.x, a.y, a.z, 'air'); return { ok: true }; }
                    return { ok: true };
                },
            };
            return runWorker(job, id, env, { pollMs: 1 });
        });
        const res = await Promise.all(workers);
        assert.ok(killed, 'the scenario killed a worker'); assert.ok(res.some((r) => r.ended === 'died'));
        assert.ok(job.ledger.finished(), JSON.stringify(job.ledger.progress()));
        const road = job.plan.road.keep;
        for (let x = 0; x < X; x++) for (let z = 0; z < Z; z++) for (let y = 42; y <= 45; y++) {
            const keep = road.get(`${x},${z}`);
            const want = keep !== undefined && y <= keep ? 'stone' : 'air';
            assert.strictEqual(w.nameAt(x, y, z), want, `${x},${y},${z}`);
        }
        const doneBy = Object.values(minesBy).filter((n) => n > 0).length;
        assert.ok(doneBy >= 5, 'work was shared');
    });

    await test('janitor: junk goes first, tools and food stay, a depot gets the valuable surplus, nothing valuable is thrown away', () => {
        const pol = janitor.pitPolicy();
        const items = [{ name: 'cobblestone', count: 640 }, { name: 'dirt', count: 192 }, { name: 'iron_pickaxe', count: 1 }, { name: 'diamond', count: 5 }, { name: 'raw_iron', count: 130 }, { name: 'gravel', count: 300 }, { name: 'bread', count: 10 }];
        // 640 cobble = 10 stacks, dirt 3, pick 1, diamond 1, raw iron 3, gravel 5, bread 1 = 24 used of 36
        const ops = janitor.plan(items, 12, pol);
        assert.deepStrictEqual(ops.filter((o) => o.why === 'surplus').map((o) => [o.item, o.count]), [['cobblestone', 576], ['dirt', 160]]);
        assert.ok(!ops.some((o) => ['iron_pickaxe', 'diamond', 'bread', 'raw_iron'].includes(o.item)), 'valuables are untouched without a depot');
        const full = janitor.plan([{ name: 'diamond', count: 64 }, { name: 'raw_iron', count: 640 }, { name: 'gravel', count: 640 }, { name: 'apple', count: 5 }], 0, pol);
        assert.ok(full.every((o) => o.op === 'toss') && full[0].item === 'gravel');
        assert.ok(!full.some((o) => o.item === 'raw_iron' || o.item === 'diamond'));
        const withDepot = janitor.plan([{ name: 'diamond', count: 64 }, { name: 'raw_iron', count: 640 }, { name: 'gravel', count: 128 }], 0, janitor.pitPolicy({ depot: { kind: 'chest', x: 0, y: 64, z: 0 } }));
        assert.ok(withDepot.every((o) => o.op === 'deposit') && withDepot[0].item === 'gravel');
        assert.ok(withDepot.some((o) => o.item === 'raw_iron'), 'with a depot the iron is stored when room is needed');
        assert.deepStrictEqual(janitor.restock([{ name: 'cobblestone', count: 3 }], janitor.pitPolicy({ depot: { kind: 'chest', x: 0, y: 0, z: 0 } })), [{ item: 'cobblestone', count: 13 }]);
        assert.deepStrictEqual(janitor.plan([{ name: 'gravel', count: 64 }], 30, pol), [], 'plenty of room: nothing to do');
    });

    await test('build: a house blueprint, tiles, unit order, scaffold height, idempotent run, repair diff', async () => {
        const cells = build.house({ w: 7, d: 7, h: 4 });
        assert.strictEqual(cells.length, 49 + 4 * 24 + 49);
        const job = build.createBuildJob(cells, { x: 100, y: 64, z: 200 });
        assert.strictEqual(job.plan.layers, 6); assert.deepStrictEqual(job.plan.unsupported, []);
        const w = fakeWorld(63);
        const placed = [], inv = { cobblestone: 99, oak_planks: 99, glass: 99, oak_door: 2 };
        const env = {
            w, have: (i) => inv[i] || 0, here: () => ({ x: 99, y: 64, z: 200 }), pos: () => ({ x: 100, z: 200 }), inv: () => ({ items: [], slotsFree: 30 }),
            exec: async (name, a) => {
                if (name === 'place') {
                    if (a.y > 64 + 3 && !w.cells.has(`${a.x - 1},${a.y - 1},${a.z}`) && a.item !== 'cobblestone' && a.y >= 68 && !env.up) return { ok: false, reason: 'unreachable' };
                    w.set(a.x, a.y, a.z, a.item); placed.push([a.x, a.y, a.z, a.item]); return { ok: true };
                }
                if (name === 'move_to') { env.up = true; return { ok: true }; }
                if (name === 'mine') { w.set(a.x, a.y, a.z, 'air'); return { ok: true }; }
                throw new Error(name);
            },
        };
        const res = await runWorker(job, 'b', env, { pollMs: 1 });
        assert.strictEqual(res.ended, 'finished');
        assert.deepStrictEqual(job.diff(w), [], 'every cell of the blueprint is in the world');
        assert.ok(placed.findIndex((p) => p[1] === 65) > placed.findIndex((p) => p[1] === 64), 'bottom-up');
        const doorAt = placed.findIndex((p) => p[3] === 'oak_door'), lastWall = placed.map((p) => p[1] === 65 && p[3] === 'oak_planks').lastIndexOf(true);
        assert.ok(doorAt > lastWall - 100, 'attached blocks are placed after the structure of their layer');
        assert.ok(placed.some((p) => p[3] === 'cobblestone' && p[1] > 64 && !job.plan.footprint.has(`${p[0]},${p[2]}`)), 'the roof needed a scaffold');
        assert.ok(![...w.cells].some(([k, n]) => { const [x, y, z] = k.split(',').map(Number); return n === 'cobblestone' && !job.plan.footprint.has(`${x},${z}`); }), 'scaffold blocks removed again');
        w.set(103, 66, 200, 'air'); w.set(100, 64, 205, 'air');
        assert.strictEqual(job.diff(w).length, 2, 'a hole in the wall and one in the floor are the repair list');
    });

    await test('build: a failed walk to the placement face (stuck, goal reach placement face) also gets a scaffold; other stuck reasons do not', async () => {
        const run = async (detail) => {
            const job = build.createBuildJob(build.house({ w: 7, d: 7, h: 4 }), { x: 100, y: 64, z: 200 });
            const w = fakeWorld(63), inv = { cobblestone: 99, oak_planks: 99, glass: 99, oak_door: 2 }, placed = [];
            const env = {
                w, have: (i) => inv[i] || 0, here: () => ({ x: 99, y: 64, z: 200 }), pos: () => ({ x: 100, z: 200 }), inv: () => ({ items: [], slotsFree: 30 }),
                exec: async (name, a) => {
                    if (name === 'place') {
                        if (a.y >= 68 && a.item !== 'cobblestone' && !env.up) return { ok: false, reason: 'stuck', detail };
                        w.set(a.x, a.y, a.z, a.item); placed.push(a); return { ok: true };
                    }
                    if (name === 'move_to') { env.up = true; return { ok: true }; }
                    if (name === 'mine') { w.set(a.x, a.y, a.z, 'air'); return { ok: true }; }
                    throw new Error(name);
                },
            };
            return { res: await runWorker(job, 'b', env, { pollMs: 1 }), job, w, placed };
        };
        const good = await run({ goal: 'reach placement face', why: 'end of partial path' });
        assert.strictEqual(good.res.ended, 'finished'); assert.deepStrictEqual(good.job.diff(good.w), []);
        assert.ok(good.placed.some((p) => p.item === 'cobblestone' && p.y > 64 && !good.job.plan.footprint.has(`${p.x},${p.z}`)), 'scaffold built');
        const bad = await run({ goal: 'somewhere else' });
        assert.notStrictEqual(bad.res.ended, 'finished'); assert.ok(!bad.placed.some((p) => p.item === 'cobblestone' && !bad.job.plan.footprint.has(`${p.x},${p.z}`)), 'no scaffold for the bot\'s own trouble');
    });

    await test('scaffold: a stair outside the footprint, column j is K-j high, placed outer column first; none when in reach; null when boxed in', () => {
        const cells = build.house({ w: 7, d: 7, h: 4 }), plan = build.planBuild(cells, { x: 100, y: 64, z: 200 }), w = fakeWorld(63);
        assert.deepStrictEqual(build.scaffoldFor(plan, w, { x: 103, y: 65, z: 203 }, 64), { top: null, cells: [] }, 'wall base needs nothing');
        const roof = { x: 103, y: 69, z: 203 };
        const sc = build.scaffoldFor(plan, w, roof, 64);
        assert.ok(sc && sc.top.y === 68, JSON.stringify(sc && sc.top));
        const K = 4, cols = {}; for (const c of sc.cells) cols[c.j] = (cols[c.j] || 0) + 1;
        assert.deepStrictEqual(cols, { 0: 4, 1: 3, 2: 2, 3: 1 });
        assert.ok(sc.cells.every((c) => c.temp && !plan.footprint.has(`${c.x},${c.z}`)), 'never inside the footprint');
        assert.strictEqual(sc.cells[0].j, K - 1, 'outer column first');
        for (let i = 1; i < sc.cells.length; i++) if (sc.cells[i].j === sc.cells[i - 1].j) assert.ok(sc.cells[i].y > sc.cells[i - 1].y, 'bottom up inside a column');
        assert.strictEqual(build.scaffoldFor(plan, w, { x: 103, y: 80, z: 203 }, 64), null, 'too high for a stair');
    });

    await test('structure .nbt (the game format) round-trips into cells; air and structure_void are skipped; mod blocks are reported', async () => {
        const nbt = require('prismarine-nbt');
        const tag = nbt.comp({
            size: nbt.list(nbt.int([3, 2, 1])),
            palette: nbt.list(nbt.comp([{ Name: nbt.string('minecraft:stone') }, { Name: nbt.string('minecraft:air') }, { Name: nbt.string('create:cogwheel') }])),
            blocks: nbt.list(nbt.comp([
                { pos: nbt.list(nbt.int([0, 0, 0])), state: nbt.int(0) }, { pos: nbt.list(nbt.int([1, 0, 0])), state: nbt.int(1) },
                { pos: nbt.list(nbt.int([2, 1, 0])), state: nbt.int(2) },
            ])),
            DataVersion: nbt.int(3465),
        }, '');
        const buf = require('zlib').gzipSync(nbt.writeUncompressed(tag));
        const cells = await build.fromStructureNbt(buf);
        assert.deepStrictEqual(cells.map((c) => c.block), ['stone', 'create:cogwheel']);
        const plan = build.planBuild(cells, { x: 0, y: 70, z: 0 });
        assert.deepStrictEqual(plan.unsupported, []); assert.strictEqual(plan.count, 2);           // mod blocks are placed by namespaced name
        const lim = build.planBuild(cells, { x: 0, y: 70, z: 0 }, { known: (n) => !n.startsWith('create:') });      // a registry without that mod
        assert.deepStrictEqual(lim.unsupported, ['create:cogwheel']); assert.strictEqual(lim.count, 1);
        assert.throws(() => build.planBuild([{ x: 0, y: 0, z: 0, block: 'create:cogwheel' }], { x: 0, y: 70, z: 0 }, { known: () => false }), /nothing the bots can place/);
    });

    console.log('\nwork layer: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
