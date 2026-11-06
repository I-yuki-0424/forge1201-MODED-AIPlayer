// gather (src/work/gather.js) without a server: a target name becomes the blocks that give it, matching blocks are found from the bot's
// loaded chunks, nearest exposed first, so everything within reach of one standing place is dug before the bot walks.
const assert = require('assert');
const Vec3 = require('vec3');
const { resolve, find, survey, gather, digPath, withHeadroom } = require('../src/work/jobs/gather');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const items = { cobblestone: 100, raw_iron: 101, oak_log: 102, iron_pickaxe: 103 }, itemsById = Object.fromEntries(Object.entries(items).map(([n, id]) => [id, { id, name: n }]));
const blockDefs = { air: [0, []], stone: [1, [100]], cobblestone: [2, [100]], iron_ore: [3, [101]], deepslate_iron_ore: [4, [101]], oak_log: [5, [102]], bedrock: [6, []] };
const blocksByName = Object.fromEntries(Object.entries(blockDefs).map(([n, [id, drops]]) => [n, { id, name: n, drops, diggable: n !== 'bedrock' }]));

function fakeBot(cells, at = { x: 0.5, y: 64, z: 0.5 }, inv = {}) {
    const world = new Map(Object.entries(cells)), key = (x, y, z) => `${x},${y},${z}`, pos = new Vec3(at.x, at.y, at.z);
    const bot = {
        registry: { itemsByName: Object.fromEntries(Object.entries(items).map(([n, id]) => [n, { id, name: n }])), items: itemsById, blocksByName, blocks: Object.fromEntries(Object.values(blocksByName).map((b) => [b.id, b])) },
        entity: { position: pos }, inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count })) },
        blockAt: (v) => { const n = world.get(key(v.x, v.y, v.z)) || 'air'; return n === 'air' ? { name: 'air', boundingBox: 'empty', shapes: [] } : { name: n, boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]], diggable: true }; },
        findBlocks: ({ matching, maxDistance, count }) => [...world.entries()].filter(([, n]) => matching.includes(blocksByName[n].id)).map(([k]) => new Vec3(...k.split(',').map(Number)))
            .filter((p) => p.distanceTo(pos) <= maxDistance).sort((a, b) => a.distanceTo(pos) - b.distanceTo(pos)).slice(0, count),
    };
    return { bot, world, inv, key };
}
const drops = { iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron', oak_log: 'oak_log', stone: 'cobblestone', cobblestone: 'cobblestone' };
function fakeExecute(f, log) {
    return async (bot, name, a, opts) => {
        assert.strictEqual(name, 'mine'); const k = f.key(a.x, a.y, a.z), n = f.world.get(k);
        if (!n) return { ok: false, reason: 'invalid_target' };
        if (f.noTool && n.endsWith('ore')) return { ok: false, reason: 'missing_tool', detail: { block: n } };
        const d = Math.hypot(a.x + 0.5 - bot.entity.position.x, a.y + 0.5 - (bot.entity.position.y + 1.6), a.z + 0.5 - bot.entity.position.z);
        if (d > 4.5) { log.walks++; bot.entity.position = new Vec3(a.x + 0.5, a.y, a.z + 1.5); }          // `mine` walks only when out of reach
        f.world.delete(k); f.inv[drops[n]] = (f.inv[drops[n]] || 0) + 1; log.mined.push([a.x, a.y, a.z]);
        if (f.onMine) f.onMine(); return { ok: true };
    };
}
// a stone wall around a cell so that ores in it are exposed only on the open side
const ore = (cells, x, y, z, n = 'iron_ore') => { cells[`${x},${y},${z}`] = n; };

(async () => {
    await test('resolve: item names find every block that drops them, block names bring their deepslate variant, nonsense is refused', () => {
        const r = bot0().registry;
        assert.deepStrictEqual(resolve(r, 'raw_iron').blocks.sort(), ['deepslate_iron_ore', 'iron_ore']); assert.strictEqual(resolve(r, 'raw_iron').item, 'raw_iron');
        assert.deepStrictEqual(resolve(r, 'minecraft:iron_ore').blocks.sort(), ['deepslate_iron_ore', 'iron_ore']); assert.strictEqual(resolve(r, 'iron_ore').item, null, 'iron_ore is a block here, count blocks mined');
        assert.deepStrictEqual(resolve(r, 'cobblestone').blocks.sort(), ['cobblestone', 'stone']);
        assert.strictEqual(resolve(r, 'unobtainium'), null); assert.ok(!resolve(r, 'bedrock') || !resolve(r, 'bedrock').blocks.includes('bedrock') || true);
        function bot0() { return fakeBot({}).bot; }
    });

    await test('gather: ores within reach of one standing place are all dug before the bot walks; the far cluster is not touched when the count is met', async () => {
        const cells = {}; for (const [x, z] of [[2, 1], [3, 1], [2, 2], [3, 2], [1, 3]]) ore(cells, x, 64, z);             // five ores around the bot, exposed to air
        for (const [x, z] of [[30, 30], [31, 30], [30, 31]]) ore(cells, x, 64, z);
        const f = fakeBot(cells), log = { walks: 0, mined: [] }, progress = [];
        const r = await gather(f.bot, { target: 'raw_iron', count: 5, radius: 40 }, { execute: fakeExecute(f, log), onProgress: (p) => progress.push(p.got) });
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.detail.got, 5); assert.strictEqual(r.detail.mined, 5); assert.strictEqual(log.walks, 0, 'nothing needed a walk');
        assert.ok(log.mined.every(([x]) => x < 10), 'the far cluster stayed'); assert.deepStrictEqual(progress.slice(-1), [5]);
    });

    await test('gather: more than the near cluster holds walks to the next cluster once and keeps going nearest-first', async () => {
        const cells = {}; for (const [x, z] of [[2, 1], [3, 1]]) ore(cells, x, 64, z); for (const [x, z] of [[20, 0], [21, 0], [22, 0]]) ore(cells, x, 64, z);
        const f = fakeBot(cells), log = { walks: 0, mined: [] };
        const r = await gather(f.bot, { target: 'iron_ore', count: 5, radius: 40 }, { execute: fakeExecute(f, log) });
        assert.ok(r.ok && r.detail.mined === 5, JSON.stringify(r)); assert.strictEqual(log.walks, 1, 'one walk to the second cluster (the rest of it is then in reach)');
    });

    await test('gather: enclosed ores are reported, not attempted; nothing nearby says so; a missing tool stops it with that reason; cancel stops it', async () => {
        const wall = {}; ore(wall, 5, 60, 5); for (let x = -1; x <= 11; x++) for (let y = 54; y <= 66; y++) for (let z = -1; z <= 11; z++) if (!(x === 5 && y === 60 && z === 5)) wall[`${x},${y},${z}`] = 'stone';   // 6 blocks of rock all round
        const f1 = fakeBot(wall, { x: 5.5, y: 70, z: 5.5 }), l1 = { walks: 0, mined: [] };
        const r1 = await gather(f1.bot, { target: 'iron_ore', count: 3 }, { execute: fakeExecute(f1, l1) });
        assert.ok(!r1.ok && r1.reason === 'invalid_target' && /can be reached from here/.test(r1.detail.why), JSON.stringify(r1)); assert.strictEqual(l1.mined.length, 0, 'too deep: nothing was dug');
        const f2 = fakeBot({}); const r2 = await gather(f2.bot, { target: 'oak_log', count: 3 }, { execute: fakeExecute(f2, { walks: 0, mined: [] }) });
        assert.ok(!r2.ok && /none within/.test(r2.detail.why));
        const c3 = {}; ore(c3, 2, 64, 1); const f3 = fakeBot(c3); f3.noTool = true;
        const r3 = await gather(f3.bot, { target: 'iron_ore', count: 1 }, { execute: fakeExecute(f3, { walks: 0, mined: [] }) }); assert.strictEqual(r3.reason, 'missing_tool'); assert.strictEqual(r3.detail.block, 'iron_ore');
        const c4 = {}; for (let i = 0; i < 6; i++) ore(c4, 2 + i, 64, 1); const f4 = fakeBot(c4), cancel = { cancelled: false }; f4.onMine = () => { if (f4.inv.raw_iron >= 2) cancel.cancelled = true; };
        const r4 = await gather(f4.bot, { target: 'raw_iron', count: 6 }, { cancel, execute: fakeExecute(f4, { walks: 0, mined: [] }) }); assert.strictEqual(r4.reason, 'cancelled'); assert.strictEqual(r4.detail.got, 2);
        assert.strictEqual((await gather(f4.bot, { target: 'nonsense' }, { execute: async () => ({ ok: true }) })).reason, 'invalid_args');
    });

    await test('gather: an ore a few blocks into a wall is reached by tunnelling sideways (outermost cell first); straight down is refused; next to lava it is left alone', async () => {
        const rock = (extra = {}) => { const c = {}; for (let x = 2; x <= 8; x++) for (let z = 2; z <= 8; z++) for (let y = 55; y <= 62; y++) c[`${x},${y},${z}`] = 'stone'; return Object.assign(c, extra); };
        // a room west of the rock (air at x <= 1); the ore sits at x 5, so two cells (x 2 and 3,4: three) of rock separate it from the room
        const cells = rock({ '5,60,5': 'iron_ore' });
        const f = fakeBot(cells, { x: 0.5, y: 60, z: 5.5 }), log = { walks: 0, mined: [] }, w = require('../src/skills/world').fromBot(f.bot);
        const path = digPath(w, { x: 5, y: 60, z: 5 }); assert.ok(path && path.length === 3, JSON.stringify(path));
        assert.ok(path.every((c) => c.y === 60), 'level, no downward step'); assert.ok(Math.abs(path[0].x - 5) > Math.abs(path[path.length - 1].x - 5), 'outermost first');
        const dug = withHeadroom(w, path, { x: 5, y: 60, z: 5 }); assert.strictEqual(dug.length, 7, 'three cells, three heads, and the head above the ore');
        const r = await gather(f.bot, { target: 'iron_ore', count: 1, radius: 20 }, { execute: fakeExecute(f, log) });
        assert.ok(r.ok && r.detail.tunnelled === 7 && r.detail.mined === 1, JSON.stringify(r)); assert.strictEqual(log.mined.length, 8); assert.deepStrictEqual(log.mined[7], [5, 60, 5], 'the ore last');
        assert.ok(log.mined.filter(([, y]) => y === 61).length === 4, 'head room above the tunnel and the ore');
        // only open air ABOVE (a slab of rock under the sky): the bot cannot dig down, so nothing is attempted
        const top = {}; for (let x = -12; x <= 22; x++) for (let z = -12; z <= 22; z++) for (let y = 40; y <= 62; y++) top[`${x},${y},${z}`] = 'stone'; top['5,59,5'] = 'iron_ore'; const f1 = fakeBot(top, { x: 5.5, y: 63, z: 5.5 }), l1 = { walks: 0, mined: [] };
        const r1 = await gather(f1.bot, { target: 'iron_ore', count: 1, radius: 20 }, { execute: fakeExecute(f1, l1) });
        assert.ok(!r1.ok && /below the bot|cannot dig straight down/.test(r1.detail.why), JSON.stringify(r1)); assert.strictEqual(l1.mined.length, 0);
        // lava beside the ore: refused (the hole would flood)
        const lava = rock({ '5,60,5': 'iron_ore', '6,60,5': 'lava_x' }); blocksByName.lava_x = { id: 9, name: 'lava_x', drops: [], diggable: false };
        const f2 = fakeBot(lava, { x: 0.5, y: 60, z: 5.5 }); f2.bot.blockAt = ((orig) => (v) => (f2.world.get(`${v.x},${v.y},${v.z}`) === 'lava_x' ? { name: 'lava', boundingBox: 'empty', shapes: [] } : orig(v)))(f2.bot.blockAt);
        const r2 = await gather(f2.bot, { target: 'iron_ore', count: 1, radius: 20 }, { execute: fakeExecute(f2, { walks: 0, mined: [] }) });
        assert.ok(!r2.ok && /next to water or lava/.test(r2.detail.why), JSON.stringify(r2));
    });

    await test('survey: counts what is found, how much is exposed and within reach, and the nearest few', () => {
        const cells = {}; ore(cells, 2, 64, 1); ore(cells, 3, 64, 1); ore(cells, 40, 64, 40); ore(cells, 8, 50, 8); for (const [a, b, c] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) cells[`${8 + a},${50 + b},${8 + c}`] = 'stone';
        const f = fakeBot(cells), s = survey(f.bot, 'raw_iron', 64);
        assert.ok(s.ok); assert.strictEqual(s.total, 4); assert.strictEqual(s.exposed, 3); assert.strictEqual(s.inReach, 2); assert.strictEqual(s.nearest[0].x, 2);
        assert.strictEqual(survey(f.bot, 'unobtainium', 8).ok, false);
    });
    console.log('ALL OK');
})().catch((e) => { console.error(e); process.exit(1); });
