// Site purposes (one per block, closed list, pulldown) and Ender Storage data: colours, frequency keys, the world's data files, the service view.
// Pure: a world folder is written to a temp dir in the format the mod uses (gzip NBT, keys "left=..,middle=..,right=..[,owner=..],type=item").
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');
const es = require('../src/work/world/enderstorage');
const { Sites, PURPOSES, classify } = require('../src/work/bot/sites');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const throws = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('did not throw'); };

/** What the mod writes: { key: { size, Items: [{Slot, id, Count, tag?}] } } as gzip NBT. */
function dataFile(file, content) {
    const items = (l) => ({ type: 'list', value: { type: 'compound', value: l.map((it, i) => ({ Slot: { type: 'byte', value: i }, id: { type: 'string', value: it.id }, Count: { type: 'byte', value: it.n } })) } });
    const root = { type: 'compound', name: '', value: Object.fromEntries(Object.entries(content).map(([k, v]) => [k, { type: 'compound', value: { size: { type: 'byte', value: 1 }, Items: items(v) } }])) };
    fs.writeFileSync(file, zlib.gzipSync(nbt.writeUncompressed(root, 'big')));
}

(async () => {
    await test('purposes: a closed list, old names still work, one purpose per block', () => {
        assert.deepStrictEqual(Object.keys(PURPOSES), ['tools', 'ore', 'trash', 'food', 'blocks', 'any', 'free', 'furnace', 'other']);
        const s = new Sites();
        assert.strictEqual(s.add({ name: 'a', x: 1, y: 1, z: 1, purpose: 'trash' }).purpose, 'trash');
        const old = s.add({ name: 'b', x: 2, y: 1, z: 1, tags: ['junk'] });
        assert.deepStrictEqual([old.purpose, old.tags], ['trash', ['trash']], 'junk is trash');
        assert.strictEqual(s.add({ name: 'c', x: 3, y: 1, z: 1, tags: ['storage'] }).purpose, 'any');
        assert.strictEqual(s.add({ name: 'd', x: 4, y: 1, z: 1, tags: ['machine'], via: 'c' }).purpose, 'furnace');
        throws(() => s.add({ name: 'e', x: 5, y: 1, z: 1, purpose: 'wood' }), /unknown purpose/);
        throws(() => s.add({ name: 'e', x: 5, y: 1, z: 1, tags: ['ore', 'any'] }), /choose one purpose/);
        throws(() => s.add({ name: 'e', x: 5, y: 1, z: 1 }), /choose a purpose/);
        assert.strictEqual(s.add({ name: 'e', x: 5, y: 1, z: 1, label: 'the big tree' }).purpose, 'other');
        assert.strictEqual(s.find('junk').name, 'a', 'find answers to the old name'); assert.strictEqual(s.find('storage').name, 'c');
    });

    await test('purposes: a stored list from before is migrated (the most specific tag wins, and it is reported); nothing is lost', () => {
        const s = new Sites([{ name: 'm', x: 0, y: 0, z: 0, tags: ['storage', 'ore'] }, { name: 't', x: 1, y: 0, z: 0, tags: ['tools', 'storage'] }, { name: 'f', x: 2, y: 0, z: 0, tags: ['machine', 'ore'], via: 'm' }]);
        assert.deepStrictEqual(s.list().map((x) => `${x.name}:${x.purpose}`), ['f:furnace', 'm:ore', 't:tools']);
        assert.deepStrictEqual(s.migrated.map((x) => x.name).sort(), ['f', 'm', 't']);
        assert.strictEqual(s.get('f').via, 'm');
    });

    await test('purposes: the upkeep fills ore, trash, food, blocks and any; never tools, free, furnace or other', () => {
        const s = new Sites([{ name: 'tc', x: 0, y: 0, z: 0, purpose: 'tools' }, { name: 'fr', x: 1, y: 0, z: 0, purpose: 'free' }, { name: 'ot', x: 2, y: 0, z: 0, purpose: 'other' }, { name: 'fu', x: 3, y: 0, z: 0, purpose: 'furnace' }]);
        assert.strictEqual(s.placeFor('diamond'), null, 'nothing takes items');
        s.add({ name: 'any1', x: 9, y: 0, z: 0, purpose: 'any' });
        assert.strictEqual(s.placeFor('diamond').name, 'any1'); assert.strictEqual(s.placeFor('dirt').name, 'any1', 'trash falls back to any');
        s.add({ name: 'tr', x: 8, y: 0, z: 0, purpose: 'trash' });
        assert.strictEqual(s.placeFor('dirt').name, 'tr'); assert.strictEqual(classify('dirt'), 'trash'); assert.strictEqual(classify('oak_log'), 'any'); assert.strictEqual(classify('diamond'), 'ore');
        assert.strictEqual(s.placeFor('iron_pickaxe').name, 'any1', 'a tool is never put into a tools chest');
    });

    await test('colours: names, aliases and wool indices; a frequency has three of them; private ones carry the owner; keys round-trip', () => {
        assert.strictEqual(es.COLOURS.length, 16);
        assert.deepStrictEqual(['Light Blue', 'lightBlue', 'light_blue', 3].map(es.colour), ['light_blue', 'light_blue', 'light_blue', 'light_blue']);
        assert.strictEqual(es.colour('silver'), 'light_gray'); throws(() => es.colour('teal'), /one of white/); throws(() => es.colour(16), /one of/);
        const f = es.frequency({ left: 'blue', middle: 'white', right: 'white' });
        assert.strictEqual(es.keyOf(f), 'left=blue,middle=white,right=white,type=item');
        assert.deepStrictEqual(es.parseKey(es.keyOf(f)), { ...f, type: 'item' });
        const o = es.frequency({ left: 'red', middle: 'red', right: 'black', owner: '734C8E10-0000-4000-8000-000000000001' });
        assert.strictEqual(es.keyOf(o), 'left=red,middle=red,right=black,owner=734c8e10-0000-4000-8000-000000000001,type=item');
        assert.strictEqual(es.parseKey(es.keyOf(o)).owner, o.owner); assert.strictEqual(es.label(o), 'red / red / black (private)');
        throws(() => es.frequency({ left: 'red', middle: 'red', right: 'black', owner: 'steve' }), /UUID/); throws(() => es.frequency({ left: 'red' }), /colour/);
        assert.strictEqual(es.parseKey('garbage'), null);
        assert.ok(es.isMod('enderstorage:ender_chest') && !es.isMod('minecraft:ender_chest') && es.isVanillaEnderChest('minecraft:ender_chest'));
    });

    await test('world data: the newer file wins, an unreadable one falls back to the other, items are summed; no folder = null', async () => {
        const w = fs.mkdtempSync(path.join(os.tmpdir(), 'ender-')); fs.mkdirSync(path.join(w, 'EnderStorage'));
        const f1 = path.join(w, 'EnderStorage', 'data1.dat'), f2 = path.join(w, 'EnderStorage', 'data2.dat');
        assert.deepStrictEqual(await es.readStore(w), { file: null, mtimeMs: 0, frequencies: [] }); assert.strictEqual(await es.readStore(null), null);
        dataFile(f1, { 'left=blue,middle=white,right=white,type=item': [{ id: 'minecraft:diamond_pickaxe', n: 1 }, { id: 'minecraft:diamond_pickaxe', n: 1 }, { id: 'minecraft:air', n: 0 }] });
        fs.utimesSync(f1, new Date(Date.now() - 60000), new Date(Date.now() - 60000));
        dataFile(f2, { 'left=blue,middle=white,right=white,type=item': [{ id: 'minecraft:diamond_pickaxe', n: 1 }], 'left=white,middle=white,right=white,type=item': [], 'left=x,middle=white,right=white,type=item': [], 'left=red,middle=red,right=red,type=tank': [] });
        let st = await es.readStore(w);
        assert.strictEqual(path.basename(st.file), 'data2.dat'); assert.strictEqual(st.frequencies.length, 3, 'a bad key is skipped, a tank key is kept with its type');
        const blue = st.frequencies.find((q) => q.left === 'blue'); assert.deepStrictEqual([blue.size, blue.used, blue.items], [27, 1, [{ item: 'minecraft:diamond_pickaxe', count: 1 }]]);
        fs.writeFileSync(f2, Buffer.from('not nbt'));                                          // half written: the other file
        st = await es.readStore(w); assert.strictEqual(path.basename(st.file), 'data1.dat');
        assert.deepStrictEqual(st.frequencies[0].items, [{ item: 'minecraft:diamond_pickaxe', count: 2 }]); assert.strictEqual(st.frequencies[0].used, 2);
        fs.rmSync(w, { recursive: true });
    });

    await test('service: sites hold the colours; the Ender Storage view joins the world data with the tagged chests and what each is for', async () => {
        const w = fs.mkdtempSync(path.join(os.tmpdir(), 'ender-')), d = fs.mkdtempSync(path.join(os.tmpdir(), 'ender-data-')); fs.mkdirSync(path.join(w, 'EnderStorage'));
        dataFile(path.join(w, 'EnderStorage', 'data1.dat'), { 'left=blue,middle=white,right=white,type=item': [{ id: 'minecraft:diamond_pickaxe', n: 1 }] });
        const svc = new WorkService({ dataDir: d, worldDir: w, factory: () => ({}), restore: false });
        svc.addSite({ name: 'tools-e', x: 5, y: 64, z: 5, purpose: 'tools', ender: { left: 'Blue', middle: 'white', right: 'white' } });
        svc.addSite({ name: 'ore-e', x: 6, y: 64, z: 5, purpose: 'ore', ender: { left: 'red', middle: 'red', right: 'red' } });
        const v = await svc.enderStorage();
        assert.strictEqual(v.available, true); assert.strictEqual(v.frequencies.length, 2);
        const blue = v.frequencies.find((q) => q.left === 'blue'), red = v.frequencies.find((q) => q.left === 'red');
        assert.deepStrictEqual(blue.sites.map((q) => q.purpose), ['tools']); assert.strictEqual(blue.items[0].count, 1);
        assert.deepStrictEqual([red.used, red.items.length, red.sites[0].name], [0, 0, 'ore-e'], 'a frequency only a chest names is listed empty');
        assert.deepStrictEqual(svc.listSites().sites.find((q) => q.name === 'tools-e').ender, { left: 'blue', middle: 'white', right: 'white' });
        assert.throws(() => svc.addSite({ name: 'bad', x: 1, y: 1, z: 1, purpose: 'ore', ender: { left: 'teal', middle: 'white', right: 'white' } }), /colour/);
        const svc2 = new WorkService({ dataDir: d, factory: () => ({}), restore: false });
        assert.strictEqual((await svc2.enderStorage()).available, false, 'no world folder: tagged chests only');
        fs.rmSync(w, { recursive: true }); fs.rmSync(d, { recursive: true });
    });

    console.log('\nwork ender: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
