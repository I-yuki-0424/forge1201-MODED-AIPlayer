// Swimming and ladders, end to end without a server: the real move_to command (runner, body, planner, walker) drives a bot
// whose client physics is prismarine-physics itself, the same code that moves the live bot, on synthetic worlds built from
// real 1.20.1 block states (water levels, ladder facings). What the server would add (it accepts the client's positions) is
// not modelled; the live check is scripts/skills/bench.js. Reproducers: before swimming/ladders every scene here ended
// `unreachable` (no plan through water or up a ladder).
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const registry = require('prismarine-registry')('1.20.1');
const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const { execute } = require('../src/skills');

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
    // Let the body settle on the ground first, as after a spawn.
    await new Promise((r) => { let n = 0; bot.on('physicsTick', function f() { if (++n > 10) { bot.removeListener('physicsTick', f); r(); } }); });
    return bot;
}

async function moveTo(world, from, to, maxTicks = 1500) {
    const bot = await settled(world, from);
    try {
        const r = await execute(bot, 'move_to', to, { maxTicks });
        const p = bot.entity.position;
        return { ...r, end: [p.x, p.y, p.z].map((v) => Math.round(v * 100) / 100), minAir: bot.minAir, moves: [...new Set((r.phases || []).filter((x) => x.phase === 'walk').flatMap(() => []))] };
    } finally { bot.stop(); }
}

(async () => {
    await test('a 60-block straight walk arrives without a single no-progress replan (reproducer: progress never counted)', async () => {
        // motion.walk started every plan with best = +Infinity, so `progress > best` never held: a replan every 30 ticks
        // and `stuck` after the 6th, i.e. every walk longer than about 9 s failed whatever the terrain.
        const r = await moveTo(scene(new Map()), new Vec3(0.5, 1, 0.5), { x: 60, y: 1, z: 0 });
        assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} end ${r.end}`);
        assert.strictEqual(r.phases.filter((p) => p.phase === 'replan').length, 0, 'replans');
    });

    await test('swim across a 6-wide, 3-deep pool and climb out onto the far bank (no way around)', async () => {
        const w = scene(new Map());
        fill(w, [3, 8], [-2, 0], [-3, 3], S.water);
        fill(w, [-1, 12], [1, 3], [-4, -4], S.stone); fill(w, [-1, 12], [1, 3], [4, 4], S.stone);   // closed corridor
        fill(w, [-1, -1], [1, 3], [-4, 4], S.stone); fill(w, [12, 12], [1, 3], [-4, 4], S.stone);
        const r = await moveTo(w, new Vec3(0.5, 1, 0.5), { x: 11, y: 1, z: 0 });
        assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} end ${r.end}`);
        assert.ok(r.minAir > 200, `held under water too long: air ${r.minAir}/300`);
        assert.ok(r.ticks < 600, `took ${r.ticks} ticks`);
        assert.ok(r.phases.some((p) => p.phase === "walk" && p.cells.some(([x, y]) => x >= 3 && x <= 8 && y === 0)), 'the plan went through the water');
    });

    await test('walk off a 3-high bank into deep water, swim, climb out on a bank one above the surface', async () => {
        const w = scene(new Map());
        fill(w, [-3, 2], [1, 3], [-4, 4], S.stone);                  // high bank: stand at y=4
        fill(w, [3, 8], [-3, 0], [-4, 4], S.water);                  // pool, surface cells at y=0
        fill(w, [-3, 12], [1, 6], [-5, -5], S.stone); fill(w, [-3, 12], [1, 6], [5, 5], S.stone);   // closed: no way round
        fill(w, [12, 12], [1, 6], [-5, 5], S.stone);
        const r = await moveTo(w, new Vec3(0.5, 4, 0.5), { x: 10, y: 1, z: 0 });
        assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} end ${r.end}`);
        assert.ok(r.minAir > 200, `air ${r.minAir}`);
    });

    await test('climb a 5-high ladder onto the ledge at its top', async () => {
        const w = scene(new Map());
        fill(w, [3, 6], [1, 5], [-2, 2], S.stone);                    // block 5 high: its top is the ledge (stand at y=6)
        fill(w, [2, 2], [1, 5], [0, 0], S.ladderWest);                 // ladder on its west face
        const r = await moveTo(w, new Vec3(0.5, 1, 0.5), { x: 4, y: 6, z: 0 });
        assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} end ${r.end}`);
        assert.ok(r.ticks < 300, `took ${r.ticks} ticks`);
    });

    await test('step off the ledge into the ladder and climb down to the ground', async () => {
        const w = scene(new Map());
        fill(w, [3, 6], [1, 5], [-2, 2], S.stone);
        fill(w, [2, 2], [1, 5], [0, 0], S.ladderWest);
        fill(w, [-3, 1], [1, 3], [-1, -1], S.stone); fill(w, [-3, 1], [1, 3], [1, 1], S.stone);   // walls: no jump-off route but the ladder... (drop from 5 is refused anyway)
        const r = await moveTo(w, new Vec3(4.5, 6, 0.5), { x: 0, y: 1, z: 0 });
        assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} end ${r.end}`);
        assert.ok(r.ticks < 300, `took ${r.ticks} ticks`);
    });

    await test('a pool with no bank to climb out on ends unreachable, without drowning or swimming in circles', async () => {
        const w = scene(new Map());
        fill(w, [3, 8], [-2, 0], [-3, 3], S.water);
        fill(w, [9, 9], [1, 4], [-3, 3], S.stone);                    // far side: a 4-high wall
        fill(w, [10, 12], [1, 4], [-3, 3], S.stone);
        fill(w, [0, 11], [1, 5], [-4, -4], S.stone); fill(w, [0, 11], [1, 5], [4, 4], S.stone);
        const r = await moveTo(w, new Vec3(0.5, 1, 0.5), { x: 10, y: 5, z: 0 });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, 'unreachable');
        assert.ok(r.ticks < 300, `${r.ticks} ticks`);
        assert.ok(r.minAir > 200, `air ${r.minAir}`);
    });

    await test('tunnel: three stair steps down and a corridor step through stone, then walk back up the stairs', async () => {
        const w = scene(new Map(), { groundTop: 0 });
        fill(w, [-3, 8], [1, 4], [-3, 3], S.stone);                   // solid rock above the ground too: all digging
        fill(w, [-1, 1], [5, 5], [-1, 1], S.stone);
        fill(w, [0, 0], [5, 6], [0, 0], S.air);                        // the bot's own shaft cell at y 5..6, standing on y 4
        const bot = await settled(w, new Vec3(0.5, 5, 0.5), ['stone_pickaxe']);
        try {
            const steps = [['east', -1], ['east', -1], ['east', -1], ['east', 0]];
            for (const [dir, dy] of steps) {
                const r = await execute(bot, 'tunnel', { dir, dy });
                assert.strictEqual(r.ok, true, `${dir} ${dy}: ${r.reason} ${JSON.stringify(r.detail)}`);
            }
            const p = bot.entity.position;
            assert.deepStrictEqual([Math.floor(p.x), Math.floor(p.y + 0.2), Math.floor(p.z)], [4, 2, 0]);
            const cobble = bot.inventory.items().find((i) => i.name === 'cobblestone');
            assert.ok(cobble && cobble.count >= 9, `cobblestone ${cobble && cobble.count}`);
            const back = await execute(bot, 'move_to', { x: 0, y: 5, z: 0 }, { maxTicks: 600 });
            assert.strictEqual(back.ok, true, `back up: ${back.reason} ${JSON.stringify(back.detail)}`);
        } finally { bot.stop(); }
    });

    await test('tunnel refuses to open a cell next to water, and needs a floor', async () => {
        const w = scene(new Map(), { groundTop: 0 });
        fill(w, [1, 1], [1, 2], [0, 0], S.stone);
        w.set(2, 1, 0, S.water);                                       // behind the cell to dig
        const bot = await settled(w, new Vec3(0.5, 1, 0.5), ['stone_pickaxe']);
        try {
            const r = await execute(bot, 'tunnel', { dir: 'east', dy: 0 });
            assert.deepStrictEqual([r.ok, r.reason, r.detail.why], [false, 'invalid_target', 'fluid behind']);
            assert.strictEqual(w.getBlock(new Vec3(1, 1, 0)).name, 'stone', 'nothing was dug');
            const up = await execute(bot, 'tunnel', { dir: 'west', dy: 1 });
            assert.deepStrictEqual([up.ok, up.detail.why], [false, 'no floor to stand on']);
        } finally { bot.stop(); }
    });

    await test('a swim target is reached from the cell above or below in its column (the feet bob while the bot holds jump)', () => {
        const { cellGoal } = require('../src/skills/motion');
        const t = { x: 5, y: 62, z: -9 }, swim = cellGoal(t, 't', { swim: true }), land = cellGoal(t, 't');
        for (const dy of [-1, 0, 1]) assert.ok(swim.isGoal({ x: 5, y: 62 + dy, z: -9 }), `swim goal at dy ${dy}`);
        assert.ok(!swim.isGoal({ x: 5, y: 64, z: -9 }) && !swim.isGoal({ x: 6, y: 62, z: -9 }), 'two levels off or the next column is not the goal');
        assert.ok(land.isGoal(t) && !land.isGoal({ x: 5, y: 61, z: -9 }), 'a standing target stays exact (a cell below is a different floor)');
    });

    console.log('all motion simulation tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
