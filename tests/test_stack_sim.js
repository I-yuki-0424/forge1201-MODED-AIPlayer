// The command stack on the physics simulator (no server): the router drives the REAL instructions (mine, move_to, equip) of src/skills on a bot whose client physics is prismarine-physics,
// the same code that moves the live bot; the only server behaviour modelled is the dig (as in test_skills_motion_sim.js). What the live server adds is measured on the copy of the play world
// (scripts/real/, docs/implemented/REAL-WORLD-VERIFICATION-v1.md); this is a smoke test, not that evidence.
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const registry = require('prismarine-registry')('1.20.1');
const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const { execute } = require('../src/skills');
const { fromBot } = require('../src/skills/world');
const { feetCell } = require('../src/skills/motion');
const router = require('../src/stack/router');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }

const state = (name, props = {}) => {
    const b = registry.blocksByName[name];
    const s = Block.fromProperties(b.id, props, 0);
    return s.stateId;
};
const S = { air: state('air'), stone: state('stone'), water: state('water', { level: 0 }), ladderWest: state('ladder', { facing: 'west', waterlogged: false }) };

/** A world of state ids: stone at y <= 0 unless set, air above. */
function scene(cells, { groundTop = 0 } = {}) {
    const key = (x, y, z) => `${x},${y},${z}`;
    const sid = (x, y, z) => cells.get(key(x, y, z)) ?? (y <= groundTop ? S.stone : S.air);
    const getBlock = (p) => { const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z); const b = Block.fromStateId(sid(x, y, z), 0); b.position = new Vec3(x, y, z); return b; };
    const set = (x, y, z, s) => cells.set(key(x, y, z), s);
    return { getBlock, set };
}
const fill = (w, [x0, x1], [y0, y1], [z0, z1], s) => { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.set(x, y, z, s); };

/**
 * A bot with prismarine-physics as its client physics, ticking as fast as the event loop allows. `items` go to the hotbar.
 * The only server behaviour modelled is digging: a finish-dig packet clears the cell and puts its drop in the inventory.
 */
function simBot(world, pos, items = []) {
    const bot = new EventEmitter();
    const controls = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
    const physics = Physics(registry, world);
    Object.assign(bot, {
        version: '1.20.1', registry, food: 20, jumpTicks: 0, jumpQueued: false, quickBarSlot: 0, entities: {},
        entity: { position: pos.clone(), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: false, isInWater: false, attributes: {}, effects: {}, height: 1.8, width: 0.6 },
        inventory: { slots: [], items: () => bot.inventory.slots.slice(9, 45).filter(Boolean) },
        setControlState: (k, v) => { controls[k] = v; }, getControlState: (k) => !!controls[k],
        look: async (y, p) => { bot.entity.yaw = y; bot.entity.pitch = p; },
        setQuickBarSlot: (s) => { bot.quickBarSlot = s; },
        blockAt: (p) => world.getBlock(p),
        _client: { write: (name, d) => {
            if (name !== 'block_dig' || d.status !== 2) return;
            const b = world.getBlock(d.location), drop = b.drops && b.drops[0];
            world.set(d.location.x, d.location.y, d.location.z, S.air);
            const id = drop === undefined ? null : typeof drop === 'object' ? (drop.drop?.id ?? drop.id) : drop;
            if (id !== null && id !== undefined) give(registry.items[id].name);
        } },
        swingArm: () => {}, attack: () => {},
        digTime: (block) => block.digTime(bot.heldItem ? bot.heldItem.type : null, false, false, false, [], {}),
    });
    Object.defineProperty(bot, 'heldItem', { get: () => bot.inventory.slots[36 + bot.quickBarSlot] || null });
    const give = (name) => {
        const s = bot.inventory.slots, have = s.findIndex((i) => i && i.name === name);
        if (have >= 0) { s[have].count++; return; }
        const free = [...Array(36).keys()].map((i) => 36 - 27 + ((i + 27) % 36)).find((i) => !s[i]);
        s[free] = { name, type: registry.itemsByName[name].id, count: 1, slot: free };
    };
    for (const n of items) give(n);
    bot.entity.position.y += 0;
    bot.oxygen = 300; bot.minAir = 300;
    let stop = false;
    const loop = () => {
        if (stop) return;
        physics.simulatePlayer(new PlayerState(bot, controls), { getBlock: (p) => world.getBlock(p) }).apply(bot);
        // Air: lose one per tick with the eye in water (vanilla: 300 ticks of air), refill above it.
        const eye = world.getBlock(bot.entity.position.offset(0, 1.62, 0));
        bot.oxygen = eye.name === 'water' ? bot.oxygen - 1 : 300;
        bot.minAir = Math.min(bot.minAir, bot.oxygen);
        bot.emit('physicsTick');
        setImmediate(loop);
    };
    bot.start = () => setImmediate(loop);
    bot.stop = () => { stop = true; };
    return bot;
}


async function settled(world, from, items) {
    const bot = simBot(world, from, items);
    bot.start();
    await new Promise((r) => { let n = 0; bot.on('physicsTick', function f() { if (++n > 10) { bot.removeListener('physicsTick', f); r(); } }); });
    return bot;
}

/** The router's deps on the real instruction layer. `travel` is a move_to here (the live env.travel adds the chunk-exit router, legs and the movement expert). */
function deps(bot) {
    return {
        bot, w: fromBot(bot), here: () => feetCell(bot.entity.position), cancelled: () => false,
        exec: (n, a, o) => execute(bot, n, a, o),
        travel: (t) => execute(bot, 'move_to', { x: t.x, y: t.y, z: t.z }, {}),
        escape: null,
    };
}

(async () => {
    await test('atomic mine, pickaxe in the pack but not in hand: precondition_failed tool_held, no tick, the hand unchanged', async () => {
        const w = scene(new Map()); w.set(2, 1, 0, S.stone);
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), ['dirt', 'wooden_pickaxe']);
        try {
            const slot = bot.quickBarSlot;
            const r = await execute(bot, 'mine', { x: 2, y: 1, z: 0, collect: false }, { atomic: true });
            assert.deepStrictEqual([r.ok, r.reason, r.ticks], [false, 'precondition_failed', 0], JSON.stringify(r));
            assert.deepStrictEqual(r.detail.unmet, [{ need: 'tool_held', item: 'wooden_pickaxe' }]);
            assert.strictEqual(bot.quickBarSlot, slot, 'nothing was swapped');
        } finally { bot.stop(); }
    });

    await test('atomic mine, block 12 away: precondition_failed in_reach with the distance; the bot has not moved', async () => {
        const w = scene(new Map()); w.set(12, 1, 0, S.stone);
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), ['wooden_pickaxe']);
        try {
            const p0 = bot.entity.position.clone();
            const r = await execute(bot, 'mine', { x: 12, y: 1, z: 0 }, { atomic: true });
            assert.strictEqual(r.reason, 'precondition_failed');
            assert.strictEqual(r.detail.unmet[0].need, 'in_reach');
            assert.ok(r.detail.unmet[0].dist > 10, JSON.stringify(r.detail));
            assert.ok(bot.entity.position.distanceTo(p0) < 0.05, 'it did not walk');
        } finally { bot.stop(); }
    });

    await test('the router: mine a block 25 blocks away with the pickaxe in the pack, not in hand -> move, equip, mine; the block is gone (the real instructions, real physics)', async () => {
        const w = scene(new Map()); w.set(25, 1, 0, S.stone);
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), ['dirt', 'wooden_pickaxe']);
        try {
            const r = await router.run(deps(bot), { name: 'mine', args: { x: 25, y: 1, z: 0, collect: false } });
            assert.strictEqual(r.ok, true, JSON.stringify(r));
            assert.deepStrictEqual(r.detail.router.map((c) => c.do), ['move', 'equip']);
            assert.strictEqual(w.getBlock(new Vec3(25, 1, 0)).name, 'air');
            assert.ok(bot.entity.position.x > 18, `walked: x ${bot.entity.position.x}`);
        } finally { bot.stop(); }
    });

    await test('the router: a block behind a wall 20 blocks off (the aim is blocked from the first standing cell it tries) is reached from another side', async () => {
        const w = scene(new Map()); w.set(20, 1, 0, S.stone);
        fill(w, [18, 18], [1, 3], [-3, 3], S.stone);                  // a wall two blocks west of the target, with no gap across 7 blocks
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), ['wooden_pickaxe']);
        try {
            bot.setQuickBarSlot(0);
            const r = await router.run(deps(bot), { name: 'mine', args: { x: 20, y: 1, z: 0, collect: false } });
            assert.strictEqual(r.ok, true, JSON.stringify(r));
            assert.strictEqual(w.getBlock(new Vec3(20, 1, 0)).name, 'air');
        } finally { bot.stop(); }
    });

    console.log('stack sim: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
