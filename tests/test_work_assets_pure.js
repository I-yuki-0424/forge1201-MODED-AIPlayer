// The inventory's pictures (owner list 5 Small 3, TASK-20261125-077): the client jar reader (zip), what is extracted from it, item models as icon specs, names, the
// asset store and its routes (session, closed paths, same origin), the 1.21 item components, and the page's drawing maths (GUI view of a block, the game's durability bar).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const zip = require('../src/work/web/assets/zip');
const models = require('../src/work/web/assets/models');
const { AssetStore, extract } = require('../src/work/web/assets/store');
const Icons = require('../public/work/icons');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ok ${name}`); }

/** A zip in memory: [{ name, data, deflate? }]. */
function makeZip(files) {
    const locals = [], cens = []; let off = 0;
    for (const f of files) {
        const data = Buffer.from(f.data), comp = f.deflate ? zlib.deflateRawSync(data) : data, name = Buffer.from(f.name);
        const loc = Buffer.alloc(30); loc.writeUInt32LE(0x04034b50, 0); loc.writeUInt16LE(f.deflate ? 8 : 0, 8); loc.writeUInt32LE(comp.length, 18); loc.writeUInt32LE(data.length, 22); loc.writeUInt16LE(name.length, 26);
        const cen = Buffer.alloc(46); cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(f.deflate ? 8 : 0, 10); cen.writeUInt32LE(comp.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(off, 42);
        locals.push(loc, name, comp); cens.push(cen, name); off += 30 + name.length + comp.length;
    }
    const cd = Buffer.concat(cens), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
    return Buffer.concat([...locals, cd, end]);
}

const MODELS = {
    'block/block': { display: {} },
    'block/cube': { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { down: { texture: '#down' }, up: { texture: '#up' }, north: { texture: '#north' }, south: { texture: '#south' }, west: { texture: '#west' }, east: { texture: '#east' } } }] },
    'block/cube_all': { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' } },
    'block/smooth_stone': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/smooth_stone' } },
    'item/smooth_stone': { parent: 'minecraft:block/smooth_stone' },
    'block/slab': { parent: 'block/block', elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { down: { uv: [0, 0, 16, 16], texture: '#bottom' }, up: { uv: [0, 0, 16, 16], texture: '#top' }, north: { uv: [0, 8, 16, 16], texture: '#side' }, south: { uv: [0, 8, 16, 16], texture: '#side' }, west: { uv: [0, 8, 16, 16], texture: '#side' }, east: { uv: [0, 8, 16, 16], texture: '#side' } } }] },
    'block/smooth_stone_slab': { parent: 'minecraft:block/slab', textures: { bottom: 'minecraft:block/smooth_stone', top: 'minecraft:block/smooth_stone', side: 'minecraft:block/smooth_stone_slab_side' } },
    'item/smooth_stone_slab': { parent: 'minecraft:block/smooth_stone_slab' },
    'item/generated': { parent: 'builtin/generated' },
    'item/handheld': { parent: 'item/generated' },
    'item/diamond_pickaxe': { parent: 'minecraft:item/handheld', textures: { layer0: 'minecraft:item/diamond_pickaxe' } },
    'item/leather_boots': { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/leather_boots', layer1: 'minecraft:item/leather_boots_overlay' } },
    'item/template_chest': { parent: 'builtin/entity' },
    'item/chest': { parent: 'minecraft:item/template_chest', textures: { particle: 'minecraft:block/oak_planks' } },
    'block/cube_bottom_top': { parent: 'block/cube', textures: { particle: '#side', down: '#bottom', up: '#top', north: '#side', east: '#side', south: '#side', west: '#side' } },
    'block/grass_block': { parent: 'block/block', textures: { top: 'block/grass_block_top', side: 'block/grass_block_side' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#top', tintindex: 0 }, north: { texture: '#side' } } }] },
    'item/grass_block': { parent: 'minecraft:block/grass_block' },
};
const readModel = (n) => MODELS[n] || null;

(async () => {
    await test('zip: entries and their bytes, stored and deflated; a file that is not a zip is refused', () => {
        const z = makeZip([{ name: 'a/b.txt', data: 'hello' }, { name: 'c.json', data: JSON.stringify({ x: 'y'.repeat(500) }), deflate: true }]);
        const es = zip.entries(z); assert.deepStrictEqual(es.map((e) => e.name), ['a/b.txt', 'c.json']);
        assert.strictEqual(zip.read(z, es[0]).toString(), 'hello'); assert.strictEqual(JSON.parse(zip.read(z, es[1])).x.length, 500);
        assert.throws(() => zip.entries(Buffer.from('not a zip at all, nothing here')), /no end of central directory/);
        assert.throws(() => zip.read(z, { ...es[1], size: 10 * 1024 * 1024 }), /larger than/);
    });

    await test('extract: only block/item models and textures and the English names; anything else (classes, other languages, a path with ..) stays in the jar', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wasset-'));
        const jar = makeZip([{ name: 'assets/minecraft/models/block/stone.json', data: '{}' }, { name: 'assets/minecraft/textures/item/diamond.png', data: 'PNG' }, { name: 'assets/minecraft/lang/en_us.json', data: '{}', deflate: true },
            { name: 'assets/minecraft/lang/de_de.json', data: '{}' }, { name: 'net/minecraft/Main.class', data: 'x' }, { name: 'assets/minecraft/textures/block/../../../../evil.png', data: 'x' }, { name: 'assets/minecraft/textures/entity/chest/normal.png', data: 'x' }]);
        assert.strictEqual(extract(jar, dir), 3);
        assert.ok(fs.existsSync(path.join(dir, 'models/block/stone.json')) && fs.existsSync(path.join(dir, 'textures/item/diamond.png')) && fs.existsSync(path.join(dir, 'lang/en_us.json')));
        assert.ok(!fs.existsSync(path.join(dir, 'lang/de_de.json')) && !fs.existsSync(path.join(dir, '..', 'evil.png')));
    });

    await test('models: a slab and its block are different pictures (half height, the slab side); tools are flat layers; leather is tinted; a chest is its material; a mod item has none', () => {
        const slab = models.itemSpec('minecraft:smooth_stone_slab', readModel), block = models.itemSpec('minecraft:smooth_stone', readModel);
        assert.strictEqual(slab.kind, 'block'); assert.deepStrictEqual(slab.elements[0].to, [16, 8, 16]); assert.strictEqual(slab.elements[0].faces.north.tex, 'block/smooth_stone_slab_side');
        assert.strictEqual(block.kind, 'block'); assert.deepStrictEqual(block.elements[0].to, [16, 16, 16]); assert.strictEqual(block.elements[0].faces.up.tex, 'block/smooth_stone');
        assert.deepStrictEqual(models.itemSpec('minecraft:diamond_pickaxe', readModel), { kind: 'flat', layers: [{ tex: 'item/diamond_pickaxe', tint: null }] });
        assert.deepStrictEqual(models.itemSpec('minecraft:leather_boots', readModel).layers.map((l) => l.tint), [0xa06540, null]);
        const chest = models.itemSpec('minecraft:chest', readModel); assert.ok(chest.approx && chest.elements[0].faces.up.tex === 'block/oak_planks');
        assert.strictEqual(models.itemSpec('minecraft:grass_block', readModel).elements[0].faces.up.tint, 0x91bd59, 'the grass top is tinted, the side is not');
        assert.strictEqual(models.itemSpec('minecraft:grass_block', readModel).elements[0].faces.north.tint, null);
        assert.strictEqual(models.tintOf('minecraft:water_bucket', 0), null, 'a water bucket is its own texture, not tinted blue');
        assert.deepStrictEqual(models.itemSpec('create:cogwheel', readModel), { kind: 'none' }); assert.deepStrictEqual(models.itemSpec('../../etc', readModel), { kind: 'none' });
        assert.strictEqual(models.nameOf('minecraft:smooth_stone_slab', { 'block.minecraft.smooth_stone_slab': 'Smooth Stone Slab' }), 'Smooth Stone Slab');
        assert.strictEqual(models.nameOf('minecraft:diamond_pickaxe', { 'item.minecraft.diamond_pickaxe': 'Diamond Pickaxe', 'block.minecraft.diamond_pickaxe': 'x' }), 'Diamond Pickaxe');
    });

    await test('icons maths: the GUI view shows the top and two sides; a slab sits lower than its block; the durability bar is the game\'s (13 px, HSV), only when damaged', () => {
        const c = Icons.project([8, 8, 8]); assert.ok(Math.abs(c[0] - 8) < 1e-9 && Math.abs(c[1] - 8) < 1e-9);
        const shown = ['up', 'down', 'north', 'south', 'east', 'west'].filter((d) => Icons.facesViewer(d));
        assert.deepStrictEqual(shown.sort(), ['east', 'north', 'up'], 'rotation 30 about X after 225 about Y: the top, east on the left, north on the right');
        assert.ok(Icons.project([16, 8, 8])[0] < 8 && Icons.project([8, 8, 0])[0] > 8, 'east to the left, north to the right');
        const cube = Icons.blockFaces(models.itemSpec('minecraft:smooth_stone', readModel)), slab = Icons.blockFaces(models.itemSpec('minecraft:smooth_stone_slab', readModel));
        assert.strictEqual(cube.length, 3); assert.strictEqual(cube[cube.length - 1].dir === 'up' || cube.some((f) => f.dir === 'up'), true);
        const top = (fs) => fs.find((f) => f.dir === 'up').pts[0][1]; assert.ok(top(slab) > top(cube) + 2, 'the slab\'s top is lower on screen');
        assert.deepStrictEqual(slab.find((f) => f.dir === 'north').uv, [0, 8, 16, 16], 'the slab side uses the lower half of its texture');
        assert.strictEqual(Icons.durability(0, 250), null, 'a new tool has no bar'); assert.strictEqual(Icons.durability(5, 0), null);
        assert.deepStrictEqual(Icons.durability(1, 250), { width: 13, rgb: Icons.hsvToRgb((1 - 1 / 250) / 3, 1, 1) });
        assert.strictEqual(Icons.durability(125, 250).width, 7, 'round(13 - 6.5) = 7, as Math.round in the game');
        assert.deepStrictEqual(Icons.durability(250, 250), { width: 0, rgb: 0xff0000 });
        assert.strictEqual(Icons.hsvToRgb(1 / 3, 1, 1), 0x00ff00); assert.strictEqual(Icons.hsvToRgb(1 / 6, 1, 1), 0xffff00);
    });

    await test('1.21 stacks: damage, name and enchantments come from the item components; 1.20 tags still work', async () => {
        const inv = require('../src/work/operator/inventory');
        const run = async (c) => (c.includes('Inventory') ? 'Bot1 has the following entity data: [{count: 1, Slot: 0b, id: "minecraft:iron_pickaxe", components: {"minecraft:damage": 12, "minecraft:enchantments": {levels: {"minecraft:efficiency": 3}}, "minecraft:custom_name": \'"Digger"\'}}, {count: 64, Slot: 1b, id: "minecraft:smooth_stone_slab"}, {Count: 1b, Slot: 2b, id: "minecraft:iron_axe", tag: {Damage: 4}}]' : '');
        const r = await inv.read(run, { type: 'entity', name: 'Bot1' });
        assert.deepStrictEqual([r.slots[0].damage, r.slots[0].label, r.slots[0].enchanted], [12, 'Digger', true]);
        assert.deepStrictEqual([r.slots[1].count, r.slots[1].damage, r.slots[1].enchanted], [64, null, false]); assert.strictEqual(r.slots[2].damage, 4);
    });

    await test('store and routes: the session is needed; ready after the fetch; icons with names; textures only from the closed set of paths, as PNG, same origin', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wassets-')); let fetched = 0;
        const fetch = async (v, r) => { fetched++; const d = path.join(r, v); for (const [k, m] of Object.entries(MODELS)) { fs.mkdirSync(path.dirname(path.join(d, 'models', `${k}.json`)), { recursive: true }); fs.writeFileSync(path.join(d, 'models', `${k}.json`), JSON.stringify(m)); } fs.mkdirSync(path.join(d, 'textures/block'), { recursive: true }); fs.writeFileSync(path.join(d, 'textures/block/smooth_stone.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); fs.mkdirSync(path.join(d, 'lang'), { recursive: true }); fs.writeFileSync(path.join(d, 'lang/en_us.json'), JSON.stringify({ 'block.minecraft.smooth_stone_slab': 'Smooth Stone Slab' })); fs.writeFileSync(path.join(d, 'ready'), '{}'); return d; };
        const store = new AssetStore({ root, version: () => '1.21.1', fetch });
        const { WorkService } = require('../src/work/service'), { createConsole } = require('../src/work/web/server');
        const svc = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wassvc-')), factory: () => { throw new Error('no bots'); }, envFactory: () => ({}), display: false });
        const { server } = createConsole({ service: svc, assets: store }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
        const call = (u, cookie) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: u, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b) })); }).on('error', reject); });
        try {
            assert.strictEqual((await call('/api/assets/status')).status, 401, 'no session, no assets');
            const s = await call('/api/session'), cookie = String(s.headers['set-cookie']).split(';')[0];
            const st = JSON.parse((await call('/api/assets/status', cookie)).body); assert.strictEqual(st.version, '1.21.1');
            for (let i = 0; i < 50 && !store.status().ready; i++) await new Promise((r) => setTimeout(r, 10));
            const ic = JSON.parse((await call('/api/assets/icons?ids=minecraft:smooth_stone_slab,minecraft:diamond_pickaxe', cookie)).body);
            assert.strictEqual(ic.ready, true); assert.strictEqual(ic.icons['minecraft:smooth_stone_slab'].name, 'Smooth Stone Slab'); assert.strictEqual(ic.icons['minecraft:smooth_stone_slab'].kind, 'block'); assert.strictEqual(fetched, 1);
            const png = await call('/api/assets/tex/block/smooth_stone.png', cookie);
            assert.strictEqual(png.status, 200); assert.strictEqual(png.headers['content-type'], 'image/png'); assert.match(png.headers['content-security-policy'], /img-src 'self'/); assert.strictEqual(png.headers['x-content-type-options'], 'nosniff');
            for (const bad of ['/api/assets/tex/block/../../ready.png', '/api/assets/tex/entity/chest.png', '/api/assets/tex/block/missing.png']) assert.ok([404].includes((await call(bad, cookie)).status), bad);
            assert.strictEqual((await call('/api/assets/icons?ids=../../x', cookie)).status, 400);
            assert.strictEqual((await call(`/api/assets/icons?ids=${Array.from({ length: 129 }, (_, i) => `minecraft:a${i}`).join(',')}`, cookie)).status, 400);
        } finally { server.close(); await svc.stop(); }
        const none = new AssetStore({ root, version: () => null }); assert.deepStrictEqual(none.status(), { version: null, ready: false, fetching: false, error: null }, 'no version known yet: nothing fetched');
        assert.strictEqual(new AssetStore({ root, version: () => '1.21.1; rm -rf' }).version(), null, 'a version is a release number');
    });

    console.log(`test_work_assets_pure: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
