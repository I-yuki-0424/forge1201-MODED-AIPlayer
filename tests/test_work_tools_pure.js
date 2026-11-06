// Tools and the depot (owner 2026-11-06): worn-out tools are used up and thrown away (that exact stack), the tools chest hands out usable ones only,
// a bot with only a worn tool is not "waiting for what it has", the depot has a rank, the particles do not fill the chat.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const janitor = require('../src/work/bot/janitor');
const { Sites } = require('../src/work/bot/sites');
const { makeClear } = require('../src/work/bot/discard');
const { pickUsable, wornOut } = require('../src/work/bot/moves');
const script = require('../src/work/bot/script');
const { WorkService } = require('../src/work/service');
const { Overlay } = require('../src/work/display/overlay');
const options = require('../src/skills/options');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (name, max, used) => ({ name, maxDurability: max, durabilityUsed: used, count: 1, type: 1, slot: 0 });

(async () => {
    await test('wornOut: 8 uses or 6 % left, whether or not the bot retires worn tools; a stack that does not wear is never worn', () => {
        assert.ok(wornOut(tool('iron_pickaxe', 250, 235)));          // 15 left = 6 %
        assert.ok(!wornOut(tool('iron_pickaxe', 250, 234)));         // 16 left
        assert.ok(wornOut(tool('wooden_pickaxe', 59, 52)));          // 7 left (<= 8)
        assert.ok(!wornOut({ name: 'cobblestone', count: 64 }));
    });

    await test('pickUsable: the best tier first, then the most uses left; worn ones are never taken and are counted', () => {
        const items = [tool('iron_pickaxe', 250, 240), tool('iron_pickaxe', 250, 10), tool('diamond_pickaxe', 1561, 1555), tool('stone_pickaxe', 131, 0), tool('iron_axe', 250, 0), tool('iron_pickaxe', 250, 100)];
        const r = pickUsable(items, 'pickaxe');
        assert.strictEqual(r.pick.name, 'iron_pickaxe'); assert.strictEqual(r.pick.durabilityUsed, 10, 'the diamond one is worn out, so iron: the freshest');
        assert.strictEqual(r.worn, 2);
        const none = pickUsable([tool('iron_pickaxe', 250, 245), tool('iron_pickaxe', 250, 249)], 'pickaxe');
        assert.strictEqual(none.pick, null); assert.strictEqual(none.worn, 2);
        assert.strictEqual(pickUsable([], 'pickaxe').pick, null);
    });

    await test('take_tool in a script uses take_usable and says when the chest holds only worn ones; nothing worn is ever taken', async () => {
        const sites = new Sites([{ name: 'tools-chest', x: 5, y: 64, z: 5, tags: ['tools'] }]);
        const sc = script.validate({ name: 't', steps: [{ take_tool: { class: 'pickaxe', from: 'tools' } }, { return: 'ok' }] });
        let have = false; const calls = [];
        const env = { sites, usableTool: () => (have ? { name: 'iron_pickaxe' } : null), pos: () => ({ x: 0, z: 0 }), exec: async () => ({ ok: true }),
            run: async (name, a) => { calls.push([name, a]); return have ? { ok: true } : { ok: false, reason: 'missing_item', detail: { worn: 3 } }; } };
        let r = await script.runScript(sc, env);
        assert.deepStrictEqual(calls[0], ['take_usable', { class: 'pickaxe', x: 5, y: 64, z: 5 }]);
        assert.strictEqual(r.ok, false); assert.ok(r.log.some((l) => /no usable pickaxe \(3 worn out\)/.test(l)), r.log.join('|'));
        env.run = async (name, a) => { have = true; return { ok: true, detail: { item: 'iron_pickaxe', left: 200 } }; };
        r = await script.runScript(sc, env); assert.strictEqual(r.ok, true); assert.ok(r.log.some((l) => /took a pickaxe \(iron_pickaxe, 200 uses left\)/.test(l)), r.log.join('|'));
    });

    await test('replace-tool: a chest far above is reached by leaving the pit, the tool is taken there, and the bot is put back where it worked (owner 2026-11-07)', async () => {
        const sites = new Sites([{ name: 'chest', x: 5, y: 64, z: 5, tags: ['tools'] }]);
        let y = -50, got = 0; const calls = [], origin = { x: 3, y: -50, z: 4 };
        const env = { sites, box: { x0: 0, x1: 9, z0: 0, z1: 9, top: 64, bottom: -59 }, here: () => ({ x: 3, y, z: 4 }), pos: () => ({ x: 3, z: 4 }), usableTool: () => (got ? { name: 'iron_pickaxe' } : null), usableCount: () => got,
            inv: () => ({ items: [], slotsFree: 30 }), have: () => 0, canCraft: () => false, exec: async () => ({ ok: true }),
            leavePit: async () => { calls.push('leave'); y = 64; return { ok: true, how: 'pillar', levels: 114 }; },
            run: async (n, a) => { calls.push(`${n}@${y}`); if (y < 60) return { ok: false, reason: 'unreachable' }; got++; return { ok: true, detail: { item: 'iron_pickaxe', left: 240 } }; },
            back: async (o) => { calls.push(`back ${o.x} ${o.y} ${o.z}`); y = o.y; return { ok: true }; } };
        const r = await script.runScript(script.BUILT_IN.get('replace-tool'), env);
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(calls, ['leave', 'take_usable@64', 'take_usable@64', `back ${origin.x} ${origin.y} ${origin.z}`], 'no walk at depth (the chest is 114 levels up): out, take, back');
        assert.ok(r.log.some((l) => /leave pit: pillar \(114 levels\)/.test(l)) && r.log.some((l) => /back to 3 -50 4: ok/.test(l)), r.log.join('|'));
    });

    await test('janitor: a worn-out tool is thrown away as that exact stack, whatever the room; the switch turns it off; no worn tools, no ops', () => {
        const worn = [{ name: 'iron_pickaxe', damage: 235, left: 15 }, { name: 'iron_pickaxe', damage: 243, left: 7 }];
        let ops = janitor.plan([{ name: 'iron_pickaxe', count: 3 }], 30, janitor.pitPolicy(), worn);
        assert.deepStrictEqual(ops.map((o) => [o.op, o.item, o.damage, o.why]), [['toss', 'iron_pickaxe', 235, 'worn_out'], ['toss', 'iron_pickaxe', 243, 'worn_out']]);
        assert.deepStrictEqual(janitor.plan([{ name: 'iron_pickaxe', count: 3 }], 30, janitor.pitPolicy({ discardWorn: false }), worn), []);
        assert.deepStrictEqual(janitor.plan([{ name: 'iron_pickaxe', count: 3 }], 30, janitor.pitPolicy({ discardWorn: () => false }), worn), [], 'a function: the setting applies to running jobs');
        assert.deepStrictEqual(janitor.plan([{ name: 'iron_pickaxe', count: 1 }], 30, janitor.pitPolicy(), []), []);
    });

    await test('janitor.maintain: worn stacks go out of the game by damage, never by a plain toss; without a server console nothing is thrown', async () => {
        const worn = [{ name: 'iron_pickaxe', damage: 235, left: 15 }], cleared = [], execs = [];
        const env = { inv: () => ({ items: [{ name: 'iron_pickaxe', count: 2 }], slotsFree: 30, worn }), exec: async (n, a) => { execs.push(n); return { ok: true }; }, discard: async (item, n, o) => { cleared.push([item, n, o]); return { ok: true }; } };
        let r = await janitor.maintain(env, janitor.pitPolicy()); assert.ok(r.ok); assert.deepStrictEqual(cleared, [['iron_pickaxe', 1, { damage: 235 }]]); assert.deepStrictEqual(execs, []);
        delete env.discard; r = await janitor.maintain(env, janitor.pitPolicy()); assert.ok(r.ok); assert.deepStrictEqual(execs, [], 'no toss that could throw the good pickaxe');
    });

    await test('makeClear: a stack is picked by its wear (item NBT), a bad damage is refused', async () => {
        const sent = []; let have = 2;
        const clear = makeClear({ rcon: async (c) => { sent.push(c); have--; return 'Removed 1 items from player Work1'; }, name: 'Work1', count: () => have, sleep: async () => {} });
        assert.strictEqual((await clear('iron_pickaxe', 1, { damage: 235 })).ok, true);
        assert.strictEqual(sent[0], 'clear Work1 minecraft:iron_pickaxe{Damage:235} 1');
        assert.strictEqual((await clear('iron_pickaxe', 1, { damage: -1 })).reason, 'invalid_args'); assert.strictEqual((await clear('iron_pickaxe', 1, { damage: '1}' })).reason, 'invalid_args');
        await clear('cobblestone', 8); assert.strictEqual(sent[1], 'clear Work1 minecraft:cobblestone 8');
    });

    await test('depot rank: low-value items are thrown away instead of stored; a tagged chest for their kind still takes them; valuable items are never thrown away', () => {
        const items = [{ name: 'cobblestone', count: 64 }, { name: 'dirt', count: 64 }, { name: 'coal', count: 64 }, { name: 'raw_iron', count: 64 }, { name: 'sand', count: 64 }];
        const depot = { kind: 'chest', x: 1, y: 2, z: 3 };
        const kinds = (policy) => Object.fromEntries(janitor.plan(items, 0, policy).map((o) => [o.item, o.op]));
        assert.ok(Object.values(kinds(janitor.pitPolicy({ depot }))).every((o) => o === 'deposit'), 'rank 0: everything that makes room is stored')
        const k10 = kinds(janitor.pitPolicy({ depot, storeMin: 10 }));
        assert.strictEqual(k10.dirt, 'toss'); assert.strictEqual(k10.sand, 'toss'); assert.strictEqual(k10.cobblestone, 'toss');
        const k40 = kinds(janitor.pitPolicy({ depot, storeMin: 40 }));
        assert.ok(k40.coal === undefined || k40.coal === 'deposit', 'coal (40) is stored at rank 40'); assert.ok(!Object.values(k40).includes('toss') || k40.dirt === 'toss');
        const k100 = janitor.plan([{ name: 'raw_iron', count: 64 }, { name: 'dirt', count: 64 }], 0, janitor.pitPolicy({ depot, storeMin: 100, keep: {} }));
        assert.ok(k100.find((o) => o.item === 'raw_iron' && o.op === 'deposit'), 'worth 60 or more is never thrown away, whatever the rank');
        const sites = new Sites([{ name: 'junk', x: 9, y: 9, z: 9, tags: ['junk'] }, { name: 'tools', x: 8, y: 9, z: 9, tags: ['tools'] }]);
        const withJunk = janitor.plan([{ name: 'gravel', count: 64 }], 0, janitor.pitPolicy({ depot, storeMin: 10, sites: () => sites }));
        assert.strictEqual(withJunk[0].op, 'deposit', 'the operator made a junk chest: low value goes there');
        assert.strictEqual(janitor.plan([{ name: 'gravel', count: 64 }], 0, janitor.pitPolicy({ depot, storeMin: 10, sites: () => new Sites([{ name: 'tools', x: 8, y: 9, z: 9, tags: ['tools'] }]) }))[0].op, 'toss', 'a tools chest is not a junk chest');
    });

    await test('pit: a tree block high above the ground is left alone (not tried, not a leftover); low tree blocks and ordinary blocks are dug', async () => {
        const pit = require('../src/work/jobs/pit');
        const cells = new Map(); const set = (x, y, z, n) => cells.set(`${x},${y},${z}`, n);
        for (let y = -64; y <= 63; y++) set(5, y, 5, 'stone');                          // ground to y 63
        for (let y = 64; y <= 80; y++) set(5, y, 5, 'jungle_log'); set(5, 85, 5, 'oak_leaves');      // a trunk and a leaf with air between
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || 'air', kindAt: (x, y, z) => (cells.has(`${x},${y},${z}`) ? 'solid' : 'air') };
        assert.strictEqual(pit.aerialTree(w, { x: 5, y: 66, z: 5 }), false, 'within reach of the ground');
        assert.strictEqual(pit.aerialTree(w, { x: 5, y: 70, z: 5 }), true); assert.strictEqual(pit.aerialTree(w, { x: 5, y: 85, z: 5 }), true);
        assert.strictEqual(pit.aerialTree(w, { x: 5, y: 60, z: 5 }), false, 'stone is never a tree'); assert.strictEqual(pit.aerialTree({ nameAt: () => 'oak_leaves', kindAt: () => 'unknown' }, { x: 0, y: 90, z: 0 }), false, 'not loaded: no verdict');
        // a unit over the tree: the high blocks are skipped without a single mine call, the low one is dug, the unit is ok
        const plan = pit.planPit({ x0: 5, z0: 5, x1: 5, z1: 5, top: 85, bottom: 64 }, { method: 'rows', road: false }), region = plan.regions[0], mined = [];
        const env = { w, have: () => 9, exec: async (n, a) => { if (n === 'mine') { mined.push(a.y); cells.delete(`${a.x},${a.y},${a.z}`); } return { ok: true }; }, here: () => ({ x: 5, y: 64, z: 5 }), pause: async () => {} };
        let skipped = 0, ok = true;
        for (let u = 0; u < region.layers * region.rows; u++) { const r = await pit.runUnit(plan, region, { unit: u }, env); ok = ok && r.ok; skipped += r.detail.skipped || 0; }
        assert.ok(ok); assert.ok(mined.every((y) => y <= 69), `only blocks within reach were dug: ${mined}`); assert.ok(mined.includes(64) && mined.includes(69)); assert.ok(skipped >= 12, `skipped ${skipped}`);
        assert.deepStrictEqual(pit.wrongCells(plan, region, 0, w).filter((c) => c.y >= 70), [], 'the audit does not count them');
    });

    await test('pit: a station far above the bot with no way up is reached by a pillar, then the corridor is dug from that layer (live stall of 2026-11-07)', async () => {
        const pit = require('../src/work/jobs/pit');
        const cells = new Map(); const set = (x, y, z, n) => cells.set(`${x},${y},${z}`, n);
        for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) set(x, 12, z, 'stone');                // the undug layer at y 12; the bot is in a cave 6 below it
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || 'air', kindAt: (x, y, z) => (cells.has(`${x},${y},${z}`) ? 'solid' : 'air') };
        const plan = pit.planPit({ x0: 3, z0: 3, x1: 7, z1: 7, top: 12, bottom: 12 }, { method: 'sweep', road: false, tile: 5 }), region = plan.regions[0], calls = [];
        let pos = { x: 5, y: 6, z: 5 };
        const env = { w, have: () => 9, pause: async () => {}, here: () => ({ ...pos }), temp: new Map(),
            exec: async (n, a) => {
                calls.push(n);
                if (n === 'move_to') return pos.y < 12 ? { ok: false, reason: 'unreachable' } : (pos = { x: a.x, y: a.y, z: a.z }, { ok: true });
                if (n === 'mine') { if (pos.y < 11) return { ok: false, reason: 'unreachable' }; cells.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; }
                return { ok: true };
            },
            run: async (n, a) => { calls.push(`${n}:${a.levels}`); pos = { ...pos, y: pos.y + a.levels }; return { ok: true, detail: { levels: a.levels, last: { x: pos.x, y: pos.y - 1, z: pos.z } } }; } };
        const r = await pit.runUnit(plan, region, { unit: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r)); assert.ok(calls.includes('pillar:6'), calls.join(',')); assert.strictEqual(r.detail.rose, 6);
        assert.ok([...cells.keys()].every((k) => !k.startsWith('5,12,5')) && env.temp.size === 1, 'the station is dug and the pillar block is on the list to be taken away');
    });

    await test('pit: a station far below the bot (the bot stands on its own pillar) is reached by a lift to a standable cell at the layer, not by walking', async () => {
        const pit = require('../src/work/jobs/pit');
        const cells = new Map(); const set = (x, y, z, n) => cells.set(`${x},${y},${z}`, n);
        for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) { set(x, 5, z, 'stone'); set(x, 6, z, 'stone'); }                 // the floor: top at y 6, the layer to dig is y 6
        set(5, 20, 5, 'cobblestone');                                                                                                // the bot's pillar block, 14 above
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || 'air', kindAt: (x, y, z) => (cells.has(`${x},${y},${z}`) ? 'solid' : 'air') };
        const plan = pit.planPit({ x0: 3, z0: 3, x1: 7, z1: 7, top: 6, bottom: 6 }, { method: 'sweep', road: false, tile: 5 }), region = plan.regions[0], calls = [];
        let pos = { x: 5, y: 21, z: 5 };
        const env = { w, have: () => 9, pause: async () => {}, here: () => ({ ...pos }), temp: new Map(),
            exec: async (n, a) => { calls.push(n); if (n === 'move_to') return pos.y > 7 ? { ok: false, reason: 'unreachable' } : (pos = { x: a.x, y: a.y, z: a.z }, { ok: true }); if (n === 'mine') { cells.delete(`${a.x},${a.y},${a.z}`); return { ok: true }; } return { ok: true }; },
            lift: async (S) => { calls.push('lift'); pos = { x: S.x, y: S.y + 1, z: S.z }; return { ok: true, to: pos }; } };
        const r = await pit.runUnit(plan, region, { unit: 0 }, env);
        assert.ok(r.ok, JSON.stringify(r)); assert.ok(calls.includes('lift') && r.detail.lifted === 1, calls.join(','));
    });

    await test('env: a unit is interrupted when the bot is under water with its air low, and not before (drowned twice in the live pit)', () => {
        const { botEnv } = require('../src/work/bot/env');
        const bot = new EventEmitter(); const reg = { blocksByName: {}, itemsByName: {} };
        Object.assign(bot, { username: 'Bot', registry: reg, entity: { position: { x: 0.5, y: 5, z: 0.5, floored: () => ({ x: 0, y: 5, z: 0 }) }, isInWater: true, onGround: false }, oxygenLevel: 20, inventory: { items: () => [] }, setControlState() {}, blockAt: () => null });
        const env = botEnv(bot, { cancel: { cancelled: false } });
        assert.strictEqual(env.unitCancel.cancelled, false, 'full air: go on');
        bot.oxygenLevel = 5; assert.strictEqual(env.unitCancel.cancelled, true, 'in water, air low: stop and surface');
        bot.entity.isInWater = false; assert.strictEqual(env.unitCancel.cancelled, false, 'low air but out of the water: go on');
        bot.entity.isInWater = true; bot.oxygenLevel = 12; assert.strictEqual(env.unitCancel.cancelled, false, 'in water with air to spare: go on');
        const op = { cancelled: false }, e2 = botEnv(bot, { cancel: op }); bot.oxygenLevel = 20; op.cancelled = true; assert.strictEqual(e2.unitCancel.cancelled, true, 'the operator still cancels');
    });

    await test('water rescue: when swimming out fails (flooded bottom), the bot is lifted to the nearest dry standable cell', async () => {
        const water = require('../src/work/bot/water');
        const cells = new Map(); const set = (x, y, z, n) => cells.set(`${x},${y},${z}`, n);
        for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) { set(x, 0, z, 'stone'); for (let y = 1; y <= 4; y++) set(x, y, z, 'water'); }       // a flooded room, 4 deep
        for (let x = 0; x < 6; x++) for (let z = 0; z < 6; z++) set(x, 9, z, 'stone');
        const w = { nameAt: (x, y, z) => cells.get(`${x},${y},${z}`) || 'air', kindAt: (x, y, z) => { const n = cells.get(`${x},${y},${z}`); return n === 'water' ? 'water' : n ? 'solid' : 'air'; } };
        let pos = { x: 2, y: 2, z: 2 }, lifted = null;
        const env = { w, have: () => 0, here: () => ({ ...pos }), exec: async () => ({ ok: false, reason: 'stuck' }), recover: async () => {},
            lift: async (S, o) => { lifted = o; pos = { x: 2, y: 10, z: 2 }; return { ok: true }; } };
        const r = await water.rescue(env, { x0: 0, x1: 5, z0: 0, z1: 5, top: 12, bottom: 0 });
        assert.ok(r.ok && r.lifted, JSON.stringify(r)); assert.ok(lifted && lifted.radius >= 12);
        const env2 = { ...env, lift: undefined }; pos = { x: 2, y: 2, z: 2 };
        const r2 = await water.rescue(env2, { x0: 0, x1: 5, z0: 0, z1: 5, top: 12, bottom: 0 }); assert.strictEqual(r2.reason, 'stuck', 'without a lift the old answer stands');
    });

    await test('leave pit: the ground outside is the highest standable cell around, not the floor of a hole next to the box; a long climb is a lift there (live: a bot was put at y -59)', async () => {
        const { ground, leavePit } = require('../src/work/bot/exit');
        const top = (x, z) => (x === 4 || (x >= 3 && x <= 5 && z >= 3 && z <= 12) ? -5 : 10);          // ground to y 10; the columns west of the box (x 3..5) are a hole down to y -5
        const w = { nameAt: () => 'stone', kindAt: (x, y, z) => (y <= top(x, z) ? 'solid' : 'air') };
        const box = { x0: 6, x1: 12, z0: 3, z1: 12, top: 40, bottom: -20 };
        const g = ground(w, box, { x: 6, z: 7, ox: 5, oz: 7 });                 // the west side: its own columns are the hole, a column a few steps out is not
        assert.ok(g && g.y === 11, JSON.stringify(g));
        let to = null; const pos = { x: 8, y: -4, z: 8 };
        const env = { w, here: () => ({ ...pos }), have: () => 9, exec: async () => ({ ok: false, reason: 'unreachable' }), run: async () => ({ ok: false, reason: 'unreachable' }), recover: async () => {},
            lift: async (S) => { to = S; pos.x = S.x; pos.y = S.y; pos.z = S.z; return { ok: true }; } };
        const r = await leavePit(env, box); assert.ok(r.ok && r.how === 'lifted', JSON.stringify(r)); assert.strictEqual(to.y, 11, 'on the surface');
    });

    await test('env: a tool that cannot break the block it was missing for does not count (stone pickaxe vs deepslate gold ore)', () => {
        const { botEnv } = require('../src/work/bot/env');
        const bot = new EventEmitter();
        const reg = { blocksByName: { deepslate_gold_ore: { harvestTools: { 2: true, 3: true } }, stone: { harvestTools: { 1: true, 2: true, 3: true } }, dirt: {} }, itemsByName: { stone_pickaxe: { id: 1 }, iron_pickaxe: { id: 2 }, diamond_pickaxe: { id: 3 } } };
        let items = [{ name: 'stone_pickaxe', count: 1, maxDurability: 131, durabilityUsed: 10 }];
        Object.assign(bot, { username: 'Bot', registry: reg, entity: { position: { x: 0.5, y: 5, z: 0.5, floored: () => ({ x: 0, y: 5, z: 0 }) }, isInWater: false }, oxygenLevel: 20, inventory: { items: () => items }, setControlState() {}, blockAt: () => null });
        const env = botEnv(bot, { cancel: { cancelled: false } }), senv = Object.assign(Object.create(env), { need: 'deepslate_gold_ore' }), plain = Object.assign(Object.create(env), { need: 'stone' });
        assert.ok(env.usableTool('pickaxe') && plain.usableTool('pickaxe'), 'with no block asked, or stone, a stone pickaxe is a pickaxe');
        assert.strictEqual(senv.usableTool('pickaxe'), null); assert.strictEqual(senv.usableCount('pickaxe'), 0);
        items = [...items, { name: 'iron_pickaxe', count: 1, maxDurability: 250, durabilityUsed: 0 }];
        assert.strictEqual(senv.usableTool('pickaxe').name, 'iron_pickaxe'); assert.strictEqual(senv.usableCount('pickaxe'), 1);
    });

    // ---- service
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtools-'));
    const factory = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 0, y: 70, z: 0 } }, registry: { blocksByName: { stone: { harvestTools: { 7: true } } }, items: { 7: { name: 'iron_pickaxe' } }, itemsByName: { iron_pickaxe: { id: 7 } } }, inventory: { items: () => b.items, slots: [], emptySlotCount: () => 30 }, quit() {} }); b.items = []; setTimeout(() => b.emit('spawn'), 5); return b; };
    const svc = new WorkService({ dataDir: dir, factory, envFactory: () => ({}), display: false });
    svc.addBot('Bot1'); while (svc.status().bots[0].state !== 'online') await sleep(10);
    const rec = svc.bots.get('Bot1');

    await test('service: a worn pickaxe does not end the wait for a pickaxe (the loop of 13 s seen on the play world); a good one does; with retireWorn off any pickaxe does', () => {
        options.configure(rec.bot, { retireWorn: true });
        rec.bot.items = [{ ...tool('iron_pickaxe', 250, 240), count: 1 }];
        assert.strictEqual(svc._canBreak(rec, 'stone'), false);
        rec.bot.items = [tool('iron_pickaxe', 250, 240), tool('iron_pickaxe', 250, 5)];
        assert.strictEqual(svc._canBreak(rec, 'stone'), true);
        options.configure(rec.bot, { retireWorn: false }); rec.bot.items = [tool('iron_pickaxe', 250, 240)];
        assert.strictEqual(svc._canBreak(rec, 'stone'), true);
    });

    await test('service: a depot has a rank 0..100 that reaches the job policy; the discard-worn switch reaches running jobs', () => {
        const j = svc.createPit({ box: { x0: 0, z0: 0, x1: 15, z1: 15, top: 70, bottom: 60 }, depot: { kind: 'chest', x: 3, y: 64, z: 3, minValue: 40 } });
        const job = svc.jobs.get(j.id); assert.strictEqual(job.policy.storeMin, 40); assert.strictEqual(job.spec.depot.minValue, 40);
        assert.throws(() => svc.createPit({ box: { x0: 40, z0: 0, x1: 55, z1: 15, top: 70, bottom: 60 }, depot: { kind: 'chest', x: 3, y: 64, z: 3, minValue: 101 } }), /minValue/);
        assert.strictEqual(job.policy.discardWorn(), true); svc.setSettings({ discardWorn: false }); assert.strictEqual(job.policy.discardWorn(), false);
        const d0 = svc.createPit({ box: { x0: 80, z0: 0, x1: 95, z1: 15, top: 70, bottom: 60 }, depot: { kind: 'chest', x: 3, y: 64, z: 3 } }); assert.strictEqual(svc.jobs.get(d0.id).policy.storeMin, 0, 'no rank given: store everything, as before');
    });
    await svc.stop();

    await test('overlay: the two game rules that keep the particle commands out of the chat are set once, before the first particle', async () => {
        const sent = [];
        const o = new Overlay({ rcon: async (c) => { sent.push(c); return ''; }, state: () => ({ bots: [], lanes: [], tags: [{ name: 'c', x: 1, y: 64, z: 1, machine: false, end: null }] }), config: () => ({ on: true }), humans: async () => [{ name: 'Seia_Y', x: 0, y: 70, z: 0 }], pending: () => 0 });
        await o.frame(100000); await o.frame(200000);
        const rules = sent.filter((c) => c.startsWith('gamerule'));
        assert.deepStrictEqual(rules, ['gamerule sendCommandFeedback false', 'gamerule logAdminCommands false']);
        assert.ok(sent.indexOf(rules[0]) < sent.findIndex((c) => c.startsWith('particle')));
        const off = []; const o2 = new Overlay({ rcon: async (c) => { off.push(c); return ''; }, state: () => ({ bots: [], lanes: [], tags: [] }), config: () => ({ on: true }), humans: async () => [{ name: 'X', x: 0, y: 70, z: 0 }], pending: () => 0, quiet: false });
        await o2.frame(100000); assert.ok(!off.some((c) => c.startsWith('gamerule')), 'quiet: false leaves the rules alone');
    });
    console.log('\ntools: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
