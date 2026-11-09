// The owner's four BOT fixes of 2026-11-09: (1) containers first when something is missing, within 10 chunks only, Ender Storage before chests, the bot is brought to a chest in
// another layer; (2) the dump at the end of a finished job into the white / white / white Ender chest (switch); (3) the final sweep of a pit reads every chunk (walking there so that it
// is loaded) and sends what still holds a block back to work; (4) the tool a block needs is made by rule: sword for a cobweb, pickaxe, axe, shovel.
// Pure: fake worlds, fake bots, fake chests.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { Sites, REACH_BLOCKS } = require('../src/work/bot/sites');
const { approach } = require('../src/work/bot/reach');
const script = require('../src/work/bot/script');
const { runWorker } = require('../src/work/bot/worker');
const { Ledger, PENDING } = require('../src/work/jobs/crew');
const pit = require('../src/work/jobs/pit');
const { endDump, planDump, dumpSite } = require('../src/work/bot/enddump');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 40 s'); process.exit(2); }, 40000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WHITE = { left: 'white', middle: 'white', right: 'white' };

(async () => {
    // ------------------------------------------------------------------------------------------------ 1. containers
    const mk = () => new Sites([
        { name: 'near', x: 100, y: 64, z: 0, purpose: 'any' }, { name: 'far', x: 400, y: 64, z: 0, purpose: 'any' },
        { name: 'ender', x: 150, y: -59, z: 0, purpose: 'any', ender: WHITE }, { name: 'tools', x: 10, y: 64, z: 0, purpose: 'tools' },
        { name: 'junk', x: 5, y: 64, z: 0, purpose: 'trash' }, { name: 'gate', x: 900, y: 64, z: 0, purpose: 'portal' },
    ]);
    const from = { x: 0, z: 0 };
    // The same blocks with the chests that were tagged `any` tagged `free` (bots may take from those): `any` itself is insert-only.
    const mkFree = () => new Sites(mk().list().map((x) => (x.purpose === 'any' ? { ...x, purpose: 'free', tags: ['free'] } : x)));

    await test('sites: a standing container is usable within 10 chunks only; portals and links to other kinds are never filtered; the radius is a setting of the registry', () => {
        const s = mk();
        assert.strictEqual(REACH_BLOCKS, 160);
        assert.strictEqual(s.find('any', from).name, 'near');
        assert.deepStrictEqual(s.findAll('any', from).map((x) => x.name), ['near', 'ender'], 'far (400 blocks) is left out');
        assert.strictEqual(s.pick('far', from), null); assert.strictEqual(s.pick('far').name, 'far', 'no position: nothing is judged');
        assert.strictEqual(s.find('portal', from).name, 'gate', 'a gate 900 blocks away is still a gate');
        assert.strictEqual(new Sites([{ name: 'f', x: 400, y: 64, z: 0, purpose: 'any' }]).placeFor('diamond', from), null, 'nothing to put it in within reach');
        s.reach = 500; assert.strictEqual(s.pick('far', from).name, 'far');
    });

    await test('sites: other dimension = unusable; the distance is measured to the container a link points to', () => {
        const s = new Sites([{ name: 'a', x: 1, y: 0, z: 0, purpose: 'any', dim: 'overworld' }]);
        assert.strictEqual(s.find('any', { x: 0, z: 0, dim: 'nether' }), null);
        assert.strictEqual(s.find('any', { x: 0, z: 0, dim: 'overworld' }).name, 'a');
        const l = new Sites([{ name: 'chest', x: 500, y: 0, z: 0, purpose: 'any' }, { name: 'furn', x: 3, y: 0, z: 0, purpose: 'furnace', via: 'chest' }]);
        assert.strictEqual(l.find('any', from), null, 'the chest is 500 blocks away');
    });

    await test('sites.sources: Ender Storage first, then the asked purpose, then the rest, nearest first; rubbish and food chests are not sources; a chest tagged any is insert-only', () => {
        const s = mk();
        assert.deepStrictEqual(s.sources(from, 'tools').map((x) => x.name), ['tools'], 'ender and near are tagged any: nothing is taken out of them');
        assert.deepStrictEqual(s.sources(from).map((x) => x.name), ['tools']);
        assert.deepStrictEqual(s.sources(from, 'any').map((x) => x.name), ['tools'], 'asking for the purpose any (from: any in a script) is no way in either');
        assert.deepStrictEqual(s.sources(from, 'trash').map((x) => x.name), ['junk', 'tools'], 'asked for explicitly, the rubbish chest is a source again');
        assert.ok(!s.sources(from).some((x) => x.name === 'junk'));
        assert.strictEqual(s.withdrawable({ x: 150, y: -59, z: 0 }), false, 'by coordinates'); assert.strictEqual(s.withdrawable('ender'), false, 'by name'); assert.strictEqual(s.withdrawable({ x: 10, y: 64, z: 0 }), true); assert.strictEqual(s.withdrawable({ x: 777, y: 1, z: 1 }), true, 'an unknown block is not judged');
        const f = new Sites([{ name: 'ender', x: 150, y: -59, z: 0, purpose: 'free', ender: WHITE }, { name: 'tools', x: 10, y: 64, z: 0, purpose: 'tools' }, { name: 'any', x: 3, y: 64, z: 0, purpose: 'any' }]);
        assert.deepStrictEqual(f.sources(from).map((x) => x.name), ['ender', 'tools'], 'a free chest is a source, Ender Storage first');
    });

    await test('reach.approach: near = walk on; another layer = the server puts the bot there; far across = a walk in legs first; no way = a failure (strict) or try on foot', async () => {
        const calls = []; let y = 64;
        const env = { here: () => ({ x: 0, y, z: 0 }), lift: async (c, o) => { calls.push(['lift', c.y, o.purpose]); y = c.y; return { ok: true }; }, travel: async (t, o) => { calls.push(['travel', t.x, o.near]); return { ok: true, legs: 3 }; } };
        assert.strictEqual(await approach(env, { x: 5, y: 60, z: 5 }), null); assert.deepStrictEqual(calls, []);
        assert.strictEqual(await approach(env, { x: 3, y: -59, z: 3 }), null); assert.deepStrictEqual(calls, [['lift', -59, 'job']]);
        calls.length = 0; y = 64;
        assert.strictEqual(await approach(env, { x: 120, y: 64, z: 0 }), null); assert.deepStrictEqual(calls, [['travel', 120, 24]]);
        const bare = { here: () => ({ x: 0, y: 64, z: 0 }) }, far = { x: 3, y: -59, z: 3 };
        assert.strictEqual((await approach(bare, far)).reason, 'unreachable');
        assert.strictEqual(await approach(bare, far, { strict: false }), null);
        assert.strictEqual((await approach({ ...env, lift: async () => ({ ok: false, reason: 'unreachable' }) }, far)).reason, 'unreachable');
        assert.strictEqual((await approach({ ...env, lift: undefined, travel: async () => ({ ok: false, reason: 'stuck' }) }, { x: 120, y: 64, z: 0 })).reason, 'stuck');
    });

    await test('script take: the containers are asked in priority order (Ender first), each only once per run, the bot is brought to a chest in another layer, then the script goes on', async () => {
        const s = mkFree(), log = []; let y = 64;
        const stock = { near: 5 };                                           // the Ender chest has none of it
        const env = { sites: s, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y, z: 0 }), have: () => 0, inv: () => ({ items: [], slotsFree: 30 }),
            lift: async (c) => { log.push(`lift ${c.y}`); y = c.y; return { ok: true }; },
            exec: async (name, a) => { const who = [...s.list()].find((x) => x.x === a.x && x.z === a.z).name; log.push(`${name} ${who} ${a.count}`); return stock[who] >= a.count ? { ok: true } : { ok: false, reason: 'missing_item' }; } };
        const sc = script.validate({ name: 't', steps: [{ take: { item: 'iron_ingot', count: 3, from: 'ore' } }, { take: { item: 'iron_ingot', count: 3, from: 'any' } }, { return: 'ok' }] });
        const r = await script.runScript(sc, env);
        assert.ok(r.ok, JSON.stringify(r));
        assert.deepStrictEqual(log, ['lift -59', 'withdraw ender 3', 'withdraw ender 1', 'lift 64', 'withdraw tools 3', 'withdraw tools 1', 'withdraw near 3', 'withdraw near 3'], 'Ender first, then the tools chest, then the plain one; the second take opens only the one that has it');
        const none = await script.runScript(script.validate({ name: 'n', steps: [{ take: { item: 'iron_ingot', from: 'ore' } }] }), { ...env, sites: new Sites() });
        assert.strictEqual(none.reason, 'invalid_target'); assert.ok(/no container within 10 chunks/.test(none.detail.why), none.detail.why);
    });

    await test('take_tool: the tools chest and every other container within reach are asked; a chest that cannot be reached is passed over', async () => {
        const s = mkFree(), asked = []; let have = false;
        const env = { sites: s, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), usableTool: () => (have ? { name: 'iron_sword' } : null), usableCount: () => (have ? 1 : 0),
            lift: async () => ({ ok: false, reason: 'unreachable' }),
            run: async (name, a) => { asked.push(`${a.x},${a.y},${a.z}`); if (a.x === 100) { have = true; return { ok: true, detail: { item: 'iron_sword', left: 200 } }; } return { ok: false, reason: 'missing_item' }; } };
        const r = await script.runScript(script.validate({ name: 't', steps: [{ take_tool: { class: 'sword', from: 'tools' } }, { return: 'ok' }] }), env);
        assert.ok(r.ok, JSON.stringify(r));
        assert.deepStrictEqual(asked, ['10,64,0', '100,64,0'], 'the Ender chest 123 levels down could not be reached (no lift): passed over; tools then the plain chest');
    });

    // ------------------------------------------------------------------------------------------------ 4. tools by rule
    const registry = { blocksByName: { cobweb: { harvestTools: { 10: true, 11: true, 12: true } }, stone: { harvestTools: { 20: true, 21: true } }, shearsonly: { harvestTools: { 12: true } }, dirt: {} },
        items: { 10: { name: 'wooden_sword' }, 11: { name: 'iron_sword' }, 12: { name: 'shears' }, 20: { name: 'wooden_pickaxe' }, 21: { name: 'iron_pickaxe' } } };

    await test('the class a block needs: a cobweb a sword (shears cannot be made), stone a pickaxe, a block nothing can be made for none, an unknown one no data', () => {
        assert.deepStrictEqual(script.toolClassesOf(registry, 'cobweb').sort(), ['shears', 'sword']);
        assert.strictEqual(script.craftClassFor(registry, 'minecraft:cobweb'), 'sword');
        assert.strictEqual(script.craftClassFor(registry, 'stone'), 'pickaxe');
        assert.strictEqual(script.craftClassFor(registry, 'shearsonly'), null); assert.deepStrictEqual(script.toolClassesOf(registry, 'shearsonly'), ['shears']);
        assert.deepStrictEqual(script.toolClassesOf(registry, 'nope'), []); assert.deepStrictEqual(script.toolClassesOf(null, 'cobweb'), []);
        assert.deepStrictEqual([...script.BUILT_IN.keys()].filter((k) => /^replace-/.test(k)).sort(), ['replace-axe', 'replace-shovel', 'replace-sword', 'replace-tool']);
        assert.strictEqual(script.toolScriptName('pickaxe'), 'replace-tool'); assert.strictEqual(script.toolScriptName('sword'), 'replace-sword');
    });

    await test('replace-sword / -axe / -shovel craft the right tool from what the bot carries (stone, iron, wood), with the right amounts; and finish when the tool is there', async () => {
        for (const [cls, n, sticks] of [['sword', 2, 1], ['axe', 3, 2], ['shovel', 1, 2]]) {
            const crafted = []; let got = false;
            const have = { stick: sticks, cobblestone: n, crafting_table: 1 };
            const env = { sites: new Sites(), pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 10, z: 0 }), w: { kindAt: (x, y) => (y < 10 ? 'solid' : 'air'), nameAt: () => 'stone' },
                have: (i) => have[i] || 0, inv: () => ({ items: Object.entries(have).map(([name, count]) => ({ name, count })), slotsFree: 20 }), canCraft: () => false,
                usableTool: () => (got ? { name: `stone_${cls}` } : null), usableCount: () => (got ? 1 : 0),
                exec: async (name, a) => { if (name === 'craft') { crafted.push(a.item); got = true; } return { ok: true }; } };
            const r = await script.runScript(script.BUILT_IN.get(script.toolScriptName(cls)), env);
            assert.ok(r.ok, `${cls}: ${JSON.stringify(r)}`); assert.deepStrictEqual(crafted, [`stone_${cls}`]);
            // not enough cobblestone and no iron: the script does not craft and says fail
            have.cobblestone = n - 1; got = false; crafted.length = 0;
            const f = await script.runScript(script.BUILT_IN.get(script.toolScriptName(cls)), env);
            assert.strictEqual(f.ok, false, `${cls} with ${n - 1} cobblestone`); assert.deepStrictEqual(crafted, []);
        }
    });

    await test('the pickaxe script is the owner\'s old one, unchanged in what it does (the generator reproduces it step for step)', () => {
        const p = script.validate(script.replaceScript('pickaxe'));
        assert.strictEqual(p.name, 'replace-tool'); assert.ok(JSON.stringify(p).includes('"iron_pickaxe"') && JSON.stringify(p).includes('"stone_pickaxe"') && JSON.stringify(p).includes('"wooden_pickaxe"'));
        assert.throws(() => script.replaceScript('hoe'), /no recipe/);
    });

    await test('fetchScript: a missing item is taken from the containers, the first acceptable one that exists; nothing named = no script', async () => {
        assert.strictEqual(script.fetchScript({}), null); assert.strictEqual(script.fetchScript({ item: '../x y' }), null); assert.strictEqual(script.fetchScript(null), null);
        const s = new Sites([{ name: 'e', x: 5, y: 64, z: 5, purpose: 'free', ender: WHITE }]), inv = { dirt: 0 }, tried = [];
        const env = { sites: s, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), have: (i) => inv[i] || 0, inv: () => ({ items: [], slotsFree: 30 }),
            exec: async (name, a) => { tried.push(a.item); if (a.item === 'dirt') { inv.dirt = 64; return { ok: true }; } return { ok: false, reason: 'missing_item' }; } };
        const r = await script.runScript(script.fetchScript({ tried: ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone'] }), env);
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(tried.filter((x) => x === 'dirt').length, 1); assert.ok(!tried.includes('stone'), 'stops at the first one that came');
    });

    await test('worker: a handler may be a function of the failed result (the block that needed a tool); the unit then runs again', async () => {
        const ledger = new Ledger({ leaseMs: 1e9 }); ledger.addRegion({ id: 'r', anchor: { x: 0, z: 0 }, layers: 1, rows: 1 });
        let n = 0; const picked = [];
        const job = { ledger, runUnit: async () => (n++ ? { ok: true } : { ok: false, reason: 'missing_tool', detail: { block: 'cobweb' } }) };
        const sc = script.validate({ name: 'noop', steps: [{ return: 'ok' }] });
        const res = await runWorker(job, 'b', { pos: () => ({ x: 0, z: 0 }), now: Date.now, exec: async () => ({ ok: true }) }, { pollMs: 5, backoff: () => 1, handlers: { missing_tool: (r) => { picked.push(r.detail.block); return sc; } } });
        assert.strictEqual(res.ended, 'finished'); assert.deepStrictEqual(picked, ['cobweb']);
    });

    // ------------------------------------------------------------------------------------------------ 3. final sweep
    await test('final sweep: the old check cannot see a chunk the bot does not know; the sweep walks there, reads it from the top and sends the leftover back', async () => {
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 47, z1: 15, top: 0, bottom: -1 }, { leaseMs: 1e9 }, { method: 'sweep', road: false });
        for (const [id, r] of job.ledger.regions) for (let u = 0; u < r.n; u++) job.ledger.done('b', id, u, 0);
        assert.ok(job.ledger.finished());
        const stones = new Map([['40,-1,5', 'stone']]);                          // a leftover in the third chunk (x 32..47), at the bottom layer
        const loaded = new Set(['0_0']), chunk = (x, z) => `${x >> 4}_${z >> 4}`, travelled = [];
        const nameAt = (x, y, z) => stones.get(`${x},${y},${z}`) || (y <= -2 ? 'stone' : 'air');
        const w = { nameAt, kindAt: (x, y, z) => (!loaded.has(chunk(x, z)) ? 'unknown' : nameAt(x, y, z) === 'air' ? 'air' : 'solid') };
        const env = { w, pos: () => ({ x: 8, z: 8 }), travel: async (t) => { travelled.push(chunk(t.x, t.z)); loaded.add(chunk(t.x, t.z)); return { ok: true, legs: 1 }; } };
        const old = job.audit(env, 0, { full: true });
        assert.deepStrictEqual([old.reopened.length, old.gaveUp.length], [0, 0], 'the old check skips what it cannot see');
        const seen = [];
        for (let i = 0; i < 12; i++) { const r = await job.sweep(env, 0); if (!r.region) break; seen.push([r.region, r.reopened]); }
        assert.deepStrictEqual(travelled, ['1_0', '2_0'], 'two chunks were out of sight: walked to');
        const first = seen.map((x) => x[0]);
        assert.deepStrictEqual(first.slice(0, 3), ['c0_0', 'c1_0', 'c2_0']);
        assert.strictEqual(seen.find((x) => x[0] === 'c2_0' && x[1]).at(1), 1, 'exactly the unit holding the leftover');
        const r2 = job.ledger.regions.get('c2_0'); let pending = 0; for (let u = 0; u < r2.n; u++) if (r2.state[u] === PENDING) pending++;
        assert.strictEqual(pending, 1); assert.strictEqual(job.ledger.finished(), false, 'the job is not finished while a unit is back in the pool');
    });

    await test('final sweep: the chunk is looked at again after the repair; a leftover that keeps coming back is given up on after the cap; a chunk that cannot be loaded is retried, not judged', async () => {
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 15, z1: 15, top: 0, bottom: 0 }, { leaseMs: 1e9 }, { method: 'sweep', road: false });
        for (const [id, r] of job.ledger.regions) for (let u = 0; u < r.n; u++) job.ledger.done('b', id, u, 0);
        const bad = new Map([['5,0,5', 'water']]);
        const w = { nameAt: (x, y, z) => bad.get(`${x},${y},${z}`) || 'air', kindAt: (x, y, z) => (bad.has(`${x},${y},${z}`) ? 'water' : 'air') };
        const env = { w, pos: () => ({ x: 0, z: 0 }) };
        let reopened = 0, rounds = 0;
        for (let i = 0; i < 20; i++) {
            const r = await job.sweep(env, 0); if (!r.region) break; rounds++;
            if (r.reopened) { reopened += r.reopened; const reg = job.ledger.regions.get('c0_0'); for (let u = 0; u < reg.n; u++) if (reg.state[u] === PENDING) job.ledger.done('b', 'c0_0', u, 0); }       // the bot "repairs" it, the water comes back
        }
        assert.ok(reopened >= 1 && reopened <= 5, `reopened ${reopened} times: capped`); assert.ok(rounds <= 6, `rounds ${rounds}`);
        const dark = pit.createPitJob({ x0: 0, z0: 0, x1: 15, z1: 15, top: 0, bottom: 0 }, { leaseMs: 1e9 }, { method: 'sweep', road: false });
        for (const [id, r] of dark.ledger.regions) for (let u = 0; u < r.n; u++) dark.ledger.done('b', id, u, 0);
        const blind = { w: { nameAt: () => 'stone', kindAt: () => 'unknown' }, pos: () => ({ x: 0, z: 0 }), travel: async () => ({ ok: false, reason: 'stuck' }) };
        const a = await dark.sweep(blind, 0);
        assert.strictEqual(a.reopened, 0); assert.ok(a.unknown > 0 && a.travelled === 'stuck', JSON.stringify(a));
    });

    await test('worker: a finished pit job is swept chunk by chunk before the bot reports it finished; units sent back are dug by the same bot', async () => {
        const job = pit.createPitJob({ x0: 0, z0: 0, x1: 15, z1: 15, top: 0, bottom: -1 }, { leaseMs: 1e9 }, { method: 'sweep', road: false });
        const solid = new Set(), ran = [];
        const nameAt = (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'stone' : 'air');
        const w = { nameAt, kindAt: (x, y, z) => (solid.has(`${x},${y},${z}`) ? 'solid' : 'air') };
        const real = job.runUnit;
        let first = true;
        job.runUnit = async (rid, u, env) => { ran.push(u.unit); const r = await real(rid, u, env); if (first) { first = false; solid.add('8,0,8'); } return r; };     // something falls into the first layer behind the bot
        const events = [];
        const env = { w, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 8, y: 0, z: 8 }), now: Date.now, have: () => 0, exec: async (name, a) => { if (name === 'mine') solid.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } };
        const res = await runWorker(job, 'b', env, { pollMs: 2, onEvent: (ev, d) => events.push(ev) });
        assert.strictEqual(res.ended, 'finished'); assert.ok(events.includes('sweep'), events.join(','));
        assert.ok(solid.size === 0, 'the leftover was dug'); assert.ok(job.ledger.finished());
        assert.ok(ran.length > job.ledger.regions.get('c0_0').n, `some unit ran twice: ${ran.length} runs of ${job.ledger.regions.get('c0_0').n} units`);
    });

    // ------------------------------------------------------------------------------------------------ 2. end of job dump
    await test('enddump: everything but tools and containers, most valuable first; the Ender chest takes what fits, the rest goes to the chest of its class; nothing is thrown away', async () => {
        const items = [{ name: 'iron_pickaxe', count: 1 }, { name: 'enderstorage:ender_chest', count: 1 }, { name: 'shulker_box', count: 1 }, { name: 'water_bucket', count: 1 }, { name: 'cobblestone', count: 500 }, { name: 'coal', count: 20 }, { name: 'diamond', count: 3 }];
        assert.deepStrictEqual(planDump(items).map((x) => x.name), ['diamond', 'coal', 'cobblestone']);
        const s = new Sites([{ name: 'e', x: 5, y: 64, z: 5, purpose: 'free', ender: WHITE }, { name: 'plain', x: 20, y: 64, z: 5, purpose: 'any' }, { name: 'blue', x: 6, y: 64, z: 5, purpose: 'other', ender: { left: 'blue', middle: 'white', right: 'white' } }]);
        const pack = Object.fromEntries(items.map((i) => [i.name, i.count])), chest = { e: 100, plain: 1e9, blue: 1e9 }, put = [];
        const env = { inv: () => ({ items: Object.entries(pack).map(([name, count]) => ({ name, count })), slotsFree: 5 }), have: (n) => pack[n] || 0, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }),
            exec: async (name, a) => { const who = s.list().find((x) => x.x === a.x).name; const m = Math.min(a.count, chest[who]); chest[who] -= m; pack[a.item] -= m; put.push(`${who}:${a.item}:${m}`); return m === a.count ? { ok: true } : { ok: false, reason: 'not_confirmed' }; } };
        assert.strictEqual(dumpSite(s, { x: 0, z: 0 }, WHITE).name, 'e', 'the white / white / white chest, not the blue one');
        const r = await endDump(env, { sites: s, freq: WHITE });
        assert.ok(r.ok, JSON.stringify(r));
        assert.deepStrictEqual(put, ['e:diamond:3', 'e:coal:20', 'e:cobblestone:77', 'plain:cobblestone:423']);
        assert.deepStrictEqual(Object.keys(pack).filter((k) => pack[k] > 0).sort(), ['enderstorage:ender_chest', 'iron_pickaxe', 'shulker_box', 'water_bucket']);
    });

    await test('enddump: no usable storage = the pack stays as it is and the reason says why; a chest beyond 10 chunks does not count; a bot that died stops it', async () => {
        const pack = { diamond: 2 }, env = { inv: () => ({ items: [{ name: 'diamond', count: 2 }], slotsFree: 30 }), have: (n) => pack[n] || 0, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), exec: async () => ({ ok: true }) };
        const far = new Sites([{ name: 'e', x: 900, y: 64, z: 0, purpose: 'free', ender: WHITE }]);
        const r = await endDump(env, { sites: far, freq: WHITE });
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'invalid_target'); assert.ok(/no tagged storage within 10 chunks/.test(r.detail.why)); assert.deepStrictEqual(r.left, [{ item: 'diamond', count: 2, reason: 'no_site' }]);
        assert.deepStrictEqual((await endDump({ ...env, inv: () => ({ items: [{ name: 'iron_axe', count: 1 }], slotsFree: 30 }) }, { sites: far })).dumped, [], 'only tools: nothing to do, and no storage needed');
        const near = new Sites([{ name: 'e', x: 5, y: 64, z: 5, purpose: 'free', ender: WHITE }]);
        const dead = await endDump({ ...env, exec: async () => ({ ok: false, reason: 'died' }) }, { sites: near, freq: WHITE });
        assert.strictEqual(dead.ok, false); assert.strictEqual(dead.reason, 'died');
    });

    await test('mod items can be deposited and withdrawn (create:limestone was refused as "not a valid name" and stopped the whole upkeep); one bad item does not stop the others', async () => {
        const { validateArgs } = require('../src/skills');
        validateArgs('deposit', { item: 'create:limestone', count: 5, x: 1, y: 2, z: 3 }); validateArgs('withdraw', { item: 'create:zinc_ingot', count: 1, x: 1, y: 2, z: 3 });
        assert.throws(() => validateArgs('deposit', { item: 'Create:Limestone', count: 5, x: 1, y: 2, z: 3 }), /valid/);
        const janitor = require('../src/work/bot/janitor');
        const sites = new Sites([{ name: 'any', x: 3, y: 64, z: 3, purpose: 'any' }]), calls = [];
        const env = { inv: () => ({ items: [{ name: 'create:limestone', count: 64 }, { name: 'raw_iron', count: 30 }, { name: 'diamond', count: 2 }], slotsFree: 0 }), pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), have: () => 0,
            exec: async (name, a) => { calls.push(a.item); return a.item === 'create:limestone' ? { ok: false, reason: 'invalid_args', detail: { why: 'not a valid name' } } : { ok: true }; } };
        const r = await janitor.maintain(env, janitor.pitPolicy({ sites: () => sites }));
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(calls.sort(), ['create:limestone', 'diamond', 'raw_iron']); assert.strictEqual(r.skipped.length, 1);
        const only = await janitor.maintain({ ...env, inv: () => ({ items: [{ name: 'create:limestone', count: 64 }], slotsFree: 0 }) }, janitor.pitPolicy({ sites: () => sites }));
        assert.strictEqual(only.ok, false); assert.strictEqual(only.reason, 'invalid_args');
    });

    await test('approach: a walk that fails far from the chest is followed by the server lift (a deep pit has no surface to walk on); a walk that died is not', async () => {
        const calls = [];
        const env = { here: () => ({ x: 0, y: 40, z: 0 }), travel: async () => ({ ok: false, reason: 'unreachable' }), lift: async () => { calls.push('lift'); return { ok: true }; } };
        assert.strictEqual(await approach(env, { x: 60, y: 40, z: 0 }), null); assert.deepStrictEqual(calls, ['lift']);
        const r = await approach({ ...env, travel: async () => ({ ok: false, reason: 'died' }) }, { x: 60, y: 40, z: 0 }); assert.strictEqual(r.reason, 'died'); assert.deepStrictEqual(calls, ['lift']);
        assert.strictEqual((await approach({ ...env, lift: undefined }, { x: 60, y: 40, z: 0 })).reason, 'unreachable');
    });

    // ------------------------------------------------------------------------------------------------ service
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfix-'));
    const factory = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 0, y: 70, z: 0 } }, registry, inventory: { items: () => b.items || [] }, quit() {} }); setTimeout(() => b.emit('spawn'), 1); return b; };
    const svc = new WorkService({ dataDir: dir, factory, envFactory: () => ({}), display: false });
    svc.addBot('Bot1'); for (let i = 0; i < 300 && svc.status().bots[0].state !== 'online'; i++) await sleep(10);
    const rec = svc.bots.get('Bot1');

    await test('service: the missing-tool handler picks the script by the block (cobweb -> sword); shears-only = none; no registry data = the pickaxe script as before', () => {
        assert.strictEqual(svc._toolScript(rec, 'cobweb').name, 'replace-sword');
        assert.strictEqual(svc._toolScript(rec, 'stone').name, 'replace-tool');
        assert.strictEqual(svc._toolScript(rec, 'shearsonly'), null);
        assert.strictEqual(svc._toolScript(rec, 'unknown_block').name, 'replace-tool');
    });

    await test('service: the dump switch and its colours are settings with closed validation; on by default with white / white / white', () => {
        assert.strictEqual(svc.settings.endDump, true); assert.deepStrictEqual(svc.settings.endDumpEnder, WHITE);
        svc.setSettings({ endDump: false }); assert.strictEqual(svc.settings.endDump, false);
        svc.setSettings({ endDumpEnder: { left: 'blue', middle: 'white', right: 'light blue' } }); assert.deepStrictEqual(svc.settings.endDumpEnder, { left: 'blue', middle: 'white', right: 'light_blue' });
        assert.throws(() => svc.setSettings({ endDumpEnder: { left: 'plaid', middle: 'white', right: 'white' } }), /colour/);
        assert.throws(() => svc.setSettings({ endDumpEnder: { left: 'white', middle: 'white', right: 'white', owner: '00000000-0000-0000-0000-000000000000' } }), /no owner/);
        svc.setSettings({ endDump: true, endDumpEnder: WHITE });
    });

    await test('service: _endDump runs only when the switch is on, only for bots that are free, and releases them afterwards; a cancelled job never gets here', async () => {
        svc.sites = new Sites([{ name: 'e', x: 5, y: 64, z: 5, purpose: 'free', ender: WHITE }]);
        const pack = { diamond: 4 }, deposits = [];
        svc.envFactory = () => ({ inv: () => ({ items: Object.entries(pack).map(([name, count]) => ({ name, count })), slotsFree: 20 }), have: (n) => pack[n] || 0, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), configure() {}, dispose() {},
            exec: async (name, a) => { deposits.push(`${name} ${a.item} ${a.count}`); pack[a.item] -= a.count; return { ok: true }; } });
        const job = { id: 'jx', kind: 'build', spec: {}, policy: null };
        svc.setSettings({ endDump: false }); await svc._endDump(job, ['Bot1']); assert.deepStrictEqual(deposits, [], 'switched off');
        svc.setSettings({ endDump: true });
        rec.worker = { cancel: { cancelled: false } }; await svc._endDump(job, ['Bot1']); assert.deepStrictEqual(deposits, [], 'a bot that is busy is left alone'); rec.worker = null;
        await svc._endDump(job, ['Bot1']);
        assert.deepStrictEqual(deposits, ['deposit diamond 4']); assert.strictEqual(rec.worker, null, 'released');
        assert.ok(svc.log.some((e) => /end-of-job dump \(jx\): 4 items in 1 deposits/.test(e.msg)), svc.log.slice(-3).map((e) => e.msg).join('|'));
    });

    await svc.stop();
    console.log('\nwork fixes: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
