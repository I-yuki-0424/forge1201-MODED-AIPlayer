'use strict';
// set_contents (src/skills/commands/container.js, TASK-20261125-076) without a server: the real instruction on a bot whose client physics is the NATIVE
// physics (src/native/physics), against a modelled server that keeps the container and the pack itself, applies every click with the game's rules,
// answers a wrong prediction with set_slot corrections (as the 1.21.1 server does) and a state id of -1 with the full window contents. Also: the
// argument schema, the preconditions and the router's chain for it. A smoke test; the evidence is the server-graded test (scripts/native/container_a.js).
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const nbt = require('prismarine-nbt');
const { world } = require('./native_world');
const { Physics } = require('../src/native/physics');
const PP = require('prismarine-physics');
const N = require('../src/native/inventory');
const { execute, validateArgs } = require('../src/skills');
const { unmet } = require('../src/skills/preconditions');
const router = require('../src/stack/router');
const { fromBot } = require('../src/skills/world');
const { feetCell } = require('../src/skills/motion');

const VERSION = '1.21.1';
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };

/** The modelled server's side of one container: its slots, the window protocol, and the player's 36 slots (window-0 indices 9..44). */
function server(bot, w, at, type, size, { refuseFirst = false } = {}) {
    const reg = bot.registry, Item = require('prismarine-item')(reg), items = N.itemsOf(reg);
    const box = Array(size).fill(null);
    let menu = null, stateId = 0, refused = !refuseFirst;
    const pack = () => { for (let k = 0; k < 36; k++) { const s = menu.slots[menu.L.invStart + k]; bot.inventory.slots[9 + k] = s ? { name: s.name, type: s.id, count: s.count, slot: 9 + k } : null; } };
    const wire = (s) => Item.toNotch(s ? new Item(s.id, s.count) : null);
    const full = () => bot._client.emit('window_items', { windowId: 1, stateId: ++stateId, items: menu.slots.map(wire), carriedItem: wire(menu.carried) });
    bot._client.on('write', (name, d) => {
        if (name === 'block_place' && d.location.x === at.x && d.location.y === at.y && d.location.z === at.z) {
            const stacks = [...box];
            for (let k = 0; k < 36; k++) { const s = bot.inventory.slots[9 + k]; stacks[size + k] = s ? items.stack(s.name, s.count) : null; }
            menu = new N.Menu(type, items, stacks);
            bot._client.emit('open_window', { windowId: 1, inventoryType: N.MENUS.indexOf(type), windowTitle: '' });
            full();
        } else if (name === 'window_click' && menu && d.windowId === 1) {
            if (d.stateId === -1) { full(); return; }
            if (!refused) { refused = true; full(); return; }                           // a mod that eats the first click: the server's state wins
            menu.click(d.slot, d.mouseButton, d.mode);
            const claimed = new Map(d.changedSlots.map((c) => [c.location, c.item]));
            for (let i = 0; i < menu.slots.length; i++) {
                const s = menu.slots[i], c = claimed.has(i) ? claimed.get(i) : undefined;
                if (c === undefined) continue;
                const cc = c && c.itemCount > 0 ? c : null;
                if ((!s && cc) || (s && (!cc || cc.itemCount !== s.count || cc.itemId !== s.id))) bot._client.emit('set_slot', { windowId: 1, stateId: ++stateId, slot: i, item: wire(s) });
            }
        } else if (name === 'close_window' && menu) {
            for (let i = 0; i < size; i++) box[i] = menu.slots[i];
            pack(); menu = null;
        }
    });
    return { box, signal: () => N.signalOf(box.filter(Boolean).map((s) => ({ item: s.name, count: s.count })), size, (x) => reg.itemsByName[x].stackSize) };
}

/** A bot on flat ground whose client physics is the native one, ticking as fast as the event loop allows. */
function simBot(w, pos, pack) {
    const reg = w.registry, bot = new EventEmitter();
    const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
    const physics = Physics(reg);
    const client = new EventEmitter();
    client.write = (name, d) => client.emit('write', name, d);
    Object.assign(bot, {
        version: VERSION, registry: reg, food: 20, jumpTicks: 0, jumpQueued: false, quickBarSlot: 0, entities: {}, game: { gameMode: 'survival', dimension: 'overworld', minY: -64 },
        entity: { position: pos.clone(), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: false, isInWater: false, attributes: {}, effects: {}, height: 1.8, width: 0.6 },
        inventory: { slots: [], items: () => bot.inventory.slots.slice(9, 45).filter(Boolean) },
        setControlState: (k, v) => { controls[k] = v; }, getControlState: (k) => !!controls[k],
        look: async (y, p) => { bot.entity.yaw = y; bot.entity.pitch = p; },
        setQuickBarSlot: (s) => { bot.quickBarSlot = s; },
        blockAt: (p) => w.getBlock(p),
        _client: client, swingArm: () => {}, attack: () => {}, activateItem: () => {}, deactivateItem: () => {},
        currentWindow: null, closeWindow: () => { client.write('close_window', { windowId: 1 }); bot.currentWindow = null; },
    });
    Object.defineProperty(bot, 'heldItem', { get: () => bot.inventory.slots[36 + bot.quickBarSlot] || null });
    let k = 9;
    for (const [name, count] of pack) bot.inventory.slots[k++] = { name, type: reg.itemsByName[name].id, count, slot: k - 1 };
    let stop = false;
    const loop = () => {
        if (stop) return;
        physics.simulatePlayer(new PP.PlayerState(bot, controls), { getBlock: (p) => w.getBlock(p) }).apply(bot);
        bot.emit('physicsTick');
        setImmediate(loop);
    };
    bot.start = () => setImmediate(loop);
    bot.stop = () => { stop = true; };
    return bot;
}
async function settled(w, pos, pack) {
    const bot = simBot(w, pos, pack); bot.start();
    await new Promise((r) => { let k = 0; bot.on('physicsTick', function f() { if (++k > 10) { bot.removeListener('physicsTick', f); r(); } }); });
    return bot;
}
const count = (bot, name) => bot.inventory.slots.reduce((a, s) => a + (s && s.name === name ? s.count : 0), 0);

console.log('native container instruction');
(async () => {
    await test('schema: contents or signal + item, slots once each, counts 1..99', () => {
        validateArgs('set_contents', { x: 1, y: 2, z: 3, contents: [{ slot: 0, item: 'cobblestone', count: 18 }], exact: true });
        validateArgs('set_contents', { x: 1, y: 2, z: 3, signal: 3, item: 'cobblestone' });
        for (const bad of [{ contents: [] }, { contents: [{ slot: 0, item: 'dirt', count: 1 }, { slot: 0, item: 'dirt', count: 2 }] }, { contents: [{ slot: 0, item: 'dirt', count: 0 }] },
            { signal: 16, item: 'dirt' }, { signal: 2 }, { contents: [{ slot: 0, item: 'dirt', count: 1 }], signal: 1, item: 'dirt' }]) {
            assert.throws(() => validateArgs('set_contents', { x: 1, y: 2, z: 3, ...bad }), /invalid_args/, JSON.stringify(bad));
        }
    });
    await test('preconditions: in reach of the container, the goal\'s items in the pack (a signal counts by the block\'s size: barrel 3 = 247 cobblestone)', async () => {
        const w = world(VERSION).floor(0).set(9, 1, 0, 'barrel', { facing: 'up' }).set(1, 1, 0, 'hopper', { facing: 'down' });
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), [['cobblestone', 64]]);
        try {
            const far = unmet(bot, 'set_contents', { x: 9, y: 1, z: 0, signal: 3, item: 'cobblestone' });
            assert.deepStrictEqual(far.map((u) => u.need).sort(), ['in_reach', 'item_in_pack']);
            assert.strictEqual(far.find((u) => u.need === 'item_in_pack').count, 247);
            assert.deepStrictEqual(unmet(bot, 'set_contents', { x: 1, y: 1, z: 0, contents: [{ slot: 0, item: 'cobblestone', count: 18 }] }), []);
            const r = await execute(bot, 'set_contents', { x: 9, y: 1, z: 0, signal: 3, item: 'cobblestone' }, { atomic: true });
            assert.deepStrictEqual([r.reason, r.ticks], ['precondition_failed', 0]);
        } finally { bot.stop(); }
    });
    await test('router: set_contents far away with too few items -> obtain (the goal\'s total) first, then move; the same rules as activate', async () => {
        const w = world(VERSION).floor(0).set(9, 1, 0, 'hopper', { facing: 'down' });
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), [['cobblestone', 5]]);
        try {
            assert.ok(router.ROUTED.has('set_contents'));
            const goal = { name: 'set_contents', args: { x: 9, y: 1, z: 0, contents: [{ slot: 0, item: 'cobblestone', count: 18 }] } };
            const deps = { bot, w: fromBot(bot), here: () => feetCell(bot.entity.position) };
            const d = await router.decide(deps, goal, unmet(bot, goal.name, goal.args), { travelled: 0, escaped: 0 });
            assert.deepStrictEqual(d.steps.map((s) => s.do), ['obtain', 'move']);
            assert.deepStrictEqual([d.steps[0].item, d.steps[0].count], ['cobblestone', 18]);
        } finally { bot.stop(); }
    });
    await test('a sorter\'s filter hopper (18 cobblestone + 4 x 1 stick, the dirt in it taken out): set from the pack, graded from the server\'s window contents; comparator 1', async () => {
        const w = world(VERSION).floor(0).set(2, 1, 0, 'hopper', { facing: 'down' });
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), [['cobblestone', 40], ['stick', 10]]);
        const srv = server(bot, w, { x: 2, y: 1, z: 0 }, 'hopper', 5);
        srv.box[3] = N.itemsOf(bot.registry).stack('dirt', 2);
        try {
            const contents = [{ slot: 0, item: 'cobblestone', count: 18 }, ...[1, 2, 3, 4].map((s) => ({ slot: s, item: 'stick', count: 1 }))];
            const r = await execute(bot, 'set_contents', { x: 2, y: 1, z: 0, contents, exact: true }, { atomic: true });
            assert.strictEqual(r.ok, true, JSON.stringify({ reason: r.reason, detail: r.detail, phases: r.phases }));
            assert.deepStrictEqual(srv.box.map((s) => (s ? `${s.name}x${s.count}` : '-')), ['cobblestonex18', 'stickx1', 'stickx1', 'stickx1', 'stickx1']);
            assert.strictEqual(srv.signal(), 1);
            assert.deepStrictEqual([count(bot, 'cobblestone'), count(bot, 'stick'), count(bot, 'dirt')], [22, 6, 2], 'the pack gave exactly that and got the dirt');
        } finally { bot.stop(); }
    });
    await test('a barrel at comparator strength 3 (247 cobblestone), with a server that drops the first click: the instruction re-plans from the server\'s state', async () => {
        const w = world(VERSION).floor(0).set(2, 1, 0, 'barrel', { facing: 'up' });
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), [['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64]]);
        const srv = server(bot, w, { x: 2, y: 1, z: 0 }, 'generic_9x3', 27, { refuseFirst: true });
        try {
            const r = await execute(bot, 'set_contents', { x: 2, y: 1, z: 0, signal: 3, item: 'cobblestone', exact: true }, { atomic: true });
            assert.strictEqual(r.ok, true, JSON.stringify({ reason: r.reason, detail: r.detail }));
            assert.strictEqual(srv.signal(), 3);
            assert.strictEqual(srv.box.reduce((a, s) => a + (s ? s.count : 0), 0), 247);
            assert.ok(r.phases.some((p) => p.phase === 'replan'), 'it planned again from the server\'s state');
            assert.strictEqual(count(bot, 'cobblestone'), 256 - 247);
        } finally { bot.stop(); }
    });
    await test('blueprint block entity -> the goal: the Items of a litematic tile entity give the same contents list', () => {
        const be = nbt.comp({ id: nbt.string('minecraft:hopper'), Items: nbt.list(nbt.comp([{ Slot: nbt.byte(0), id: nbt.string('minecraft:cobblestone'), count: nbt.int(18) }, ...[1, 2, 3, 4].map((s) => ({ Slot: nbt.byte(s), id: nbt.string('minecraft:stick'), count: nbt.int(1) }))])) });
        assert.deepStrictEqual(N.fromBlockEntity(be).map(({ slot, item, count: c }) => ({ slot, item, count: c })), [{ slot: 0, item: 'cobblestone', count: 18 }, ...[1, 2, 3, 4].map((s) => ({ slot: s, item: 'stick', count: 1 }))]);
    });
    await test('the build job\'s hook on the test blueprint (tests/fixtures/sorter-cell.litematic): two containers with their Items in world cells, their materials', () => {
        const lit = require('../src/work/jobs/litematic');
        const bp = lit.toBlueprint(lit.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures/sorter-cell.litematic'))));
        const goals = N.blueprintContainers(bp, { x: 100, y: 64, z: -5 });
        assert.deepStrictEqual(goals.map((g) => [g.block, g.x, g.y, g.z, g.args.contents.length, g.args.exact]), [['hopper', 100, 65, -5, 5, true], ['barrel', 100, 65, -2, 4, true]]);
        for (const g of goals) validateArgs('set_contents', g.args);
        assert.deepStrictEqual(N.containerMaterials(bp), [{ item: 'cobblestone', n: 265 }, { item: 'stick', n: 4 }]);
        const ms = (x) => require('prismarine-registry')(VERSION).itemsByName[x].stackSize;
        assert.deepStrictEqual(goals.map((g) => N.signalOf(g.args.contents, g.block === 'hopper' ? 5 : 27, ms)), [1, 3], 'the comparators of the blueprint read 1 and 3');
    });
    console.log(`native container instruction: ${n} passed`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
