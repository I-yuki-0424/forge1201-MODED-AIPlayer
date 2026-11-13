// The command stack without a server (docs/implemented/COMMAND-STACK-v1.md): the preconditions of the instructions (each decidable from the state alone, with the measured value),
// atomic `execute` (checks first, nothing walks or equips), and the router's rule table (same error, different chain depending on the whole state).
const assert = require('assert');
const Vec3 = require('vec3');
const registry = require('prismarine-registry')('1.20.1');
const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))(registry);
const { unmet, cubeDist } = require('../src/skills/preconditions');
const { execute, REASONS } = require('../src/skills');
const router = require('../src/stack/router');
const { AIM_REACH } = require('../src/skills/motion');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const CUBE = [[0, 0, 0, 1, 1, 1]];
/** A world of named cells for the router's planner: stone at y <= 0 unless set, air above; `kinds` maps names to kinds. */
function fakeWorld(cells = {}) {
    const name = (x, y, z) => cells[`${x},${y},${z}`] || (y <= 0 ? 'stone' : 'air');
    const kinds = { stone: 'solid', air: 'air' };
    return {
        nameAt: name, kindAt: (x, y, z) => kinds[name(x, y, z)], shapesAt: (x, y, z) => (kinds[name(x, y, z)] === 'solid' ? CUBE : []),
        blockAt: (x, y, z) => ({ name: name(x, y, z) }),
    };
}

/** A world of real 1.20.1 block states (so `bestTool` can use the registry's harvestTools and dig times): stone at y <= 0, air above; `at` overrides cells; x > 100 is not loaded. */
function realScene(at = {}) {
    const st = (n) => Block.fromProperties(registry.blocksByName[n].id, {}, 0).stateId;
    const name = (x, y, z) => at[`${x},${y},${z}`] || (y <= 0 ? 'stone' : 'air');
    const block = (x, y, z) => { if (x > 100) return null; const b = Block.fromStateId(st(name(x, y, z)), 0); b.position = new Vec3(x, y, z); return b; };
    return { block, getBlock: (p) => block(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
}
/** A bot that has only what the preconditions read: position, hand, pack, entities, blockAt. `pack`: item names; `held`: the name in hand. */
function fakeBot(scene, pos, { pack = [], held = null, entities = {} } = {}) {
    const stacks = pack.map((n, i) => ({ name: n, type: registry.itemsByName[n].id, count: 1, slot: 36 + i }));
    const bot = { registry, entities, quickBarSlot: 0, entity: { position: pos.clone(), velocity: new Vec3(0, 0, 0), effects: {}, height: 1.8, width: 0.6 },
        inventory: { slots: [], items: () => stacks, selectedItem: null }, blockAt: (p) => scene.getBlock(p) };
    Object.defineProperty(bot, 'heldItem', { get: () => (held ? stacks.find((s) => s.name === held) || null : null) });
    return bot;
}

(async () => {
    await test('mine: the unmet conditions come with the measured value; nothing about stuck, walking or remedies', () => {
        const sc = realScene({ '6,1,0': 'stone' }), bot = fakeBot(sc, new Vec3(0.5, 1, 0.5), { pack: ['dirt', 'wooden_pickaxe'], held: 'dirt' });
        const u = unmet(bot, 'mine', { x: 6, y: 1, z: 0 });
        assert.deepStrictEqual(u.map((x) => x.need), ['in_reach', 'tool_held']);
        assert.ok(u[0].dist > 5 && u[0].dist < 6 && u[0].max === Math.round(AIM_REACH * 100) / 100, JSON.stringify(u[0]));
        assert.strictEqual(u[1].item, 'wooden_pickaxe');
        assert.deepStrictEqual(Object.keys(u[0]).sort(), ['dist', 'max', 'need'], 'no remedy in the answer');
    });

    await test('mine: near and the right tool in hand -> nothing unmet; a fixture-free air cell, an unloaded chunk', () => {
        const sc = realScene({ '2,1,0': 'stone' }), bot = fakeBot(sc, new Vec3(0.5, 1, 0.5), { pack: ['wooden_pickaxe'], held: 'wooden_pickaxe' });
        assert.deepStrictEqual(unmet(bot, 'mine', { x: 2, y: 1, z: 0 }), []);
        assert.deepStrictEqual(unmet(bot, 'mine', { x: 3, y: 1, z: 0 }), [], 'air: the command says invalid_target, it is not a precondition');
        assert.deepStrictEqual(unmet(bot, 'mine', { x: 200, y: 1, z: 0 }), [{ need: 'chunk_loaded', cell: { x: 200, y: 1, z: 0 } }]);
    });

    await test('mine: with a bare hand as the best tool (dirt) nothing has to be held; with no pickaxe at all the command itself says missing_tool', () => {
        const sc = realScene({ '1,1,0': 'dirt', '2,1,0': 'stone' }), bot = fakeBot(sc, new Vec3(0.5, 1, 0.5), { pack: ['cobblestone'], held: 'cobblestone' });
        assert.deepStrictEqual(unmet(bot, 'mine', { x: 1, y: 1, z: 0 }), []);
        assert.deepStrictEqual(unmet(bot, 'mine', { x: 2, y: 1, z: 0 }), [], 'no pickaxe in the pack: not a precondition the router can fix by equipping');
    });

    await test('place: item in the pack but not in hand -> item_held; none in the pack -> left to the command (missing_item); out of reach of every support -> in_reach', () => {
        const sc = realScene(), far = fakeBot(sc, new Vec3(0.5, 1, 0.5), { pack: ['cobblestone'], held: null });
        assert.deepStrictEqual(unmet(far, 'place', { x: 1, y: 1, z: 0, item: 'cobblestone' }).map((x) => x.need), ['item_held']);
        assert.deepStrictEqual(unmet(far, 'place', { x: 1, y: 1, z: 0, item: 'dirt' }), [{ need: 'item_in_pack', item: 'dirt', count: 1 }], 'not in the pack at all: the router gets it');
        const u = unmet(far, 'place', { x: 9, y: 1, z: 0, item: 'cobblestone' }).map((x) => x.need);
        assert.deepStrictEqual(u, ['in_reach', 'item_held']);
        assert.deepStrictEqual(unmet(far, 'place', { x: 200, y: 1, z: 0, item: 'iron_block' }).map((x) => x.need), ['item_in_pack', 'chunk_loaded'], 'a far target and no item: both are said, the item first');
    });

    await test('attack: out of reach and the sword not in hand are both reported; a missing entity is left to the command', () => {
        const sc = realScene(), pig = { id: 7, name: 'pig', type: 'mob', position: new Vec3(8.5, 1, 0.5), width: 0.9, height: 0.9 };
        const bot = fakeBot(sc, new Vec3(0.5, 1, 0.5), { pack: ['iron_sword'], held: null, entities: { 7: pig } });
        assert.deepStrictEqual(unmet(bot, 'attack', { entity: 7 }).map((x) => x.need), ['in_reach', 'tool_held']);
        assert.deepStrictEqual(unmet(bot, 'attack', { entity: 99 }), []);
    });

    await test('atomic execute: precondition_failed before any tick (no frame applied), the unmet list in detail; not atomic: unchanged path', async () => {
        const sc = realScene({ '6,1,0': 'stone' }), bot = fakeBot(sc, new Vec3(0.5, 1, 0.5), { pack: ['wooden_pickaxe'], held: null });
        const r = await execute(bot, 'mine', { x: 6, y: 1, z: 0 }, { atomic: true });
        assert.deepStrictEqual([r.ok, r.reason, r.ticks], [false, 'precondition_failed', 0]);
        assert.deepStrictEqual(r.detail.unmet.map((x) => x.need), ['in_reach', 'tool_held']);
        assert.ok(REASONS.precondition_failed);
        const bad = await execute(bot, 'mine', { x: 6, y: 1 }, { atomic: true });
        assert.strictEqual(bad.reason, 'invalid_args', 'the schema is checked first');
    });

    await test('the tick budget grows with the walk (a fixed 1200 ended a long walk as timeout): move_to 1200 within 5 blocks, 1200 + 14/block beyond, at most 6000', () => {
        const { COMMANDS } = require('../src/skills');
        const bot = { entity: { position: new Vec3(0.5, 1, 0.5) } };
        assert.strictEqual(COMMANDS.move_to.ticks({ x: 3, y: 1, z: 0 }, bot), 1200);
        assert.strictEqual(COMMANDS.move_to.ticks({ x: 105, y: 1, z: 0 }, bot), Math.round(1200 + 14 * (105 - 5 + 0)));
        assert.strictEqual(COMMANDS.place.ticks({ x: 400, y: 1, z: 0 }, bot), 6000);
        assert.strictEqual(COMMANDS.move_to.ticks({ x: 3, y: 1, z: 0 }), 1200, 'no bot: the base');
    });

    // ---- the router ----
    const sandbox = (cells, here, { held = 'wooden_pickaxe', pack = ['wooden_pickaxe'] } = {}) => {
        const s = { here: { ...here }, held, calls: [], w: fakeWorld(cells) };
        s.bot = { entities: {}, entity: { position: new Vec3(here.x + 0.5, here.y, here.z + 0.5) } };
        return s;
    };
    /** Deps whose instructions are scripted: `mine` is ok when the bot is within reach of the block and holds the tool; move_to / equip / unstick change the state. */
    function deps(s, o = {}) {
        const reachOk = (t) => cubeDist({ x: s.here.x + 0.5, y: s.here.y + 1.62, z: s.here.z + 0.5 }, t) <= AIM_REACH;
        return {
            bot: s.bot, w: s.w, here: () => s.here, cancelled: () => !!s.cancelled,
            exec: async (name, args, opt) => {
                s.calls.push([name, opt && opt.atomic ? 'atomic' : 'plain']);
                if (name === 'mine') {
                    const u = [];
                    if (!reachOk(args)) u.push({ need: 'in_reach', dist: 9, max: 4.2 });
                    if (s.held !== 'wooden_pickaxe') u.push({ need: 'tool_held', item: 'wooden_pickaxe' });
                    if (o.extraUnmet) u.push(...o.extraUnmet);
                    return u.length ? { ok: false, reason: 'precondition_failed', detail: { unmet: u } } : { ok: true, detail: { block: 'stone' } };
                }
                if (name === 'move_to') { if (o.moveFails) return { ok: false, reason: 'unreachable', detail: {} }; s.here = { x: args.x, y: args.y, z: args.z }; return { ok: true }; }
                if (name === 'equip') { s.held = args.item; return { ok: true }; }
                return { ok: false, reason: 'internal' };
            },
            travel: async (t) => { s.calls.push(['travel']); s.here = { x: t.x - 2, y: 1, z: t.z }; return { ok: true }; },
            escape: o.noEscape ? null : async () => { s.calls.push(['unstick']); s.here = { x: 20, y: 1, z: 5 }; return { ok: true }; },
        };
    }
    const chainOf = (r) => (r.detail.router || []).map((c) => c.do);
    const STONE_AT = (x, z, y = 1) => ({ [`${x},${y},${z}`]: 'stone' });

    await test('standing cells: for place the cell is air, so the goal is the support it is placed against (reproducer: 14 of 20 real-world place runs found no cell and fell back to travel); a mine target in a pit is reached from the rim', () => {
        const w = fakeWorld({ '8,1,3': 'stone' }), here = { x: 0, y: 1, z: 0 };
        const place = { kind: 'block', name: 'place', x: 8, y: 1, z: 0 }, cells = router.standCells({ w }, place, here);
        assert.ok(cells.length >= 4, `${cells.length} cells`);
        for (const c of cells) assert.ok(!(c.x === 8 && c.z === 0), 'not inside the cell that is filled');
        // a one-block pit: the target is the floor of the pit; the standing cells are on the rim, up to 3 levels above it
        const cp = {}; for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) if (dx || dz) for (const y of [0, 1]) cp[`${10 + dx},${y},${5 + dz}`] = 'stone'; cp['10,0,5'] = 'air';
        const pit = fakeWorld(cp), mineCells = router.standCells({ w: pit }, { kind: 'block', name: 'mine', x: 10, y: -1, z: 5 }, here);
        assert.ok(mineCells.length === 0 || mineCells.every((c) => c.y >= 1), 'rim cells only');
    });

    await test('router: far and free -> move, then the instruction (every instruction call is atomic)', async () => {
        const s = sandbox({ ...STONE_AT(12, 0) }, { x: 0, y: 1, z: 0 }), r = await router.run(deps(s), { name: 'mine', args: { x: 12, y: 1, z: 0 } });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual(chainOf(r), ['move']);
        assert.ok(s.calls.every((c) => c[0] === 'travel' || c[1] === 'atomic'), JSON.stringify(s.calls));
        assert.ok(cubeDist({ x: s.here.x + 0.5, y: s.here.y + 1.62, z: s.here.z + 0.5 }, { x: 12, y: 1, z: 0 }) <= AIM_REACH, 'it moved into reach');
    });

    await test('router: the same error (in_reach) with the bot sealed in -> unstick FIRST, then move, then the instruction: the chain depends on the state, not on the error', async () => {
        // a 1x1 pocket: stone on all four sides, two high, and a roof
        const cells = { ...STONE_AT(12, 0) };
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [1, 2]) cells[`${dx},${y},${dz}`] = 'stone';
        cells['0,3,0'] = 'stone';
        const s = sandbox(cells, { x: 0, y: 1, z: 0 }), r = await router.run(deps(s), { name: 'mine', args: { x: 12, y: 1, z: 0 } });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual(chainOf(r), ['unstick', 'move']);
        assert.ok(r.detail.router[0].region < router.CLOSED, 'the closed region was measured');
    });

    await test('router: a bot in its own tunnel (a small closed region) with a target inside rock is NOT stuck: unreachable, no unstick (reproducer: prospecting dug itself back to the surface)', async () => {
        const cells = { ...STONE_AT(8, 0) };                                       // a block inside solid rock: everything around it is stone
        for (let x = 5; x <= 11; x++) for (let z = -3; z <= 3; z++) for (const y of [1, 2, 3]) cells[`${x},${y},${z}`] = 'stone';
        for (let x = 0; x <= 4; x++) for (const y of [1, 2]) cells[`${x},${y},0`] = 'air';          // the bot's tunnel ends at x=4
        for (let x = 0; x <= 4; x++) for (const z of [-1, 1]) for (const y of [1, 2, 3]) cells[`${x},${y},${z}`] = 'stone';
        for (let x = 0; x <= 4; x++) cells[`${x},3,0`] = 'stone';
        const s = sandbox(cells, { x: 0, y: 1, z: 0 }), r = await router.run(deps(s), { name: 'mine', args: { x: 8, y: 2, z: 0 } });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'unreachable');
        assert.ok(!s.calls.some((c) => c[0] === 'unstick'), JSON.stringify(s.calls));
    });

    await test('router: wrong tool in hand -> equip; far AND wrong tool -> move then equip (the order the owner described), nothing else', async () => {
        let s = sandbox({ ...STONE_AT(3, 0) }, { x: 0, y: 1, z: 0 }, { held: 'dirt' });
        let r = await router.run(deps(s), { name: 'mine', args: { x: 3, y: 1, z: 0 } });
        assert.deepStrictEqual([r.ok, chainOf(r)], [true, ['equip']]);
        s = sandbox({ ...STONE_AT(12, 0) }, { x: 0, y: 1, z: 0 }, { held: 'dirt' });
        r = await router.run(deps(s), { name: 'mine', args: { x: 12, y: 1, z: 0 } });
        assert.deepStrictEqual([r.ok, chainOf(r)], [true, ['move', 'equip']]);
    });

    await test('router: a chunk that is not loaded, or a target beyond FAR, is walked toward in legs (travel) first; a second failure is reported, not repeated', async () => {
        const s = sandbox({}, { x: 0, y: 1, z: 0 }), d = deps(s, { extraUnmet: [{ need: 'chunk_loaded', cell: { x: 90, y: 1, z: 0 } }] });
        const r = await router.run(d, { name: 'mine', args: { x: 90, y: 1, z: 0 } });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.detail.router[0].do, 'travel');
        assert.ok(r.reason === 'unreachable' || r.reason === 'stuck', r.reason);
    });

    await test('router: no progress is never a loop (the same unmet conditions at the same place twice -> gives up with the reason of the last failed step)', async () => {
        const s = sandbox({ ...STONE_AT(12, 0) }, { x: 0, y: 1, z: 0 }), d = deps(s, { moveFails: true });
        const r = await router.run(d, { name: 'mine', args: { x: 12, y: 1, z: 0 } });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'unreachable');
        assert.ok(s.calls.length <= 8, `${s.calls.length} calls`);
    });

    await test('router: failures that are not preconditions pass through untouched (no chain); no stuck-escape expert in the environment -> stuck, said plainly', async () => {
        const s = sandbox({}, { x: 0, y: 1, z: 0 }), d = deps(s);
        d.exec = async () => ({ ok: false, reason: 'missing_tool', detail: { block: 'stone' } });
        const r = await router.run(d, { name: 'mine', args: { x: 2, y: 1, z: 0 } });
        assert.deepStrictEqual([r.ok, r.reason, r.detail.router], [false, 'missing_tool', undefined]);
        const cells = { ...STONE_AT(12, 0), '0,3,0': 'stone' };
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (const y of [1, 2]) cells[`${dx},${y},${dz}`] = 'stone';
        const s2 = sandbox(cells, { x: 0, y: 1, z: 0 }), r2 = await router.run(deps(s2, { noEscape: true }), { name: 'mine', args: { x: 12, y: 1, z: 0 } });
        assert.strictEqual(r2.ok, false);
        assert.strictEqual(r2.reason, 'stuck');
    });

    await test('router: an unknown unmet condition has no rule and says so; cancel between attempts ends it as cancelled', async () => {
        const s = sandbox({}, { x: 0, y: 1, z: 0 }), r = await router.run(deps(s, { extraUnmet: [{ need: 'weather' }] }), { name: 'mine', args: { x: 1, y: 1, z: 0 } });
        assert.deepStrictEqual([r.ok, r.reason], [false, 'invalid_args']);
        const s2 = sandbox({}, { x: 0, y: 1, z: 0 }); s2.cancelled = true;
        assert.strictEqual((await router.run(deps(s2), { name: 'mine', args: { x: 1, y: 1, z: 0 } })).reason, 'cancelled');
    });

    await test('service: the operator\'s mine / place / ... go through env.command (the router); other commands, rawCommands and an environment without a router go straight to the instruction layer', async () => {
        const { CommandsPart } = require('../src/work/service/commands'), skills = require('../src/skills'), orig = skills.execute, direct = [], routed = [], disposed = [];
        skills.execute = async (b, n) => { direct.push(n); return { ok: true }; };
        try {
            const self = (raw, withCommand = true) => ({ settings: { rawCommands: raw }, envFactory: () => ({ ...(withCommand ? { command: async (n) => { routed.push(n); return { ok: true }; } } : {}), dispose: () => disposed.push(1) }) });
            const rec = { bot: {} }, call = (me, name) => CommandsPart.prototype._command.call(me, rec, {}, name, { x: 1, y: 2, z: 3 });
            await call(self(false), 'mine'); await call(self(false), 'place'); await call(self(false), 'eat'); await call(self(true), 'mine'); await call(self(false, false), 'mine');
            assert.deepStrictEqual(routed, ['mine', 'place']);
            assert.deepStrictEqual(direct, ['eat', 'mine', 'mine']);
            assert.strictEqual(disposed.length, 2, 'the environment of a routed command is disposed');
        } finally { skills.execute = orig; }
    });

    await test('layout kind fill: a solid box (the backfill of a pit): every cell, heights up to 256, cells and counts as the box says, and the limits still hold', () => {
        const { layout } = require('../src/work/jobs/layout');
        const L = layout({ kind: 'fill', block: 'cobblestone', x0: 0, z0: 0, x1: 15, z1: 15, y: -59, height: 140 });
        assert.strictEqual(L.count, 16 * 16 * 140);
        assert.deepStrictEqual(L.size, [16, 140, 16]);
        assert.strictEqual(new Set(L.cells.map((c) => `${c.x},${c.y},${c.z}`)).size, L.count, 'no cell twice');
        assert.throws(() => layout({ kind: 'fill', block: 'cobblestone', x0: 0, z0: 0, x1: 15, z1: 15, y: -59, height: 257 }), /height: 1..256/);
        assert.throws(() => layout({ kind: 'fill', block: 'cobblestone', x0: 0, z0: 0, x1: 31, z1: 31, y: 0, height: 64 }), /too many/);
        assert.throws(() => layout({ kind: 'wall', block: 'cobblestone', x0: 0, z0: 0, x1: 3, z1: 0, y: 0, height: 65 }), /height: 1..64/, 'other kinds keep 64');
    });

    await test('router: an item that is not in the pack -> obtain FIRST (then position and hand are read again), and the chain says what the goal layer did', async () => {
        const s = sandbox({ ...STONE_AT(3, 0) }, { x: 0, y: 1, z: 0 }, { held: 'wooden_pickaxe' }); let got = null;
        const d = deps(s); const base = d.exec;
        let have = false;
        d.exec = async (name, args, opt) => { if (name === 'place') { s.calls.push(['place']); return have ? { ok: true, detail: {} } : { ok: false, reason: 'precondition_failed', detail: { unmet: [{ need: 'item_in_pack', item: 'iron_block', count: 1 }] } }; } return base(name, args, opt); };
        d.obtain = async (item, n) => { got = [item, n]; have = true; return { ok: true, detail: { steps: ['craft iron_block: ok'] } }; };
        const r = await router.run(d, { name: 'place', args: { x: 3, y: 1, z: 0, item: 'iron_block' } });
        assert.deepStrictEqual([r.ok, got, chainOf(r)], [true, ['iron_block', 1], ['obtain']], JSON.stringify(r));
        assert.deepStrictEqual(r.detail.router[0].steps, ['craft iron_block: ok']);
        // no goal layer in the environment: said plainly, no loop
        const s2 = sandbox({}, { x: 0, y: 1, z: 0 }), d2 = deps(s2); d2.exec = async () => ({ ok: false, reason: 'precondition_failed', detail: { unmet: [{ need: 'item_in_pack', item: 'iron_block', count: 1 }] } });
        const r2 = await router.run(d2, { name: 'place', args: { x: 3, y: 1, z: 0, item: 'iron_block' } });
        assert.strictEqual(r2.ok, false); assert.strictEqual(r2.reason, 'missing_item');
    });

    await test('goal layer: planks from any log, a crafting table placed when none is near, iron blocks crafted from ingots, stone smelted from cobblestone with fuel (a fake bot; the order of the steps)', async () => {
        const { obtain } = require('../src/stack/obtain'), { Recipe } = require(require.resolve('prismarine-recipe', { paths: [require.resolve('mineflayer')] }))(registry);
        const inv = { oak_log: 2, iron_ingot: 9, cobblestone: 8 }, steps = [], reg = registry;
        const bot = { registry: reg, inventory: { items: () => Object.entries(inv).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })) }, findBlock: () => null,
            recipesAll: (id) => Recipe.find(id, null) };
        const world = fakeWorld(), placed = [];
        const deps = { bot, w: world, here: () => ({ x: 0, y: 1, z: 0 }), cancelled: () => false,
            command: async (name, a) => { steps.push(`${name} ${a.item}`); placed.push(a.item); inv[a.item] -= 1; bot.findBlock = () => ({ position: { x: a.x, y: a.y, z: a.z } }); return { ok: true }; },
            exec: async (name, a) => {
                steps.push(`${name} ${a.item}${a.x !== undefined ? ' @station' : ''}`);
                if (name === 'craft') { const r = Recipe.find(reg.itemsByName[a.item].id, null)[0]; for (const d of r.delta) { const nm = reg.items[d.id].name; inv[nm] = (inv[nm] || 0) + d.count * Math.ceil(a.count / r.result.count); } }
                if (name === 'smelt') { inv[a.item] -= a.count; inv.stone = (inv.stone || 0) + a.count; inv.coal -= 1; }
                return { ok: true, detail: {} };
            },
            gather: async () => ({ ok: false, reason: 'unreachable', detail: {} }) };
        const r = await obtain(deps, 'iron_block', 1);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.ok(steps.some((x) => x.startsWith('place crafting_table')), `a table was placed: ${steps.join(' | ')}`);
        assert.ok(steps.findIndex((x) => x.startsWith('craft crafting_table')) < steps.findIndex((x) => x.startsWith('place crafting_table')), 'the table is crafted before it is placed');
        assert.ok(steps.some((x) => x === 'craft iron_block @station'), 'the iron block is crafted at the table');
        // smelting: stone from cobblestone needs a furnace and fuel; with no fuel and nothing to gather it says so
        const inv2 = { cobblestone: 8 }; const bot2 = { ...bot, inventory: { items: () => Object.entries(inv2).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: reg.itemsByName[name].id })) } };
        const r2 = await obtain({ ...deps, bot: bot2 }, 'stone', 4);
        assert.strictEqual(r2.ok, false); assert.ok(['missing_materials', 'unreachable', 'invalid_target'].includes(r2.reason), r2.reason);
    });

    await test('exploration: out on rings until the thing is near; prospecting digs a staircase down to the ore level, tunnels, looks again every few steps and gives back where the shaft began', async () => {
        const ex = require('../src/stack/explore');
        let pos = { x: 0, y: 70, z: 0 }, stops = 0;
        const d = { here: () => ({ ...pos }), cancelled: () => false, travel: async (t) => { pos = { ...pos, x: t.x, z: t.z }; stops++; return { ok: true }; } };
        const r = await ex.surface(d, () => stops >= 11);
        assert.deepStrictEqual([r.found, r.stops.length], [true, 11]);
        assert.ok(r.stops.every((q, i) => i < 8 ? q.ring === 80 : q.ring === 160), 'rings of 80 then 160');
        assert.strictEqual((await ex.surface({ ...d, travel: async () => ({ ok: false, reason: 'died' }) }, () => false)).why, 'died');
        const cmds = []; pos = { x: 5, y: 70, z: 5 };
        const p = { here: () => ({ ...pos }), cancelled: () => false, command: async (n, a) => { cmds.push(a.dy); if (a.dy < 0) pos.y -= 1; return { ok: true }; } };
        const got = await ex.prospect(p, () => cmds.filter((x) => x === 0).length >= 6, 16);
        assert.strictEqual(got.found, true); assert.strictEqual(got.stairs, 54); assert.strictEqual(got.tunnel, 6); assert.deepStrictEqual(got.entry, { x: 5, y: 70, z: 5 });
        // refused steps (water, lava) turn the heading instead of stopping
        pos = { x: 0, y: 20, z: 0 }; let n = 0;
        const q = await ex.prospect({ ...p, command: async (nm, a) => (a.dir === 'north' && n++ < 3 ? { ok: false, reason: 'invalid_target', detail: { why: 'fluid behind' } } : { ok: true }) }, () => false, 16, { maxTunnel: 6 });
        assert.ok(q.fails.length >= 1 && q.tunnel > 0, JSON.stringify(q));       // the refusal turned the heading, the tunnel went on
    });

    await test('prospecting: "nothing to dig (a walk)" is free ground, walked, not a refusal (reproducer: acceptance world 4, a tunnel that met a cave ended after six of them)', async () => {
        const ex = require('../src/stack/explore'); let pos = { x: 0, y: 20, z: 0 }; const walks = [];
        const d = { here: () => ({ ...pos }), cancelled: () => false,
            command: async (nm, a) => (a.dir === 'north' ? { ok: false, reason: 'invalid_target', detail: { why: 'nothing to dig (a walk)' } } : { ok: false, reason: 'invalid_target', detail: { why: 'fluid behind' } }),
            exec: async (nm, a) => { walks.push([a.x, a.y, a.z]); pos = { x: a.x, y: a.y, z: a.z }; return { ok: true }; } };
        const r = await ex.prospect(d, () => false, 20, { maxTunnel: 12 });
        assert.strictEqual(r.tunnel, 12, JSON.stringify(r)); assert.ok(walks.length === 12 && walks.every((w, i) => w[2] === -(i + 1)), JSON.stringify(walks.slice(0, 3)));
        assert.strictEqual(r.fails.length, 0, 'no refusal was counted');
    });

    await test('prospecting heads for ore it can see (the axis it is furthest along, a stair when it lies two levels off) instead of a blind heading', async () => {
        const ex = require('../src/stack/explore'); let pos = { x: 0, y: 20, z: 0 }; const seen = [];
        const d = { here: () => ({ ...pos }), cancelled: () => false, nearest: async () => ({ x: 9, y: 24, z: -3 }),
            command: async (nm, a) => { seen.push([a.dir, a.dy]); const v = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] }[a.dir]; pos = { x: pos.x + v[0], y: pos.y + a.dy, z: pos.z + v[1] }; return { ok: true }; } };
        await ex.prospect(d, () => false, 20, { maxTunnel: 6 });
        assert.deepStrictEqual(seen[0], ['east', 1], JSON.stringify(seen)); assert.ok(seen.every((q) => q[0] === 'east' || q[0] === 'north'), JSON.stringify(seen));
    });

    await test('the routed set is exactly the six instructions the router has rules for', () => {
        assert.deepStrictEqual([...router.ROUTED].sort(), ['activate', 'attack', 'mine', 'pickup', 'place', 'tunnel']);
    });

    console.log('stack: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
