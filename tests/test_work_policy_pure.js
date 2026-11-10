// Tool durability policy (owner 2026-11-08): per material, use a tool until it breaks, or stop just before and keep it. Iron and below (and gold) are used up,
// diamond and netherite are kept. Options, the upkeep plan, the stash move and the setting.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const options = require('../src/skills/options');
const janitor = require('../src/work/bot/janitor');
const { Sites } = require('../src/work/bot/sites');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const tool = (name, max, used) => ({ name, count: 1, maxDurability: max, durabilityUsed: used });
const POLICY = { wooden: 'use_up', stone: 'use_up', iron: 'use_up', golden: 'use_up', diamond: 'keep', netherite: 'keep' };

(async () => {
    await test('options: a use_up tier is never worn (used until it breaks), a keep tier is worn at the reserve; no policy = every tool retires as before', () => {
        const bot = {}; options.configure(bot, { retireWorn: true });
        assert.ok(options.isWorn(bot, tool('iron_pickaxe', 250, 245)), 'no policy: old behaviour');
        options.configure(bot, { toolPolicy: POLICY });
        assert.ok(!options.isWorn(bot, tool('iron_pickaxe', 250, 245)) && !options.isWorn(bot, tool('golden_pickaxe', 32, 31)) && !options.isWorn(bot, tool('wooden_axe', 59, 58)));
        assert.ok(options.isWorn(bot, tool('diamond_pickaxe', 1561, 1555)) && options.isWorn(bot, tool('netherite_pickaxe', 2031, 2025)));
        assert.ok(!options.isWorn(bot, tool('diamond_pickaxe', 1561, 100)), 'a good diamond tool is used');
        options.configure(bot, { toolPolicy: { ...POLICY, iron: 'keep' } }); assert.ok(options.isWorn(bot, tool('iron_pickaxe', 250, 245)), 'configurable per material');
        options.configure(bot, { retireWorn: false }); assert.ok(!options.isWorn(bot, tool('diamond_pickaxe', 1561, 1555)), 'the master switch still turns it all off');
        assert.deepStrictEqual([options.tierOf('golden_pickaxe'), options.tierOf('netherite_sword'), options.tierOf('shears'), options.tierOf('bow')], ['golden', 'netherite', null, null]);
    });

    await test('upkeep: a worn keep tool is stashed in a chest (never tossed), a worn use_up one cannot be worn; the exact stack is picked; no chest = it stays in the pack', async () => {
        const bot = { inventory: { items: () => [{ ...tool('diamond_pickaxe', 1561, 1556), slot: 40, type: 1 }, { ...tool('diamond_pickaxe', 1561, 20), slot: 41, type: 1 }, { ...tool('iron_pickaxe', 250, 249), slot: 42, type: 2 }] } };
        options.configure(bot, { retireWorn: true, toolPolicy: POLICY });
        const inv = janitor.inventoryOf(bot);
        assert.deepStrictEqual(inv.worn.map((x) => [x.name, x.damage, x.keep]), [['diamond_pickaxe', 1556, true]], 'the iron one is not worn (used up), the fresh diamond one is not worn');
        const ops = janitor.plan(inv.items, inv.slotsFree, janitor.pitPolicy({ discardWorn: true }), inv.worn);
        assert.deepStrictEqual(ops.filter((o) => ['stash', 'toss'].includes(o.op)).map((o) => [o.op, o.item, o.damage]), [['stash', 'diamond_pickaxe', 1556]]);
        const off = janitor.plan(inv.items, inv.slotsFree, janitor.pitPolicy({ discardWorn: false }), inv.worn);
        assert.ok(off.some((o) => o.op === 'stash'), 'also with the discard switch off: a kept tool is never lost to it');
        const sites = new Sites([{ name: 'tools', x: 1, y: 64, z: 1, purpose: 'tools' }, { name: 'main', x: 5, y: 64, z: 5, purpose: 'any' }]); const calls = [];
        const env = { inv: () => inv, pos: () => ({ x: 0, z: 0 }), here: () => ({ x: 0, y: 64, z: 0 }), w: {}, exec: async () => ({ ok: true }), run: async (n, a) => { calls.push([n, a]); return { ok: true }; } };
        const m = await janitor.maintain(env, janitor.pitPolicy({ sites: () => sites }));
        assert.ok(m.ok && calls.length === 1 && calls[0][0] === 'stash_worn' && calls[0][1].damage === 1556 && calls[0][1].x === 5, JSON.stringify(calls) + JSON.stringify(m));
        const lone = []; const m2 = await janitor.maintain({ ...env, run: async (n, a) => { lone.push(n); return { ok: true }; } }, janitor.pitPolicy({ sites: () => new Sites([{ name: 'tools', x: 1, y: 64, z: 1, purpose: 'tools' }]) }));
        assert.ok(m2.ok && !lone.length, 'only a tools chest: nothing is stashed, the tool stays in the pack');
    });

    await test('service: the default policy, validated changes, applied to online bots', () => {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pol-')); const bot = {};
        const svc = new WorkService({ dataDir: d, factory: () => ({}), restore: false });
        assert.deepStrictEqual(svc.settings.toolPolicy, POLICY);
        svc.bots.set('B', { name: 'B', bot, state: 'online' });
        svc.setSettings({ toolPolicy: { iron: 'keep' } });
        assert.strictEqual(svc.settings.toolPolicy.iron, 'keep'); assert.strictEqual(svc.settings.toolPolicy.diamond, 'keep'); assert.strictEqual(options.get(bot).toolPolicy.iron, 'keep', 'the bot follows at once');
        assert.throws(() => svc.setSettings({ toolPolicy: { copper: 'keep' } }), /unknown tier/); assert.throws(() => svc.setSettings({ toolPolicy: { iron: 'sell' } }), /use_up or keep/);
        clearTimeout(svc._saveTimer); fs.rmSync(d, { recursive: true });
    });
    await test('experts (owner 2026-11-10, slow recoveries): two failures within five minutes switch a bot\'s experts off for three minutes; a success with steps resets the count; the other fixes are named in the health row', async () => {
        const { botEnv } = require('../src/work/bot/env'), { EventEmitter } = require('events'), experts = require('../src/experts'), orig = experts.drive;
        const bot = new EventEmitter(); Object.assign(bot, { username: 'Bot', registry: { blocksByName: {}, itemsByName: {} }, entity: { position: { x: 0.5, y: 1, z: 0.5, floored: () => ({ x: 0, y: 1, z: 0 }) }, onGround: true },
            blockAt: () => ({ name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] }), inventory: { items: () => [] }, setControlState() {} });
        let calls = 0, answer = { ok: false, reason: 'timeout', steps: 5 }; experts.drive = async () => { calls++; return answer; };
        try {
            const env = botEnv(bot, { experts: () => true }), t = { x: 3, y: 1, z: 3 };
            assert.strictEqual((await env.expertMove(t)).reason, 'timeout'); assert.strictEqual((await env.expertMove(t)).reason, 'timeout');
            const refused = await env.expertMove(t); assert.strictEqual(refused.reason, 'refused'); assert.ok(refused.detail.blockedFor > 170, JSON.stringify(refused.detail)); assert.strictEqual(calls, 2, 'the third was not even tried');
            const env2 = botEnv(bot, { experts: () => true }); calls = 0;
            assert.strictEqual((await env2.expertMove(t)).reason, 'timeout'); answer = { ok: true, steps: 3 }; assert.ok((await env2.expertMove(t)).ok); answer = { ok: false, reason: 'timeout', steps: 5 };
            assert.strictEqual((await env2.expertMove(t)).reason, 'timeout'); assert.strictEqual((await env2.expertMove(t)).reason, 'timeout', 'a success in between reset the count: this was the second failure in a row, and it was still tried');
        } finally { experts.drive = orig; }
    });
    await test('server moves (the "teleporting" bots): a recovery move is limited by the setting and every move is reported; a job move is not limited', async () => {
        const { botEnv } = require('../src/work/bot/env'), { EventEmitter } = require('events');
        const solid = (x, y, z) => y <= 0;                                                                   // open flat ground
        const mkbot = (x, z) => { const bot = new EventEmitter(); Object.assign(bot, { username: 'Bot', registry: { blocksByName: {}, itemsByName: {} }, entity: { position: { x, y: 1, z, floored: () => ({ x: Math.floor(x), y: 1, z: Math.floor(z) }) }, onGround: true },
            blockAt: (v) => (solid(v.x, v.y, v.z) ? { name: 'stone', boundingBox: 'block', shapes: [[0, 0, 0, 1, 1, 1]] } : { name: 'air', boundingBox: 'empty', shapes: [] }), inventory: { items: () => [] }, setControlState() {} }); return bot; };
        const run = async (mode, purpose, dx) => {
            const sent = [], moves = [], bot = mkbot(0.5, 0.5);
            const env = botEnv(bot, { cancel: { cancelled: false }, rcon: async (c) => { sent.push(c); return 'ok'; }, moved: (m) => moves.push(m), teleport: () => mode });
            const r = await env.lift({ x: dx, y: 1, z: 0 }, { radius: 1, up: 0, down: 0, purpose, why: 'test' });
            return { r, sent, moves };
        };
        let o = await run('near', 'recover', 40); assert.ok(!o.r.ok && o.r.reason === 'refused' && /too far/.test(o.r.detail.why) && !o.sent.length, JSON.stringify(o.r));
        o = await run('near', 'recover', 6); assert.ok(o.sent.length === 1 && o.moves.length === 1 && o.moves[0].dist >= 5 && o.moves[0].purpose === 'recover' && o.moves[0].why === 'test', JSON.stringify(o.moves));
        o = await run('off', 'recover', 2); assert.ok(!o.r.ok && /off/.test(o.r.detail.why) && !o.sent.length);
        o = await run('any', 'recover', 40); assert.ok(o.sent.length === 1, 'as far as it takes');
        o = await run('near', 'job', 40); assert.ok(o.sent.length === 1 && o.moves[0].purpose === 'job', 'a job move (another layer) is not limited by near / any');
        o = await run('off', 'job', 40); assert.ok(!o.r.ok && o.r.reason === 'refused' && /off/.test(o.r.detail.why) && !o.sent.length, 'off: not even a job move (owner 2026-11-10)');
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-')); const svc = new WorkService({ dataDir: d, factory: () => ({}), restore: false });
        assert.strictEqual(svc.settings.teleport, 'off'); svc.setSettings({ teleport: 'near' }); assert.strictEqual(svc.settings.teleport, 'near'); svc.setSettings({ teleport: 'off' }); assert.throws(() => svc.setSettings({ teleport: 'sometimes' }), /off, near or any/);
        svc.bots.set('B', { name: 'B', state: 'online', bot: { entity: { position: { x: 0, y: 0, z: 0 } } } });
        svc._moved('B', { dist: 31, why: 'escape after stuck', from: { x: 1, y: 2, z: 3 }, to: { x: 4, y: 5, z: 6 } });
        const v = svc.botDetail ? svc.status().bots.find((x) => x.name === 'B') : null; assert.ok(v && v.moved && v.moved.dist === 31 && v.moved.n === 1, JSON.stringify(v && v.moved));
        assert.ok(svc.log.some((l) => /moved by the server 31 blocks/.test(l.msg)));
        clearTimeout(svc._saveTimer); fs.rmSync(d, { recursive: true });
    });

    console.log('\nwork policy: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
