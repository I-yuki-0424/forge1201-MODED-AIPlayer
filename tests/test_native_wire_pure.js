'use strict';
// The native parts wired under a mineflayer-shaped bot (TASK-20261125-076): dig time against prismarine-block's on every block and tool of 1.21.1 (the only
// differences must be the game's float sum), the inventory facade (mineflayer's window objects kept equal to the native client, the cursor corrections
// mineflayer drops applied, transfer / deposit on the native click), wire() (physics, dig and inventory switched in at login, each switch back honoured,
// the server told when the physics stops a sprint) and the body inputs that replace bot.dig / placeBlock / activateBlock.
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const reg = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(reg);
const Item = require('prismarine-item')(reg);
const dig = require('../src/native/dig');
const native = require('../src/native');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('native wiring');
(async () => {
    await test('dig time: every block x 18 tools of 1.21.1 within two ticks of prismarine-block (an exact 1.0 is instant in doubles, 2 ticks in floats); each difference is float vs double arithmetic (the game sums float progress)', () => {
        const tools = [null, ...['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'].flatMap((m) => [`${m}_pickaxe`, `${m}_axe`, `${m}_shovel`]), 'shears', 'iron_sword', 'iron_hoe'].slice(0, 18);
        let same = 0, longer = 0, shorter = 0; const other = [];
        for (const b of reg.blocksArray) {
            const blk = Block.fromStateId(b.defaultState, 0);
            for (const t of tools) {
                const held = t ? new Item(reg.itemsByName[t].id, 1) : null;
                const nat = dig.destroy(reg, blk, { held, onGround: true });
                const pri = blk.digTime(held ? held.type : null, false, false, false, [], {});
                const pt = pri === Infinity ? Infinity : pri / 50;
                if (nat.ticks === pt) { same++; continue; }
                if (!(Math.abs(nat.ticks - pt) <= 2)) { other.push(`${b.name}/${t}: native ${nat.ticks} prismarine ${pt}`); continue; }
                // the game: float progress (getDestroyProgress is float maths) added as floats until >= 1; prismarine: ceil(1 / progress) in doubles
                let acc = Math.fround(0), k = 0; while (acc < 1) { acc = Math.fround(acc + nat.progress); k++; }
                assert.strictEqual(k, nat.ticks, `${b.name}/${t}`);
                if (nat.ticks > pt) longer++; else shorter++;
            }
        }
        assert.deepStrictEqual(other.slice(0, 10), []);
        assert.ok(same > 10000, `same ${same}`);
        console.log(`        (${same} equal; float arithmetic: ${longer} one tick longer, ${shorter} one tick shorter than prismarine)`);
    });
    await test('dig time: efficiency in the 1.21 item-component shape, haste, mining fatigue, under water, in the air', () => {
        const stone = Block.fromStateId(reg.blocksByName.stone.defaultState, 0);
        const pick = new Item(reg.itemsByName.diamond_pickaxe.id, 1);
        const base = dig.destroy(reg, stone, { held: pick, onGround: true }).ticks;          // 8 x / 1.5 / 30 = 0.1778 per tick -> 6
        assert.strictEqual(base, 6);
        const eff = Object.assign(Object.create(Object.getPrototypeOf(pick)), pick); Object.defineProperty(eff, 'enchants', { value: { levels: { 'minecraft:efficiency': 5 } } });
        assert.strictEqual(dig.destroy(reg, stone, { held: eff, onGround: true }).ticks, 2, 'efficiency V diamond on stone: (8 + 26) / 1.5 / 30 = 0.756 per tick');
        const haste = { [reg.effectsByName.Haste.id]: { amplifier: 1 } }, fat = { [reg.effectsByName.MiningFatigue.id]: { amplifier: 0 } };
        assert.strictEqual(dig.destroy(reg, stone, { held: pick, onGround: true, effects: haste }).ticks, 5);
        assert.strictEqual(dig.destroy(reg, stone, { held: pick, onGround: true, effects: fat }).ticks, 19);
        assert.strictEqual(dig.destroy(reg, stone, { held: pick, onGround: true, eyeInWater: true }).ticks, 29, 'under water: /5');
        assert.strictEqual(dig.destroy(reg, stone, { held: pick, onGround: false }).ticks, 29, 'in the air: /5');
        assert.strictEqual(dig.destroy(reg, Block.fromStateId(reg.blocksByName.bedrock.defaultState, 0), { held: pick, onGround: true }).ticks, Infinity);
    });

    // ---- the inventory facade ----------------------------------------------------------------------------------------------------
    function fakeBot() {
        const W = require('prismarine-windows')('1.21.1');
        const bot = new EventEmitter(), client = new EventEmitter(), sent = [];
        client.write = (name, p) => sent.push({ name, p });
        Object.assign(bot, { registry: reg, version: '1.21.1', _client: client, inventory: W.createWindow(0, 'minecraft:inventory', 'Inventory'), currentWindow: null,
            clickWindow: async () => { throw new Error('mineflayer click used'); }, transfer: async () => { throw new Error('mineflayer transfer used'); }, putAway: null, moveSlotItem: null, putSelectedItemRange: null,
            openBlock: async () => { const w = W.createWindow(2, 'minecraft:generic_9x3', 'Chest', 27); bot.currentWindow = w; return w; }, supportFeature: () => true, updateHeldItem: () => {} });
        return { bot, client, sent, W };
    }
    const wire = (name, c) => Item.toNotch(name ? new Item(reg.itemsByName[name].id, c) : null);
    await test('facade: clicks go through the native client (changed slots sent) and mineflayer\'s window shows the result; a cursor correction mineflayer drops is applied', async () => {
        const { bot, client, sent } = fakeBot();
        require('../src/native/inventory/mineflayer').install(bot);
        const items = Array.from({ length: 46 }, (_, i) => wire(i === 36 ? 'dirt' : null, 10));
        client.emit('window_items', { windowId: 0, stateId: 4, items, carriedItem: wire(null) });
        bot.inventory.updateSlot(36, new Item(reg.itemsByName.dirt.id, 10));                 // mineflayer's own handler would have done this
        await bot.clickWindow(36, 1, 0);                                                    // right: half up
        assert.deepStrictEqual([sent[0].name, sent[0].p.stateId, sent[0].p.changedSlots.map((c) => c.location)], ['window_click', 4, [36]]);
        assert.deepStrictEqual([bot.inventory.slots[36].count, bot.inventory.selectedItem.count], [5, 5]);
        client.emit('set_slot', { windowId: -1, stateId: 5, slot: -1, item: wire('dirt', 4) });
        assert.strictEqual(bot.inventory.selectedItem.count, 4, 'the server\'s cursor');
    });
    await test('facade: a chest opened through openBlock deposits and withdraws with the native click (mineflayer\'s transfer strategy)', async () => {
        const { bot, client, sent } = fakeBot();
        require('../src/native/inventory/mineflayer').install(bot);
        const win = await bot.openBlock({});
        client.emit('open_window', { windowId: 2, inventoryType: 2, windowTitle: '' });
        const items = Array.from({ length: 63 }, (_, i) => wire(i === 27 ? 'cobblestone' : null, 40));
        client.emit('window_items', { windowId: 2, stateId: 1, items, carriedItem: wire(null) });
        win.updateSlot(27, new Item(reg.itemsByName.cobblestone.id, 40));
        await win.deposit(reg.itemsByName.cobblestone.id, null, 25);
        const chestCount = win.slots.slice(0, 27).reduce((a, s) => a + (s ? s.count : 0), 0);
        assert.strictEqual(chestCount, 25); assert.strictEqual(win.slots[27].count, 15); assert.strictEqual(win.selectedItem, null);
        assert.ok(sent.every((s) => s.name === 'window_click') && sent.length >= 3, `${sent.length} clicks`);
        await win.withdraw(reg.itemsByName.cobblestone.id, null, 5);
        assert.strictEqual(win.slots.slice(0, 27).reduce((a, s) => a + (s ? s.count : 0), 0), 20);
    });

    // ---- wire() ------------------------------------------------------------------------------------------------------------------
    await test('wire: native by default only on Fabric 1.21.1 (mineflayer\'s physics, clicks, dig time elsewhere); NATIVE_*=1 / =0 switch each at login; a sprint the physics refuses is told to the server', async () => {
        const PP = require('prismarine-physics');
        const mk = () => { const f = fakeBot(); const ctl = {}; Object.assign(f.bot, { physics: { simulatePlayer: () => null }, getControlState: (k) => !!ctl[k], setControlState: (k, v) => { ctl[k] = v; f.client.write('entity_action', { actionId: v ? 'start_sprinting' : 'stop_sprinting' }); }, entity: { id: 7 }, digTime: () => 'mineflayer', game: { gameMode: 'survival' } }); return f; };
        const b = mk(); native.wire(b.bot); b.bot.emit('login'); await sleep(5);
        assert.deepStrictEqual(b.bot.__native.done, { physics: false, inventory: false, dig: false }); assert.strictEqual(b.bot.digTime(), 'mineflayer');
        // the default by platform and version: on only where it was compared (Fabric 1.21.1); =0 / =1 override
        const plat = process.env.MC_PLATFORM;
        const at = async (platform, version, env = {}) => { process.env.MC_PLATFORM = platform; Object.assign(process.env, env); const f = mk(); f.bot.version = version; native.wire(f.bot); f.bot.emit('login'); await sleep(5); for (const k of Object.keys(env)) delete process.env[k]; return f.bot.__native.done; };
        assert.deepStrictEqual(await at('fabric', '1.21.1'), { physics: true, inventory: true, dig: true }, 'Fabric 1.21.1: native by default');
        assert.deepStrictEqual(await at('fabric', '1.21.1', { NATIVE_PHYSICS: '0' }), { physics: false, inventory: true, dig: true }, '=0 switches one part back');
        assert.deepStrictEqual(await at('forge', '1.20.1'), { physics: false, inventory: false, dig: false }, 'Forge 1.20.1 (the play console): mineflayer by default');
        assert.deepStrictEqual(await at('fabric', '26.1.2'), { physics: false, inventory: false, dig: false }, '26.1.2: mineflayer by default');
        assert.deepStrictEqual(await at('forge', '1.20.1', { NATIVE_DIG: '1' }), { physics: false, inventory: false, dig: true }, '=1 switches one part in anywhere');
        assert.strictEqual(native.enabled('inputs', { version: '1.21.1' }), false, 'MC_PLATFORM forge left over: no');
        process.env.MC_PLATFORM = 'fabric'; assert.strictEqual(native.enabled('inputs', { version: '1.21.1' }), true);
        if (plat === undefined) delete process.env.MC_PLATFORM; else process.env.MC_PLATFORM = plat;
        process.env.NATIVE_PHYSICS = '1'; process.env.NATIVE_INVENTORY = '1'; process.env.NATIVE_DIG = '1';
        const a = mk(); native.wire(a.bot); a.bot.emit('login'); await sleep(5);
        delete process.env.NATIVE_PHYSICS; delete process.env.NATIVE_INVENTORY; delete process.env.NATIVE_DIG;
        assert.deepStrictEqual(a.bot.__native.done, { physics: true, inventory: true, dig: true });
        assert.notStrictEqual(a.bot.digTime(Block.fromStateId(reg.blocksByName.stone.defaultState, 0)), 'mineflayer');
        // a hungry bot (food 6): the key says sprint, the physics does not sprint -> stop_sprinting goes out
        const w = require('./native_world').world('1.21.1').floor(0);
        a.bot.setControlState('sprint', true); a.bot.setControlState('forward', true); a.sent.length = 0;
        Object.assign(a.bot, { food: 6, usingHeldItem: false, version: '1.21.1', jumpTicks: 0, jumpQueued: false, fireworkRocketDuration: 0,
            entity: { id: 7, position: new Vec3(0.5, 1, 0.5), velocity: new Vec3(0, 0, 0), onGround: true, yaw: 0, pitch: 0, effects: {}, attributes: {} } });
        a.bot.physics.simulatePlayer(new PP.PlayerState(a.bot, { forward: true, sprint: true }), w);
        assert.deepStrictEqual(a.sent.filter((s) => s.name === 'entity_action').map((s) => s.p.actionId), ['stop_sprinting']);
    });

    // ---- body inputs instead of mineflayer's helpers ---------------------------------------------------------------------------------
    await test('inputs: digCell holds attack on the block\'s face until the server clears it; placeAgainst clicks the face and waits for the block', async () => {
        const blocks = new Map([['0,0,0', 'stone'], ['1,0,0', 'stone']]);
        const bot = new EventEmitter(), ctl = {}, sent = [];
        const at = (p) => { const k = `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; const b = Block.fromStateId(reg.blocksByName[blocks.get(k) || 'air'].defaultState, 0); b.position = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)); return b; };
        Object.assign(bot, { registry: reg, blockAt: at, getControlState: (k) => !!ctl[k], setControlState: (k, v) => { ctl[k] = v; }, swingArm: () => {}, heldItem: null, quickBarSlot: 0, entity: { position: new Vec3(0.5, 1, 0.5), onGround: true, yaw: 0, pitch: 0, effects: {} },
            inventory: { slots: [] }, game: { gameMode: 'survival' },
            _client: { write: (name, d) => { sent.push([name, d.status, d.direction]); if (name === 'block_dig' && d.status === 2) blocks.delete(`${d.location.x},${d.location.y},${d.location.z}`); if (name === 'block_place') blocks.set(`${d.location.x},${d.location.y + 1},${d.location.z}`, 'dirt'); } } });
        bot.digTime = dig.botDigTime(bot);
        const ticker = setInterval(() => bot.emit('physicsTick'), 5);
        try {
            const r = await require('../src/skills/inputs').digCell(bot, { x: 0, y: 0, z: 0 }, { face: 1, maxMs: 3000 });
            assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(blocks.has('0,0,0'), false);
            assert.ok(r.ticks >= 150, `bare hand on stone takes 150 ticks: ${r.ticks}`);
            assert.deepStrictEqual(sent.filter((s) => s[0] === 'block_dig').map((s) => s[1]).filter((v, i, a) => a.indexOf(v) === i), [0, 2]);
            const ok = await require('../src/skills/inputs').placeAgainst(bot, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 300);
            assert.ok(ok); assert.deepStrictEqual(sent.filter((s) => s[0] === 'block_place').map((s) => s[2]), [1]);
        } finally { clearInterval(ticker); }
    });
    console.log(`native wiring: ${n} passed`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
