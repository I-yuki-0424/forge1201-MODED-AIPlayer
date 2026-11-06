// Links between tagged blocks (src/work/bot/sites.js `via`, src/work/service/links.js): a machine linked to a container, followed like a symbolic link.
// Registry rules (unique coordinates, loops, dangling, removal), the janitor never stores in a machine, commands and inventory targets redirected.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Sites, MAX_HOPS } = require('../src/work/bot/sites');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const throws = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('did not throw'); };

(async () => {
    await test('sites: label, machine tag and via; the container must exist; coordinates are unique', () => {
        const s = new Sites();
        s.add({ name: 'smelter-chest', x: 10, y: 64, z: 5, tags: ['ore'], label: 'chest at the hopper' });
        const f = s.add({ name: 'smelter', x: 10, y: 64, z: 6, tags: ['machine'], label: '自動かまど', via: 'smelter-chest' });
        assert.strictEqual(f.label, '自動かまど'); assert.strictEqual(f.via, 'smelter-chest');
        throws(() => s.add({ name: 'x1', x: 1, y: 1, z: 1, tags: ['machine'], via: 'nothing' }), /no site nothing/);
        throws(() => s.add({ name: 'x1', x: 10, y: 64, z: 6, tags: ['ore'] }), /already tagged as smelter/);
        throws(() => s.add({ name: 'x1', x: 1, y: 1, z: 1 }), /at least one tag or a label/);
        throws(() => s.add({ name: 'x1', x: 1, y: 1, z: 1, label: 'a<b' }), /label/);
        throws(() => s.add({ name: 'x1', x: 1, y: 1, z: 1, tags: ['ore'], via: 'x1' }), /itself/);
        throws(() => s.add({ name: 'x1', x: 1, y: 1, z: 1, tags: ['machine'], via: 'smelter' }), /container, not to another machine/);
        s.add({ name: 'just-a-label', x: 3, y: 3, z: 3, label: 'the big tree' });                  // a label alone is a valid tag
        assert.strictEqual(s.get('just-a-label').tags.length, 0);
    });

    await test('through: follows the link to the container; unlinked blocks answer null; loops, depth and missing targets are errors; the target cannot be removed', () => {
        const s = new Sites([{ name: 'chest', x: 0, y: 0, z: 0, tags: ['storage'] }, { name: 'furnace', x: 0, y: 0, z: 1, tags: ['machine'], via: 'chest' }]);
        assert.deepStrictEqual(s.through(0, 0, 1), { x: 0, y: 0, z: 0, via: ['furnace', 'chest'] });
        assert.strictEqual(s.through(0, 0, 0), null); assert.strictEqual(s.through(9, 9, 9), null);
        throws(() => s.remove('chest'), /target of furnace/);
        assert.ok(s.remove('furnace')); assert.ok(s.remove('chest'));
        // a stored list in any order, with a loop and a dangling link: loaded, the dangling link dropped, the loop found when followed
        const t = new Sites([{ name: 'a', x: 1, y: 0, z: 0, tags: ['machine'], via: 'b' }, { name: 'b', x: 2, y: 0, z: 0, tags: ['storage'] }, { name: 'c', x: 3, y: 0, z: 0, tags: ['ore'], via: 'gone' }]);
        assert.ok(t.through(1, 0, 0)); assert.strictEqual(t.get('c').via, undefined);
        const loop = new Sites([{ name: 'p', x: 1, y: 0, z: 0, tags: ['ore'], via: 'q' }, { name: 'q', x: 2, y: 0, z: 0, tags: ['ore'], via: 'p' }]);
        throws(() => loop.through(1, 0, 0), /loop/);
        assert.ok(MAX_HOPS >= 2);
    });

    await test('find and placeFor: a machine is never where items are put away; a link answers with its container', () => {
        const s = new Sites([{ name: 'chest', x: 5, y: 60, z: 5, tags: ['storage'] }, { name: 'furnace', x: 5, y: 60, z: 6, tags: ['machine', 'ore'], via: 'chest' }, { name: 'oven', x: 9, y: 60, z: 9, tags: ['machine'] }]);
        assert.strictEqual(s.find('ore'), null, 'a machine is not an ore chest');
        assert.strictEqual(s.placeFor('raw_iron').name, 'chest');
        const m = s.find('machine'); assert.strictEqual(m.name, 'furnace'); assert.deepStrictEqual([m.x, m.y, m.z, m.linked], [5, 60, 5, 'furnace']);
    });

    // ---- the service
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wlinks-')), rcon = [];
    const factory = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 0, y: 70, z: 0 } }, inventory: { items: () => [], slots: [], emptySlotCount: () => 30 }, blockAt: () => ({ name: 'furnace' }), quit() {} }); setTimeout(() => b.emit('spawn'), 5); return b; };
    const svc = new WorkService({ dataDir: dir, factory, envFactory: () => ({}), rcon: { command: async (c) => { rcon.push(c); return ''; } } });
    svc.addBot('Bot1'); while (svc.status().bots[0].state !== 'online') await sleep(10);
    svc.addSite({ name: 'smelter-chest', x: 10, y: 64, z: 5, tags: ['ore'] });
    svc.addSite({ name: 'smelter', x: 10, y: 64, z: 6, tags: ['machine'], label: 'auto furnace', via: 'smelter-chest' });
    const skills = require('../src/skills'), orig = skills.execute, seen = [];
    skills.execute = async (bot, name, args) => { seen.push([name, args]); return { ok: true }; };
    try {
        await test('commands: deposit and withdraw at the machine run on its container; by name too; the page is told which links were followed', async () => {
            let r = await svc.runCommand({ bots: ['Bot1'], command: 'withdraw', args: { item: 'iron_ingot', count: 8, x: 10, y: 64, z: 6 } });
            assert.deepStrictEqual(r.started, ['Bot1']); assert.deepStrictEqual(r.via, ['smelter', 'smelter-chest']);
            await sleep(20); assert.deepStrictEqual(seen.pop(), ['withdraw', { item: 'iron_ingot', count: 8, x: 10, y: 64, z: 5 }]);
            assert.deepStrictEqual(svc.botDetail('Bot1').cmdArgs, { item: 'iron_ingot', count: 8, x: 10, y: 64, z: 5 });
            r = await svc.runCommand({ bots: ['Bot1'], command: 'deposit', args: { item: 'raw_iron', count: 4, site: 'smelter' } });
            await sleep(20); assert.deepStrictEqual(seen.pop(), ['deposit', { item: 'raw_iron', count: 4, x: 10, y: 64, z: 5 }]);
            r = await svc.runCommand({ bots: ['Bot1'], command: 'deposit', args: { item: 'raw_iron', count: 4, x: 99, y: 64, z: 5 } });
            assert.strictEqual(r.via, undefined); await sleep(20); assert.strictEqual(seen.pop()[1].x, 99, 'coordinates nobody tagged are left alone');
            await assert.rejects(svc.runCommand({ bots: ['Bot1'], command: 'deposit', args: { item: 'x', count: 1, site: 'nope' } }), /no tagged block nope/);
        });
        await test('commands: smelt on a machine is refused with the way to do it; a linked machine without a container is an error, not a guess', async () => {
            await assert.rejects(svc.runCommand({ bots: ['Bot1'], command: 'smelt', args: { item: 'raw_iron', x: 10, y: 64, z: 6 } }), /machine linked to smelter-chest: use deposit/);
            const s2 = svc.sites; s2.map.get('smelter').via = 'ghost';
            await assert.rejects(svc.runCommand({ bots: ['Bot1'], command: 'withdraw', args: { item: 'x', count: 1, x: 10, y: 64, z: 6 } }), /missing site/);
            s2.map.get('smelter').via = 'smelter-chest';
        });
        await test('inventory: the page shows and moves through the container of a machine', async () => {
            const target = svc._linkTarget({ type: 'block', x: 10, y: 64, z: 6 }); assert.deepStrictEqual(target, { type: 'block', x: 10, y: 64, z: 5 });
            assert.deepStrictEqual(svc._linkTarget({ type: 'entity', name: 'Bot1' }), { type: 'entity', name: 'Bot1' });
            rcon.length = 0; await svc.inventory({ type: 'block', x: 10, y: 64, z: 6 }).catch(() => {});
            assert.ok(rcon.length && rcon.every((c) => !/ 10 64 6\b/.test(c) && / 10 64 5\b/.test(c)), `RCON saw ${JSON.stringify(rcon)}`);
        });
        await test('listing: label, block in the world, where the link ends; removing the container is refused over the API too', async () => {
            const l = svc.listSites(), f = l.sites.find((x) => x.name === 'smelter');
            assert.strictEqual(f.label, 'auto furnace'); assert.strictEqual(f.block, 'furnace'); assert.deepStrictEqual(f.end, { x: 10, y: 64, z: 5, path: ['smelter', 'smelter-chest'] });
            assert.ok(l.tags.machine);
            assert.throws(() => svc.removeSite('smelter-chest'), (e) => e.status === 409 && /target of smelter/.test(e.message));
            svc.removeSite('smelter'); svc.removeSite('smelter-chest');
        });
    } finally { skills.execute = orig; await svc.stop(); }
    console.log('\nlinks: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
