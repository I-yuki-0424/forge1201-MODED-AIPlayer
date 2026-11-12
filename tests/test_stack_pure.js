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
        assert.deepStrictEqual(unmet(far, 'place', { x: 1, y: 1, z: 0, item: 'dirt' }), []);
        const u = unmet(far, 'place', { x: 9, y: 1, z: 0, item: 'cobblestone' }).map((x) => x.need);
        assert.deepStrictEqual(u, ['in_reach', 'item_held']);
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

    await test('the routed set is exactly the six instructions the router has rules for', () => {
        assert.deepStrictEqual([...router.ROUTED].sort(), ['activate', 'attack', 'mine', 'pickup', 'place', 'tunnel']);
    });

    console.log('stack: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
