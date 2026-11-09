// The work layer's own movements (src/work/moves.js) and the options of the action layer's `mine`, end to end without a server, on
// prismarine-physics like test_skills_motion_sim.js. The simulated server refuses what the real one refuses and the work layer
// relies on: a block placed into the player's own box, and a dig beyond 6 blocks from the eye; it does NOT check line of sight (vanilla).
// Live check: scripts/work/pit_live.js on a disposable server.
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const registry = require('prismarine-registry')('1.20.1');
const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))(registry);
const { Physics, PlayerState } = require('prismarine-physics');
const { execute } = require('../src/skills');
const skillOpts = require('../src/skills/options');
const { runMove } = require('../src/work/bot/moves');

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
        refused: [], placed: [], dug: [], version: '1.20.1', registry, food: 20, jumpTicks: 0, jumpQueued: false, quickBarSlot: 0, entities: {},
        entity: { position: pos.clone(), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: false, isInWater: false, attributes: {}, effects: {}, height: 1.8, width: 0.6 },
        inventory: { slots: [], items: () => bot.inventory.slots.slice(9, 45).filter(Boolean) },
        setControlState: (k, v) => { controls[k] = v; }, getControlState: (k) => !!controls[k],
        look: async (y, p) => { bot.entity.yaw = y; bot.entity.pitch = p; },
        setQuickBarSlot: (s) => { bot.quickBarSlot = s; },
        blockAt: (p) => world.getBlock(p),
        _client: { write: (name, d) => {
            if (name === 'block_place') {
                const F = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][d.direction];
                const c = { x: d.location.x + F[0], y: d.location.y + F[1], z: d.location.z + F[2] }, p = bot.entity.position, held = bot.heldItem;
                const into = p.x + 0.3 > c.x && p.x - 0.3 < c.x + 1 && p.z + 0.3 > c.z && p.z - 0.3 < c.z + 1 && p.y + 1.8 > c.y && p.y < c.y + 1;
                if (!held || into || world.getBlock(new Vec3(c.x, c.y, c.z)).name !== 'air') { bot.refused.push({ place: c, into }); return; }
                world.set(c.x, c.y, c.z, registry.blocksByName[held.name].defaultState);
                if (--held.count <= 0) bot.inventory.slots[36 + bot.quickBarSlot] = bot.inventory.slots[36 + bot.quickBarSlot] === held ? null : bot.inventory.slots[36 + bot.quickBarSlot];
                bot.placed.push(c); return;
            }
            if (name !== 'block_dig' || d.status !== 2) return;
            const eye = bot.entity.position.offset(0, 1.62, 0);
            if (Math.hypot(eye.x - (d.location.x + 0.5), eye.y - (d.location.y + 0.5), eye.z - (d.location.z + 0.5)) > 6) { bot.refused.push({ dig: d.location, far: true }); return; }
            bot.dug.push({ x: d.location.x, y: d.location.y, z: d.location.z });
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


const cobble = registry.blocksByName.cobblestone.defaultState;
async function ready(world, from, items) {
    const bot = simBot(world, from, items);
    bot.start();
    await new Promise((r) => { let n = 0; bot.on('physicsTick', function f() { if (++n > 10) { bot.removeListener('physicsTick', f); r(); } }); });
    for (const it of bot.inventory.slots) if (it && it.name === 'cobblestone') it.count = 12;
    return bot;
}

(async () => {
    await test('pillar: 6 levels up on cobblestone, each block two below the feet broken without a line of sight, one block left under the feet', async () => {
        const w = scene(new Map());
        const bot = await ready(w, new Vec3(0.5, 1, 0.5), ['stone_pickaxe', 'cobblestone']);
        try {
            const r = await runMove(bot, 'pillar', { levels: 6 });
            assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} refused ${JSON.stringify(bot.refused)}`);
            const p = bot.entity.position;
            assert.strictEqual(Math.floor(p.y), 7, `feet y ${p.y}`);
            assert.deepStrictEqual(bot.refused, [], 'the simulated server refused nothing: no block placed into the body, no dig out of reach');
            const solid = [1, 2, 3, 4, 5, 6].filter((y) => w.getBlock(new Vec3(0, y, 0)).name !== 'air');
            assert.deepStrictEqual(solid, [6], 'only the block under the feet is left');
            assert.strictEqual(bot.dug.length, 5, 'five blocks taken away blind (the first one stays on the ground it started on)');
            assert.ok(r.ticks < 6 * 60, `${r.ticks} ticks for 6 levels`);
            assert.strictEqual(r.detail.levels, 6);
        } finally { bot.stop(); }
    });

    await test('pillar: no head room, no solid floor, or no block to stack are named failures, not hangs', async () => {
        const w = scene(new Map()); w.set(0, 3, 0, registry.blocksByName.stone.defaultState);      // ceiling two above the feet's head cell
        const bot = await ready(w, new Vec3(0.5, 1, 0.5), ['stone_pickaxe', 'cobblestone']);
        try {
            const r = await runMove(bot, 'pillar', { levels: 3 });          // a block overhead is broken first (owner 2026-11-07), then the climb goes on
            assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)}`); assert.strictEqual(w.get ? true : true, true);
        } finally { bot.stop(); }
        const wh = scene(new Map()); wh.set(0, 3, 0, registry.blocksByName.stone.defaultState);
        const bh = await ready(wh, new Vec3(0.5, 1, 0.5), ['dirt']);          // no pickaxe: the stone above is broken by hand (owner 2026-11-07), the climb goes on
        try { const r = await runMove(bh, 'pillar', { levels: 3 }); assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)}`); } finally { bh.stop(); }
        const wb = scene(new Map()); wb.set(0, 3, 0, registry.blocksByName.bedrock.defaultState);
        const bn = await ready(wb, new Vec3(0.5, 1, 0.5), ['dirt']);          // bedrock cannot be broken: the failure is named
        try {
            const r = await runMove(bn, 'pillar', { levels: 3 });
            assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'invalid_target'); assert.ok(/head room/.test(r.detail.why), JSON.stringify(r.detail));
        } finally { bn.stop(); }
        const b2 = await ready(scene(new Map()), new Vec3(0.5, 1, 0.5), ['stone_pickaxe']);
        try { const r = await runMove(b2, 'pillar', { levels: 2 }); assert.strictEqual(r.reason, 'missing_item'); } finally { b2.stop(); }
        const b3 = await ready(scene(new Map()), new Vec3(0.5, 1, 0.5), ['cobblestone']);
        try {
            const r = await runMove(b3, 'pillar', { levels: 3 });                // no pickaxe: the blocks below are broken by hand (slow), the same routine as with a pickaxe
            assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)}`); assert.strictEqual(Math.floor(b3.entity.position.y), 4);
            const col = [1, 2, 3].map((y) => b3.blockAt(new Vec3(0, y, 0)).name);            // without a pickaxe the lower blocks are broken BY HAND: the same routine, one block left under the feet (owner 2026-11-07)
            assert.ok(col.filter((n) => n === 'cobblestone').length <= 1, `column ${col}`);
        } finally { b3.stop(); }
    });

    await test('pillar: no block to stack inside a pit box: one is taken from the undug part beside the bot (owner 2026-11-09); outside the box, or without the box, it is still missing_item', async () => {
        const mkw = () => { const w = scene(new Map()); for (const y of [1, 2, 3, 4]) w.set(1, y, 0, registry.blocksByName.stone.defaultState); return w; };
        const box = { x0: -4, x1: 4, z0: -4, z1: 4, top: 10, bottom: -5 };
        const b1 = await ready(mkw(), new Vec3(0.5, 1, 0.5), ['stone_pickaxe']);          // a pickaxe and nothing to stack
        try {
            const r = await runMove(b1, 'pillar', { levels: 2, within: box });
            assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} refused ${JSON.stringify(b1.refused)}`);
            assert.ok(b1.dug.some((d) => d.x === 1 && d.z === 0), `a block beside the bot was dug: ${JSON.stringify(b1.dug)}`); assert.strictEqual(Math.floor(b1.entity.position.y), 3);
        } finally { b1.stop(); }
        const b2 = await ready(mkw(), new Vec3(0.5, 1, 0.5), ['stone_pickaxe']);
        try { const r = await runMove(b2, 'pillar', { levels: 2 }); assert.strictEqual(r.reason, 'missing_item', 'without the box nothing is dug for blocks'); assert.deepStrictEqual(b2.dug, []); } finally { b2.stop(); }
        const b3 = await ready(mkw(), new Vec3(0.5, 1, 0.5), ['stone_pickaxe']);
        try { const r = await runMove(b3, 'pillar', { levels: 2, within: { ...box, x0: -4, x1: 0 } }); assert.strictEqual(r.reason, 'missing_item', 'the block beside it lies outside the box'); assert.deepStrictEqual(b3.dug, []); assert.ok(r.detail.harvest && r.detail.harvest.tried === 0); } finally { b3.stop(); }
        const wf = mkw(); wf.set(1, 0, 0, registry.blocksByName.water.defaultState); for (const y of [1, 2, 3, 4]) wf.set(2, y, 0, registry.blocksByName.water.defaultState);        // water behind the only candidate: not dug
        const b4 = await ready(wf, new Vec3(0.5, 1, 0.5), ['stone_pickaxe']);
        try { const r = await runMove(b4, 'pillar', { levels: 1, within: box }); assert.strictEqual(r.reason, 'missing_item'); assert.deepStrictEqual(b4.dug, [], 'a block next to water is left alone'); } finally { b4.stop(); }
    });

    await test('mine: blind digs the block behind another within reach and refuses one out of reach; collect:false leaves the drop', async () => {
        const w = scene(new Map());
        w.set(0, 1, 0, cobble); w.set(0, 2, 0, cobble);         // two stacked blocks; the bot stands beside, looking at the upper one
        const bot = await ready(w, new Vec3(2.5, 1, 0.5), ['stone_pickaxe']);
        try {
            const far = await execute(bot, 'mine', { x: 0, y: 2, z: 0, blind: true });          // 2.5 away: fine
            assert.strictEqual(far.ok, true, `${far.reason} ${JSON.stringify(far.detail)}`);
            assert.ok(far.phases.some((p) => p.phase === 'dig_blind'));
            const none = bot.inventory.items().filter((i) => i.name === 'cobblestone').length;
            assert.strictEqual(none, 1, 'a normal mine collects the drop (the sim hands it over at the break)');
            w.set(20, 1, 0, cobble);
            const tooFar = await execute(bot, 'mine', { x: 20, y: 1, z: 0, blind: true });
            assert.strictEqual(tooFar.reason, 'not_visible'); assert.ok(/too far/.test(tooFar.detail.why));
            const before = bot.dug.length; w.set(0, 1, 0, cobble);
            const nc = await execute(bot, 'mine', { x: 0, y: 1, z: 0, collect: false });
            assert.strictEqual(nc.ok, true, `${nc.reason}`); assert.strictEqual(bot.dug.length, before + 1);
        } finally { bot.stop(); }
    });

    await test('worn tools: with retireWorn a stack at the reserve is not used (the fresh one is), and only worn ones give missing_tool with `worn`; off = old behaviour', async () => {
        const w = scene(new Map()); w.set(0, 1, 0, registry.blocksByName.stone.defaultState); w.set(0, 1, 1, registry.blocksByName.stone.defaultState);
        const bot = await ready(w, new Vec3(1.5, 1, 0.5), ['stone_pickaxe']);
        try {
            const pick = bot.inventory.items().find((i) => i.name === 'stone_pickaxe');
            pick.maxDurability = 131; pick.durabilityUsed = 125;                                         // 6 uses left: under max(8, 6 % of 131)
            assert.strictEqual(skillOpts.isWorn(bot, pick), false, 'off by default: RL and every other caller are unchanged');
            skillOpts.configure(bot, { retireWorn: true });
            assert.strictEqual(skillOpts.isWorn(bot, pick), true);
            const r = await execute(bot, 'mine', { x: 0, y: 1, z: 0 });
            assert.strictEqual(r.reason, 'missing_tool'); assert.strictEqual(r.detail.worn, 'stone_pickaxe', 'says that a worn tool is the reason');
            skillOpts.configure(bot, { retireWorn: false });                                              // the switch is reversible
            const r2 = await execute(bot, 'mine', { x: 0, y: 1, z: 0 });
            assert.strictEqual(r2.ok, true, `${r2.reason}`);
            skillOpts.configure(bot, { retireWorn: true });
            const fresh = { ...pick, durabilityUsed: 10, slot: 37, count: 1 }; bot.inventory.slots[37] = fresh;    // a second pickaxe, barely used
            const r3 = await execute(bot, 'mine', { x: 0, y: 1, z: 1 });
            assert.strictEqual(r3.ok, true, `${r3.reason} ${JSON.stringify(r3.detail)}`);
            assert.strictEqual(bot.heldItem && bot.heldItem.durabilityUsed, 10, 'the fresh stack is in the hand');
        } finally { bot.stop(); }
    });

    await test('mine: a cobweb is broken by hand when no sword or shears are at hand (the cell is what the pit needs); stone without a pickaxe is still missing_tool (a hand would destroy the drop)', async () => {
        const w = scene(new Map()); w.set(0, 1, 0, registry.blocksByName.cobweb.defaultState); w.set(0, 1, 1, registry.blocksByName.stone.defaultState);
        const bot = await ready(w, new Vec3(1.5, 1, 0.5), ['cobblestone']);                  // no tool of any kind
        try {
            const web = await execute(bot, 'mine', { x: 0, y: 1, z: 0 });
            assert.strictEqual(web.ok, true, `${web.reason} ${JSON.stringify(web.detail)}`); assert.strictEqual(bot.blockAt(new Vec3(0, 1, 0)).name, 'air', 'the cobweb is gone');
            const rock = await execute(bot, 'mine', { x: 0, y: 1, z: 1 });
            assert.strictEqual(rock.reason, 'missing_tool'); assert.strictEqual(rock.detail.block, 'stone', 'the record names the block');
        } finally { bot.stop(); }
    });

    // The abyss bridge (src/work/bot/bridge.js, owner 2026-11-09), on the same physics: sneak so the body cannot leave the block, the side face of the block under the feet, onto the new block.
    // The platform is x <= 0; east of it (x 1..20, y -10..0) is a void, so a bot that steps off falls and the move ends with `stuck` (the move checks the level it walks on).
    const voidEast = () => { const w = scene(new Map()); fill(w, [1, 20], [-10, 0], [-6, 6], S.air); return w; };
    await test('bridge: four cells over a void, sneaking, one block each, the body never leaves the level; sneak_walk takes it back', async () => {
        const w = voidEast();
        const bot = await ready(w, new Vec3(0.5, 1, 0.5), ['cobblestone']);
        try {
            const cells = [1, 2, 3, 4].map((x) => ({ x, z: 0 }));
            const r = await runMove(bot, 'bridge', { y: 1, cells });
            assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} refused ${JSON.stringify(bot.refused)}`);
            assert.deepStrictEqual(bot.refused, []);
            assert.deepStrictEqual(r.detail.placed, cells.map((c) => ({ x: c.x, y: 0, z: 0 })));
            for (const c of cells) assert.strictEqual(w.getBlock(new Vec3(c.x, 0, 0)).name, 'cobblestone');
            assert.strictEqual(Math.floor(bot.entity.position.x), 4); assert.ok(bot.entity.position.y > 0.9, `y ${bot.entity.position.y}`);
            assert.deepStrictEqual(bot.dug, [], 'nothing was broken: a bridge is not place-and-break');
            const back = await runMove(bot, 'sneak_walk', { y: 1, cells: [3, 2, 1, 0].map((x) => ({ x, z: 0 })) });
            assert.strictEqual(back.ok, true, `${back.reason} ${JSON.stringify(back.detail)}`);
            assert.strictEqual(Math.floor(bot.entity.position.x), 0); assert.ok(bot.entity.position.y > 0.9);
        } finally { bot.stop(); }
    });

    await test('bridge: a corner (east, then south), and a cell that already has a floor costs no block', async () => {
        const w = voidEast(); w.set(2, 0, 0, cobble);                           // the second cell has a floor already
        const bot = await ready(w, new Vec3(0.5, 1, 0.5), ['cobblestone']);
        try {
            const r = await runMove(bot, 'bridge', { y: 1, cells: [{ x: 1, z: 0 }, { x: 2, z: 0 }, { x: 2, z: 1 }, { x: 2, z: 2 }] });
            assert.strictEqual(r.ok, true, `${r.reason} ${JSON.stringify(r.detail)} refused ${JSON.stringify(bot.refused)}`);
            assert.deepStrictEqual(r.detail.placed, [{ x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 1 }, { x: 2, y: 0, z: 2 }]);
            assert.strictEqual(Math.floor(bot.entity.position.z), 2);
        } finally { bot.stop(); }
    });

    await test('bridge: no block to bridge with is a named failure, with the cell it stood on left behind', async () => {
        const w = voidEast();
        const bot = await ready(w, new Vec3(0.5, 1, 0.5), []);
        try {
            const r = await runMove(bot, 'bridge', { y: 1, cells: [{ x: 1, z: 0 }, { x: 2, z: 0 }] });
            assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'missing_item'); assert.strictEqual(r.detail.done, 0);
            assert.ok(bot.entity.position.y > 0.9, 'it did not fall');
            const bad = await runMove(bot, 'bridge', { y: 1, cells: [{ x: 3, z: 3 }] });          // not one step from where it stands
            assert.strictEqual(bad.reason, 'invalid_args');
        } finally { bot.stop(); }
    });

    console.log('\nwork moves: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
