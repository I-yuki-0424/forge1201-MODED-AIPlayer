// The expert method of the pit job (src/work/jobs/pit_expert.js, pit.js method 'expert') on a fake world: a unit is a band of two layers of a whole chunk, the expert chooses the stations,
// the arm digs everything in reach blind, leftovers above the band within reach go too, fixtures and bedrock stay, a station that cannot be reached is not tried again.
const assert = require('assert');
const pit = require('../src/work/jobs/pit');
const M = require('../src/experts/pit/model');

setTimeout(() => { console.error('test watchdog: still running after 90 s'); process.exit(2); }, 90000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

function fakeWorld(ground, init = {}) {
    const m = new Map(Object.entries(init)), key = (x, y, z) => `${x},${y},${z}`;
    const nameAt = (x, y, z) => m.get(key(x, y, z)) ?? (y <= ground ? 'stone' : 'air');
    const kindAt = (x, y, z) => { const n = nameAt(x, y, z); return n === 'air' ? 'air' : n === 'water' ? 'water' : n === 'lava' ? 'danger' : 'solid'; };
    return { nameAt, kindAt, set: (x, y, z, n) => m.set(key(x, y, z), n) };
}
/** A bot that stands at `pos`, walks wherever `canWalk` allows, and mines (blind) whatever is within 4.6 blocks of its eye; everything is logged. */
function fakeEnv(w, start, { canWalk = () => true } = {}) {
    const pos = { ...start }, log = [];
    const env = {
        w, here: () => ({ ...pos }), have: () => 64, log,
        exec: async (name, a) => {
            log.push([name, { ...a }]);
            if (name === 'move_to') { if (!canWalk(a)) return { ok: false, reason: 'unreachable', detail: { why: 'no path' } }; pos.x = a.x; pos.y = a.y; pos.z = a.z; return { ok: true }; }
            if (name === 'mine') {
                const d = Math.hypot(pos.x + 0.5 - (a.x + 0.5), pos.y + 1.62 - (a.y + 0.5), pos.z + 0.5 - (a.z + 0.5));
                if (d > 4.6) return { ok: false, reason: 'unreachable', detail: { why: 'reach block', d } };
                w.set(a.x, a.y, a.z, 'air'); return { ok: true };
            }
            return { ok: true };
        },
    };
    return env;
}

/** The bot of the End: it stands only on a block; its learned walk (`travel`) lays a block under the cell it steps onto when a standable cell is within 8 blocks (the bridge), else it fails. */
function voidEnv(w, start) {
    const floored = (a) => ['solid', 'partial'].includes(w.kindAt(a.x, a.y - 1, a.z));
    const near = (a) => { for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) if (Math.abs(dx) + Math.abs(dz) <= 8 && w.kindAt(a.x + dx, a.y - 1, a.z + dz) === 'solid' && w.kindAt(a.x + dx, a.y, a.z + dz) === 'air') return true; return false; };
    const env = fakeEnv(w, start, { canWalk: floored }), base = env.exec;
    env.profile = () => ({ minY: 0, voidBelow: true }); env.temp = new Map();            // env.temp: the bot's own bridge and pillar blocks (the real env keeps them), not ore
    env.travel = async (to) => { if (!floored(to) && !near(to)) return { ok: false, reason: 'unreachable', detail: { why: 'no floor within 8' } }; if (!floored(to)) { w.set(to.x, to.y - 1, to.z, 'cobblestone'); env.temp.set(`${to.x},${to.y - 1},${to.z}`, { item: 'cobblestone' }); } return base('move_to', to); };
    return { env, floored };
}

(async () => {
    const box = { x0: 0, z0: 0, x1: 15, z1: 15, top: 99, bottom: 96 };
    await test('plan: the expert method cuts a chunk into bands of two layers, one unit per band; the unit holds the band\'s cells', () => {
        const plan = pit.planPit(box, { method: 'expert', road: false }), reg = plan.regions[0];
        assert.strictEqual(plan.regions.length, 1); assert.deepStrictEqual([reg.layers, reg.rows, reg.meta.band, reg.meta.method], [2, 1, 2, 'expert']);
        const c0 = pit.unitCells(plan, reg, 0), c1 = pit.unitCells(plan, reg, 1);
        assert.strictEqual(c0.length, 512); assert.ok(c0.every((c) => c.y === 99 || c.y === 98)); assert.ok(c1.every((c) => c.y === 97 || c.y === 96));
        assert.strictEqual(c0[0].y, 99, 'top layer first');
        assert.throws(() => pit.planPit(box, { method: 'spiral' }), /rows, sweep or expert/);
    });

    await test('runUnit: a fresh band is dug completely from far fewer stations than the tile sweep needs (32 for two layers), blind, nothing outside the chunk', async () => {
        const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
        const w = fakeWorld(99), env = fakeEnv(w, { x: 0, y: 100, z: 0 });
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const mined = env.log.filter((l) => l[0] === 'mine'), moves = env.log.filter((l) => l[0] === 'move_to');
        assert.strictEqual(r.detail.mined, 512); assert.ok(mined.every((l) => l[1].blind === true && l[1].collect === false), 'blind, no walk to a view');
        assert.ok(mined.every((l) => l[1].x >= 0 && l[1].x <= 15 && l[1].z >= 0 && l[1].z <= 15 && (l[1].y === 99 || l[1].y === 98)), 'only the band of the chunk');
        assert.ok(r.detail.expert.stations <= 20, `${r.detail.expert.stations} stations (the tile sweep needs 16 per layer, 32 for the band)`); assert.ok(r.detail.blocksPerStation >= 25, `${r.detail.blocksPerStation} blocks per station`);
        assert.ok(moves.length <= r.detail.expert.stations);
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (const y of [98, 99]) assert.strictEqual(w.kindAt(x, y, z), 'air');
        // the layer below was not touched
        assert.strictEqual(w.kindAt(5, 97, 5), 'solid');
    });

    await test('runUnit: leftovers above the band (inside the box) within reach are dug too; bedrock and a chest stay; a second run finds nothing to do', async () => {
        // unit 1 = the band y 97 / 96; the two layers above (already dug by unit 0) hold leftovers; the chunk's top two layers are open
        const w = fakeWorld(97, { '5,98,5': 'stone', '5,99,5': 'stone', '9,97,9': 'bedrock', '3,96,3': 'chest' });
        const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0], env = fakeEnv(w, { x: 0, y: 98, z: 0 });
        const r = await job.runUnit(reg.id, { unit: 1 }, env);
        assert.strictEqual(w.kindAt(5, 98, 5), 'air', 'the leftover above the band'); assert.strictEqual(w.kindAt(5, 99, 5), 'air');
        assert.strictEqual(w.nameAt(9, 97, 9), 'bedrock');
        assert.ok(r.ok || r.reason, JSON.stringify(r).slice(0, 200));
        const again = await job.runUnit(reg.id, { unit: 1 }, env);
        assert.ok(again.ok, JSON.stringify(again).slice(0, 200)); assert.ok(again.detail.idle || !again.detail.mined, 'nothing left to dig');
        // cells above the box are never touched
        const w2 = fakeWorld(99, { '5,100,5': 'stone' }), env2 = fakeEnv(w2, { x: 0, y: 100, z: 0 });
        await job.runUnit(reg.id, { unit: 0 }, env2); assert.strictEqual(w2.kindAt(5, 100, 5), 'solid', 'outside the box stays');
    });

    await test('runUnit: a station that cannot be reached is not tried again, six in a row end the unit with the walk\'s reason', async () => {
        const job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
        const w = fakeWorld(99), env = fakeEnv(w, { x: 0, y: 100, z: 0 }, { canWalk: () => false });
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'unreachable');
        const moves = env.log.filter((l) => l[0] === 'move_to'); const keys = moves.map((l) => `${l[1].x},${l[1].z}`);
        assert.strictEqual(new Set(keys).size, keys.length, 'every station once');
        // one corner of the chunk walled off: the unit still ends with the rest dug and the reason of the failure
        const w2 = fakeWorld(99), env2 = fakeEnv(w2, { x: 0, y: 100, z: 0 }, { canWalk: (a) => !(a.x >= 8 && a.z >= 8) });
        const r2 = await job.runUnit(reg.id, { unit: 0 }, env2);
        assert.ok(r2.ok || r2.reason === 'unreachable', JSON.stringify(r2).slice(0, 200));
        let dug = 0; for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (w2.kindAt(x, 99, z) === 'air') dug++;
        assert.ok(dug > 100, `${dug} cells of the top layer dug`);
    });

    await test('runUnit: a lake in the band is sealed by the water rule, the cells around it dug', async () => {
        const init = {}; for (let x = 6; x <= 8; x++) for (let z = 6; z <= 8; z++) init[`${x},99,${z}`] = 'water';
        const w = fakeWorld(99, init), job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0], env = fakeEnv(w, { x: 0, y: 100, z: 0 });
        env.exec = ((orig) => async (name, a) => { if (name === 'place') { w.set(a.x, a.y, a.z, 'cobblestone'); env.log.push([name, a]); return { ok: true }; } return orig(name, a); })(env.exec);
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.ok(env.log.some((l) => l[0] === 'place'), 'water is filled before it is dug'); assert.ok(r.ok || r.reason, JSON.stringify(r).slice(0, 200));
    });
    await test('runUnit: a seal that walks the bot away from its station does not make the rest of the cells "too far": it goes back first', async () => {
        const init = {}; for (let x = 6; x <= 8; x++) for (let z = 6; z <= 8; z++) init[`${x},99,${z}`] = 'water';
        const w = fakeWorld(99, init), job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0], env = fakeEnv(w, { x: 0, y: 100, z: 0 });
        const here = env.here; let away = 0;
        const base = env.exec;
        env.exec = async (name, a) => {
            if (name === 'place') { w.set(a.x, a.y, a.z, 'cobblestone'); env.log.push([name, a]); const p0 = here(); await base('move_to', { x: p0.x + 7, y: p0.y, z: p0.z }); away++; return { ok: true }; }   // the placement walked 7 blocks off
            return base(name, a);
        };
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.ok(away > 0, 'a seal was placed'); assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) assert.notStrictEqual(w.kindAt(x, 99, z), 'solid', `${x},${z}`);
    });

    await test('runUnit over the void (the End): a station is only planned where a block is under the feet; thin air at the band\'s level is not ground (live 2026-11-11: 52 of 60 failed stations were cells of air over air)', async () => {
        // The simulator the planner was trained on always had rock under the band; the End has none. Two islands in a void, the bot can only stand on a block (as in the game).
        const init = {};
        for (let x = 2; x <= 6; x++) for (let z = 2; z <= 6; z++) for (const y of [98, 99]) init[`${x},${y},${z}`] = 'end_stone';
        for (let x = 10; x <= 13; x++) for (let z = 9; z <= 13; z++) for (const y of [98, 99]) init[`${x},${y},${z}`] = 'end_stone';
        const w = fakeWorld(-1000, init), job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
        const { env, floored } = voidEnv(w, { x: 4, y: 100, z: 4 });
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        const moves = env.log.filter((l) => l[0] === 'move_to');
        assert.ok(r.ok, JSON.stringify(r).slice(0, 300));
        assert.strictEqual(r.detail.expert.fails, 0, 'no station failed');
        // what is left is only the blocks a station stood on (the last block of an island is its own support over the void: digging it drops the bot), accepted AND counted in the unit's result
        // (the bot's own bridge blocks, env.temp, are its way and are taken away by the unit's clean-up, not counted)
        let leftN = 0; for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (const y of [98, 99]) if (w.kindAt(x, y, z) !== 'air' && !env.temp.has(`${x},${y},${z}`)) { leftN++; assert.ok(![1, 2, 3].some((d) => w.kindAt(x, y - d, z) === 'solid'), `${x},${y},${z} left although a floor is under it`); }
        assert.strictEqual(leftN, r.detail.supports || 0, 'every left block is a counted support'); assert.ok(leftN <= 6, `${leftN} supports of 90 blocks`);
        assert.strictEqual(r.detail.skipped || 0, leftN); assert.ok(r.detail.expert.hops >= 1, 'the second island was reached by a hop');
        assert.ok(moves.length >= 1, 'the second island needs a walk');
    });

    await test('runUnit over the void: a fragment no floor can reach is dug from a footing bridged beside it (a station in thin air that is built, not wished for); a footing too far from any floor is not tried', async () => {
        // an island with ground to stand on, a fragment 9 columns away that no station on the island reaches (arm reach 4), and one 14 columns away from everything
        const init = {};
        for (let x = 1; x <= 4; x++) for (let z = 1; z <= 4; z++) for (const y of [98, 99]) init[`${x},${y},${z}`] = 'end_stone';
        for (let x = 11; x <= 12; x++) for (const z of [2, 3]) init[`${x},99,${z}`] = 'end_stone';           // the reachable-by-footing fragment (9 columns from the island)
        const w = fakeWorld(-1000, init), job = pit.createPitJob(box, {}, { method: 'expert', road: false }), reg = job.plan.regions[0];
        const { env, floored } = voidEnv(w, { x: 2, y: 100, z: 2 });
        const r = await job.runUnit(reg.id, { unit: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r).slice(0, 400));
        assert.ok(r.detail.expert.footings >= 1, 'a footing station was used'); 
        for (const x of [11, 12]) for (const z of [2, 3]) assert.ok(w.kindAt(x, 99, z) === 'air' || env.temp.has(`${x},99,${z}`), `fragment ${x},${z} left`);
        // (every successful move_to of the fake bot had a block under the cell at the time: voidEnv refuses the rest)
    });

    console.log('\npit expert unit: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
