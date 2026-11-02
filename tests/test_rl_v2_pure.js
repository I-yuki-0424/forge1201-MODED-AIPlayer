// Pure-logic tests of RL v2 (docs/proposed/RL-TRAINING-v2.md): reward table and scoring, progress events from server
// packets, skill-level candidates and observation contract. No server; the live run is scripts/train/smoke.sh.
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { CrafterReward, TABLE, MILESTONES, NOTABLE, PROGRESS_DIM, advancementScore, targetVector, stageReward } = require('../src/rl/crafter_reward');
const { ProgressTracker, complete } = require('../src/rl/progress');
const { SkillSpace, vocab, obsSpec, actionSpec, K, CMDS } = require('../src/rl/skill_space');
const { specHash } = require('../src/rl/action_spec');
const { parseArgs, queued, describe, sector, ring, StuckDetector } = require('../src/rl/run_skill_env');
const { LiveBoard } = require('../src/rl/live_board');

let pending = 0;
function test(name, fn) {
    const r = fn();
    if (r && r.then) { pending++; r.then(() => { console.log(`--- test: ${name} ---\n[OK]`); pending--; }, (e) => { console.error(`--- test: ${name} --- FAILED`); console.error(e); process.exit(1); }); }
    else console.log(`--- test: ${name} ---\n[OK]`);
}
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

test('advancement table: tree depth as steps, tab roots chained, recipes excluded, Create flat', () => {
    assert.strictEqual(advancementScore('minecraft:story/root'), 1);
    assert.strictEqual(advancementScore('minecraft:story/mine_stone'), 2);
    assert.strictEqual(advancementScore('minecraft:story/enter_the_nether'), 7);
    assert.strictEqual(advancementScore('minecraft:end/kill_dragon'), 11);      // end/root chained to story/enter_the_end (9)
    assert.strictEqual(advancementScore('minecraft:recipes/misc/stick'), null);
    assert.strictEqual(advancementScore('create:root'), null);       // v4: awarded for free on joining
    assert.strictEqual(advancementScore('create:andesite_alloy'), 1);
    assert.ok(MILESTONES.length === 110 && MILESTONES.every((m) => m.startsWith('minecraft:')));
});

test('survival: a slept night is worth more than one awake', () => {
    const r = new CrafterReward();
    assert.ok(TABLE.survival.night_slept > TABLE.survival.night_awake);
    near(r.score([{ type: 'dawn', slept: false }]).terms.survival, TABLE.survival.night_awake);
    near(r.score([{ type: 'dawn', slept: true }]).terms.survival, TABLE.survival.night_slept);
    assert.deepStrictEqual(r.progress().slice(-2), [0.2, 0.1]);
});

test('kills: class weights, per-type decay, notable replaces, bosses never decay', () => {
    const r = new CrafterReward();
    near(r.score([{ type: 'killed', entity: 'minecraft:cow', n: 3 }]).terms.kills, 1 + 0.5 + 0.25);      // passive: no multiplier
    near(r.score([{ type: 'killed', entity: 'minecraft:wolf', n: 1 }]).terms.kills, 0.25);              // neutral: low
    near(r.score([{ type: 'killed', entity: 'minecraft:zombie', n: 1 }]).terms.kills, 1);
    const n = r.score([{ type: 'killed', entity: 'minecraft:blaze', n: 2 }]);
    near(n.terms.notable, 8 + 4); near(n.terms.kills, 0);
    near(r.score([{ type: 'killed', entity: 'minecraft:ender_dragon', n: 1 }]).terms.notable, 100);
    near(r.score([{ type: 'killed', entity: 'minecraft:ender_dragon', n: 1 }]).terms.notable, 100);
    for (const [name, s] of Object.entries(TABLE.notable.score)) if (!TABLE.notable.boss.includes(name)) assert.ok(s < 100);
    const v = r.progress();
    assert.strictEqual(v[MILESTONES.length + NOTABLE.indexOf('blaze')], 1);
    assert.strictEqual(v[MILESTONES.length + NOTABLE.indexOf('wither')], 0);
});

test('mined: dirt and stone extremely low, rarity tiers rise, decay per type', () => {
    const r = new CrafterReward();
    assert.ok(r.score([{ type: 'mined', block: 'minecraft:dirt', n: 100 }]).terms.mined < 0.01);
    near(r.score([{ type: 'mined', block: 'minecraft:stone', n: 1 }]).terms.mined, TABLE.mined.default);
    const tiers = TABLE.mined.tiers.map((t) => t.score);
    assert.deepStrictEqual(tiers, [...tiers].sort((a, b) => a - b));
    near(r.score([{ type: 'mined', block: 'minecraft:diamond_ore', n: 2 }]).terms.mined, 3 + 3 * 0.7);
    near(r.score([{ type: 'mined', block: 'create:zinc_ore', n: 1 }]).terms.mined, 0.4);
});

test('achievements: once per episode, score = steps; newEpisode resets', () => {
    const r = new CrafterReward();
    near(r.score([{ type: 'advancement', id: 'minecraft:story/smelt_iron' }]).terms.achievements, 4);
    near(r.score([{ type: 'advancement', id: 'minecraft:story/smelt_iron' }]).terms.achievements, 0);
    near(r.score([{ type: 'advancement', id: 'minecraft:recipes/misc/stick' }]).total, 0);
    r.newEpisode();
    near(r.score([{ type: 'advancement', id: 'minecraft:story/smelt_iron' }]).total, 4);
});

test('achievements v4: nothing is paid for dying (adventure/root is granted by being killed); a kill still pays it', () => {
    const r = new CrafterReward();
    near(r.score([{ type: 'death' }, { type: 'advancement', id: 'minecraft:adventure/root' }]).total, 0);
    r.newEpisode();
    // Control: the same advancement earned by a kill, without a death in that step, pays its depth.
    near(r.score([{ type: 'advancement', id: 'minecraft:adventure/root' }]).terms.achievements, 1);
    near(r.score([{ type: 'advancement', id: 'create:root' }]).total, 0);
});

test('invalid: a command that cannot be executed scores negative; failures the policy did not cause are free', () => {
    const r = new CrafterReward();
    near(r.score([{ type: 'failed', reason: 'unreachable' }]).terms.invalid, -0.1);
    near(r.score([{ type: 'failed', reason: 'missing_tool' }, { type: 'failed', reason: 'stuck' }]).total, -0.15);
    for (const why of ['died', 'cancelled', 'disconnected', 'internal']) near(r.score([{ type: 'failed', reason: why }]).total, 0);
    for (const st of ['survive', 'dragon']) assert.strictEqual(TABLE.stages[st].invalid, 1.0);   // full weight in both stages
    near(stageReward({ invalid: -0.1 }, 'survive'), -0.1);
});

test('curriculum: targets live in the progress space; stage weights from the table', () => {
    const s = targetVector('survive'), d = targetVector('dragon');
    assert.strictEqual(s.length, PROGRESS_DIM); assert.strictEqual(d.length, PROGRESS_DIM);
    assert.strictEqual(d[MILESTONES.indexOf('minecraft:end/kill_dragon')], 1);
    assert.strictEqual(d.reduce((a, b) => a + b), 2);
    assert.deepStrictEqual(s.slice(-2), [1, 1]);
    const terms = { survival: 1, kills: 2, notable: 0, mined: 1, achievements: 4 };
    near(stageReward(terms, 'survive'), 1 + 0.1 * 7);
    near(stageReward(terms, 'dragon'), 8);
    assert.throws(() => targetVector('x'));
});

function fakeBot() {
    const bot = new EventEmitter();
    bot._client = new EventEmitter();
    bot._client.write = (name) => { if (name === 'client_command') setImmediate(() => bot._client.emit('statistics', { entries: bot.stats })); };
    bot.registry = require('minecraft-data')('1.20.1');
    bot.time = { timeOfDay: 6000, day: 3 };
    bot.stats = [];
    return bot;
}

test('progress: statistics deltas become kill/mine events (vanilla ids)', async () => {
    const bot = fakeBot(), reg = bot.registry;
    const zombie = reg.entitiesByName.zombie.id, iron = reg.blocksByName.iron_ore.id;
    bot.stats = [{ categoryId: 6, statisticId: zombie, value: 4 }, { categoryId: 0, statisticId: iron, value: 2 }];
    const t = new ProgressTracker(bot);
    await t.begin();
    bot.stats = [{ categoryId: 6, statisticId: zombie, value: 5 }, { categoryId: 0, statisticId: iron, value: 4 }, { categoryId: 8, statisticId: 1, value: 99 }];
    const { events } = await t.collect();
    assert.deepStrictEqual(events, [{ type: 'killed', entity: 'minecraft:zombie', n: 1 }, { type: 'mined', block: 'minecraft:iron_ore', n: 2 }]);
});

test('progress: advancement completion follows requirement groups; revoke re-arms it', async () => {
    const bot = fakeBot(), t = new ProgressTracker(bot);
    await t.begin();
    const adv = (crit) => bot._client.emit('advancements', { reset: false, advancementMapping: [], identifiers: [],
        progressMapping: [{ key: 'minecraft:adventure/root', value: [{ criterionIdentifier: 'killed_something', criterionProgress: crit ? 1n : undefined }, { criterionIdentifier: 'killed_by_something' }] }] });
    adv(true);
    adv(true);
    assert.deepStrictEqual((await t.collect()).events, [{ type: 'advancement', id: 'minecraft:adventure/root' }]);
    adv(false); adv(true);
    assert.deepStrictEqual((await t.collect()).events, [{ type: 'advancement', id: 'minecraft:adventure/root' }]);
    assert.ok(complete([['a', 'b'], ['c']], new Set(['b', 'c'])) && !complete([['a'], ['c']], new Set(['a'])));
});

test('progress: dawn after a lived night; slept only when in bed at the skip; a night joined late does not count', async () => {
    const bot = fakeBot(), t = new ProgressTracker(bot);
    await t.begin();
    const time = (tod, day) => { bot.time = { timeOfDay: tod, day }; bot.emit('time'); };
    time(13000, 3); time(23999, 3); time(10, 4);
    bot.emit('sleep'); t.sleepStart -= 6000; time(13500, 4); bot.emit('wake'); time(0, 5);
    assert.deepStrictEqual((await t.collect()).events, [{ type: 'dawn', slept: false }, { type: 'dawn', slept: true }]);
    await t.begin();
    time(100, 6);   // the episode began after the night: no dawn reward
    assert.deepStrictEqual((await t.collect()).events, []);
    bot.emit('death'); bot.emit('death');
    assert.deepStrictEqual((await t.collect()).events, [{ type: 'death' }]);
});

test('progress: raw advancements packets from the Create server (transport leaves them unparsed) grant and revoke', async () => {
    const fs = require('fs'), path = require('path');
    const raw = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', `advancements-${n}.bin`));
    const bot = fakeBot(), t = new ProgressTracker(bot);
    await t.begin();
    for (const n of ['join', 'grant-mine_stone']) bot._client.emit('advancements', raw(n));
    const got = (await t.collect()).events.map((e) => e.id).sort();
    assert.deepStrictEqual(got, ['minecraft:story/mine_stone']);   // 'grant only': the others arrive as visible, not done
    bot._client.emit('advancements', raw('revoke'));
    bot._client.emit('advancements', Buffer.from([1, 2, 3]));
    assert.strictEqual(t.advErrors, 1);
    assert.ok(!t.criteria.has('minecraft:story/mine_stone'));
});

// The test bot stands in a real prismarine-world of 1.20.1 chunks (the bot's own world implementation): candidates run on
// the same fast path as live (state ids, palettes, the reachability flood, tool checks).
const viaMf = (m) => require(require.resolve(m, { paths: [require.resolve('mineflayer')] }));
function flatLayout(x, y, z) {
    if (x === 2 && y === 64 && z === 0) return 'oak_log';
    if (x === 3 && y === 63 && z === 1) return 'iron_ore';
    return y === 63 ? 'grass_block' : y <= 62 ? 'stone' : 'air';
}
function worldBot(nameAt = flatLayout, pos = new Vec3(0.5, 64, 0.5), extraItems = []) {
    const bot = fakeBot();
    const reg = bot.registry = require('prismarine-registry')('1.20.1');
    const Chunk = viaMf('prismarine-chunk')(reg), World = viaMf('prismarine-world')(reg);
    const world = new World(null).sync;
    for (let cx = -2; cx <= 1; cx++) for (let cz = -2; cz <= 1; cz++) {
        const c = new Chunk({ minY: -64, worldHeight: 384 });
        for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) for (let y = 50; y <= 72; y++) {
            const n = nameAt(cx * 16 + x, y, cz * 16 + z);
            if (n !== 'air') c.setBlockStateId(new Vec3(x, y, z), reg.blocksByName[n].defaultState);
        }
        world.setColumn(cx, cz, c);
    }
    bot.world = world;
    bot.blockAt = (v) => world.getBlock(new Vec3(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)));
    bot.entity = { position: pos, yaw: 0, onGround: true };
    const items = [{ name: 'oak_planks', type: reg.itemsByName.oak_planks.id, count: 4 }, { name: 'bread', type: reg.itemsByName.bread.id, count: 2 },
        ...extraItems.map((n) => ({ name: n, type: reg.itemsByName[n].id, count: 1 }))];
    bot.inventory = { items: () => items, slots: Array.from({ length: 46 }, (_, i) => items[i - 36] || null) };
    bot.entities = { 7: { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 5) }, 8: { id: 8, name: 'item', type: 'other', position: new Vec3(-2, 64, 1), getDroppedItem: () => ({ name: 'stick', count: 1 }) } };
    bot.health = 20; bot.food = 15; bot.game = { dimension: 'minecraft:overworld', minY: -64 };
    bot.findBlock = () => { throw new Error('findBlock is the slow path (every cell a Block): not used'); };
    bot.findBlocks = bot.findBlock;
    bot.recipesFor = (id) => (reg.items[id].name === 'stick' || reg.items[id].name === 'crafting_table' ? [{}] : []);
    return bot;
}

test('reward v2, owner rule 2026-11-02: thousands of trivial blocks in one episode are worth less than one log', () => {
    const r = new CrafterReward();
    let trivial = 0;
    for (const block of ['dirt', 'grass_block', 'gravel', 'sand']) trivial += r.score([{ type: 'mined', block: `minecraft:${block}`, n: 1000 }]).terms.mined;
    const log = new CrafterReward().score([{ type: 'mined', block: 'minecraft:oak_log', n: 1 }]).terms.mined;
    assert.ok(log >= 0.2, `log ${log}`);
    assert.ok(trivial < log, `4 x 1000 trivial blocks ${trivial} >= one log ${log}`);
    // placing earns nothing: only server statistics (mined, killed), advancements, nights and failures are scored
    assert.strictEqual(r.score([{ type: 'placed', block: 'dirt', n: 1000 }]).total, 0);
});

test('reward v2: blocks broken with a tool score x tool_multiplier (owner 2026-11-02), a tunnel by the share of tool cells', () => {
    const m = TABLE.mined.tool_multiplier;
    assert.ok(m > 1 && m <= 1.5, `slight multiplier ${m}`);
    const ev = [{ type: 'mined', block: 'minecraft:coal_ore', n: 1 }];
    const hand = new CrafterReward().score(ev).terms.mined;
    const tool = new CrafterReward().score([...ev, { type: 'tool', frac: 1 }]).terms.mined;
    const half = new CrafterReward().score([...ev, { type: 'tool', frac: 0.5 }]).terms.mined;
    near(tool, hand * m); near(half, hand * (1 + (m - 1) / 2));
    assert.strictEqual(new CrafterReward().score([{ type: 'tool', frac: 1 }]).total, 0);   // a tool alone earns nothing
});

test('candidates: generic nearest-of-each-kind, within K, wait always present, every one passes the command schema', () => {
    const bot = worldBot(), voc = vocab(bot.registry, null), space = new SkillSpace(bot, voc);
    const c = space.candidates(), byCmd = (k) => c.filter((x) => x.cmd === k);
    assert.ok(c.length <= K && byCmd('wait').length === 1);
    assert.ok(byCmd('move_to').length >= 8);
    const mined = byCmd('mine').map((m) => voc.items[m.item]);
    assert.ok(mined.includes('oak_log') && mined.includes('grass_block'), mined.join());
    assert.ok(!mined.includes('iron_ore'), 'iron ore offered without a pickaxe (it would end missing_tool)');
    assert.deepStrictEqual(byCmd('tunnel').map((t) => `${t.args.dir}${t.args.dy}`).sort(), ['east-1', 'north-1', 'south-1', 'west-1']);
    assert.deepStrictEqual(byCmd('attack').map((a) => a.args.entity), [7]);
    assert.deepStrictEqual(byCmd('pickup').map((a) => a.args.entity), [8]);
    assert.deepStrictEqual(byCmd('craft').map((a) => a.args.item).sort(), ['crafting_table', 'stick']);
    assert.deepStrictEqual(byCmd('eat').map((a) => a.args.item), ['bread']);
    const { validateArgs } = require('../src/skills');
    for (const x of c) if (x.cmd !== 'wait') validateArgs(x.cmd, x.args);
    const withPick = new SkillSpace(worldBot(flatLayout, new Vec3(0.5, 64, 0.5), ['stone_pickaxe']), voc).candidates();
    assert.ok(withPick.some((x) => x.cmd === 'mine' && voc.items[x.item] === 'iron_ore'), 'iron ore with a stone pickaxe');
});

test('candidates: only what the walker can reach (a walled-in bot is offered no move and no far block)', () => {
    // A 3x3 room of stone walls 3 high around the bot: every move_to target outside is unreachable, as is the log outside.
    const room = (x, y, z) => (Math.max(Math.abs(x), Math.abs(z)) === 2 && y >= 64 && y <= 66 ? 'stone' : flatLayout(x, y, z));
    const bot = worldBot(room), voc = vocab(bot.registry, null);
    const c = new SkillSpace(bot, voc).candidates();
    assert.deepStrictEqual(c.filter((x) => x.cmd === 'move_to'), []);
    assert.ok(!c.some((x) => x.cmd === 'mine' && voc.items[x.item] === 'oak_log'), 'log outside the room offered');
    assert.ok(!c.some((x) => x.cmd === 'pickup' || x.cmd === 'attack'), 'entities outside the room offered');
});

test('candidates: never the block underfoot; a bot in a pit is offered the head-height wall block and the stair step up', () => {
    // A 1x1 pit two deep in dirt: the bot stands at y 62, ground level is 64, walls of dirt around y 62..63.
    const pit = (x, y, z) => ((x === 0 && z === 0) ? (y <= 61 ? 'dirt' : 'air') : (y <= 63 ? 'dirt' : 'air'));
    const bot = worldBot(pit, new Vec3(0.5, 62, 0.5));
    const c = new SkillSpace(bot, vocab(bot.registry, null)).candidates();
    const mine = c.filter((x) => x.cmd === 'mine').map((x) => x.args);
    assert.ok(!mine.some((a) => a.x === 0 && a.z === 0 && a.y < 62), 'block under the feet offered');
    assert.ok(mine.some((a) => a.y === 63 && Math.abs(a.x) + Math.abs(a.z) === 1), `no head-height wall block: ${JSON.stringify(mine)}`);
    assert.deepStrictEqual(c.filter((x) => x.cmd === 'tunnel' && x.args.dy === 1).length, 4, 'stair step up out of the pit');
});

test('observation matches the declared spec exactly (shapes, dtypes, masks)', () => {
    const bot = worldBot(), space = new SkillSpace(bot, vocab(bot.registry, null));
    const o = space.observe(new CrafterReward().progress(), { reason: 'not_visible', ticks: 37 }, new Map([['zombie', 2]]), { ticks: 12000, step: 5 });
    const spec = obsSpec(space.voc.entities.length).fields;
    assert.deepStrictEqual(Object.keys(o).sort(), spec.map((f) => f.name).sort());
    const shapeOf = (v) => (Array.isArray(v) ? [v.length, ...shapeOf(v[0])] : []);
    for (const f of spec) {
        assert.deepStrictEqual(shapeOf(o[f.name]), f.shape, f.name);
        const flat = [o[f.name]].flat(3);
        assert.ok(flat.every((x) => (f.dtype === 'bool' ? typeof x === 'boolean' : f.dtype === 'int' ? Number.isInteger(x) : Number.isFinite(x))), f.name);
    }
    assert.strictEqual(o.cand_mask.filter(Boolean).length, space.cands.length);
    assert.ok(o.cand_cmd.every((x, i) => (o.cand_mask[i] ? x > 0 : x === 0)));
    assert.ok(o.last_reason > 0 && o.dt_ticks === 37);
    assert.strictEqual(CMDS[o.cand_cmd[space.cands.length - 1]], 'wait');
    assert.strictEqual(o.killed[space.voc.entities.indexOf('zombie')], 0.25);
    assert.strictEqual(o.clock[0], 0.05);
});

test('view: first hit only (a wall hides what is behind it), item identity kept, nothing hit = air at full range', () => {
    // A stone wall at z = -3 in front of the bot (yaw 0 looks along -z), an iron ore right behind it.
    const wall = (x, y, z) => (z === -3 && y >= 64 && y <= 68 ? 'stone' : z === -4 && y === 65 ? 'iron_ore' : flatLayout(x, y, z));
    const bot = worldBot(wall), voc = vocab(bot.registry, null), space = new SkillSpace(bot, voc);
    bot.entity.yaw = 0; bot.entity.pitch = 0;
    const v = space.view(require('../src/skills/world').fromBot(bot));
    const { VIEW_N } = require('../src/rl/skill_space');
    assert.strictEqual(v.cat.length, VIEW_N);
    assert.ok(!v.item.includes(voc.items.indexOf('iron_ore')), 'ore behind the wall was seen');
    assert.ok(v.item.includes(voc.items.indexOf('stone')), 'wall not seen');
    assert.ok(v.dist.every((d) => d >= 0 && d <= 1));
});

test('candidates: a block next to hidden cave air behind a wall is not offered to mine (no visible aim point)', () => {
    // Bot in a closed pocket of stone; a dirt block (hand-harvestable) two blocks inside the wall touches a sealed air pocket.
    const lay = (x, y, z) => {
        if (y < 64) return flatLayout(x, y, z);
        if (y > 66) return 'air';
        if (x === 0 && z === 0 && (y === 64 || y === 65)) return 'air';
        if (x === 3 && z === 0 && y === 65) return 'dirt';
        if (x === 4 && z === 0 && y === 65) return 'air';
        return 'stone';
    };
    const bot = worldBot(lay, new Vec3(0.5, 64, 0.5)), voc = vocab(bot.registry, null);
    const c = new SkillSpace(bot, voc).candidates();
    assert.ok(!c.some((x) => x.cmd === 'mine' && voc.items[x.item] === 'dirt'), 'hidden dirt offered');
});

test('skills_v1 action spec: one select over K candidates; hash equals DPOD ActionSpec.spec_hash()', () => {
    const s = actionSpec();
    assert.deepStrictEqual(s.components, [{ kind: 'select', name: 'candidate', n: K }]);
    assert.strictEqual(specHash(s), '18d6d5c401a4c695c1f6b4229c2dec4da1413917680db86934d170ef5fde87ed');
});

test('runner: args, RCON queue keeps order and one command at a time', async () => {
    assert.throws(() => parseArgs(['--bots', '2']), /--base/);
    assert.strictEqual(parseArgs(['--base', 'train1', '--bots', '3']).bots, 3);
    let active = 0, maxActive = 0;
    const log = [];
    const cmd = queued({ command: async (c) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); log.push(c); active--; return c; } });
    await Promise.all(['a', 'b', 'c'].map(cmd));
    assert.deepStrictEqual(log, ['a', 'b', 'c']); assert.strictEqual(maxActive, 1);
    // a timeout is retried (twice), any other error is not
    let calls = 0;
    const flaky = queued({ command: async (c) => { calls++; if (calls < 3) throw new Error('rcon: timeout after 5000 ms'); return `ok ${c}`; } });
    assert.strictEqual(await flaky('x'), 'ok x'); assert.strictEqual(calls, 3);
    let n2 = 0;
    const broken = queued({ command: async () => { n2++; throw new Error('rcon: socket closed'); } });
    await assert.rejects(broken('y'), /socket closed/); assert.strictEqual(n2, 1);
    let n3 = 0;
    const dead = queued({ command: async () => { n3++; throw new Error('rcon: timeout after 5000 ms'); } });
    await assert.rejects(dead('z'), /timeout/); assert.strictEqual(n3, 3);
});

test('live board: success rates, bias against a uniform pick, warnings for failing, dominating and standing still', () => {
    const bot = { entity: { position: new Vec3(0, 64, 0) }, health: 20, food: 20, time: { timeOfDay: 1000 }, game: { dimension: 'overworld' } };
    const b = new LiveBoard({ run: 'r', base: 'b' });
    b.attach(1, 'Train1', bot);
    // 100 steps: offered 7 move_to + 1 wait each time, chose wait 80 times (all ok) and move_to 20 times (all fail).
    for (let i = 0; i < 100; i++) {
        const wait = i % 5 !== 0;
        b.begin(1, { episode: 0, step: i, cmd: wait ? 'wait' : 'move_to', label: '', index: 0, offered: [...Array(7).fill('move_to'), 'wait'] });
        b.end(1, { ok: wait, reason: wait ? 'ok' : 'unreachable', ms: 5, ticks: 1, reward: wait ? 0 : -0.1 });
    }
    const s = b.snapshot().bots[0];
    assert.strictEqual(s.name, 'Train1'); assert.strictEqual(s.total.n, 100);
    near(s.window.ok_rate, 0.8);
    near(s.window.cmds.wait.share, 0.8); near(s.window.cmds.wait.uniform_share, 0.125); near(s.window.cmds.wait.bias, 6.4);
    near(s.window.cmds.move_to.ok_rate, 0); near(s.window.reasons['move_to:unreachable'], 20);
    assert.strictEqual(s.window.spread, 0); assert.strictEqual(s.window.spread_n, 100);
    assert.ok(s.warnings.some((w) => /wait is 80%/.test(w)) && s.warnings.some((w) => /moved less than 3/.test(w)), s.warnings.join('; '));
    assert.ok(!s.warnings.some((w) => /^fails/.test(w)));
    near(s.episode_now.return, -2);
    assert.strictEqual(s.recent.length, 20); assert.ok(!('offered' in s.recent[0]));
    b.lost(1, 'kicked'); assert.strictEqual(b.snapshot().bots[0].connected, false);
    const named = { entity: { position: new Vec3(0, 64, 0) }, entities: { 7: { name: 'zombie' } }, blockAt: () => ({ name: 'oak_log' }) };
    assert.strictEqual(describe(named, { cmd: 'mine', args: { x: 3, y: 64, z: 0 } }), 'oak_log (3 64 0) 4 m');
    assert.strictEqual(describe(named, { cmd: 'attack', args: { entity: 7 } }), 'zombie');
});

test('stuck detector: cuts an episode only when nearly every command failed and the bot stayed put', () => {
    const at = (x) => new Vec3(x, 64, 0);
    let d = new StuckDetector({ n: 10 });
    const run = (f) => { let hit = false; for (let i = 0; i < 10; i++) hit = d.push(...f(i)); return hit; };
    assert.strictEqual(run(() => [false, at(0)]), true);                       // trapped
    d = new StuckDetector({ n: 10 }); assert.strictEqual(run((i) => [i === 0, at(0)]), false);   // 10 % succeeded
    d = new StuckDetector({ n: 10 }); assert.strictEqual(run((i) => [false, at(i)]), false);     // failing but moving
    d = new StuckDetector({ n: 10 }); for (let i = 0; i < 9; i++) assert.strictEqual(d.push(false, at(0)), false);   // not enough history
    // Reproducer (run train3, Train6 on a tree top): waits always succeed and must not count as acting.
    d = new StuckDetector({ n: 10 }); assert.strictEqual(run((i) => [true, at(0), i % 5 ? 'wait' : 'mine']).valueOf(), false);   // 2 of 10 mined
    d = new StuckDetector({ n: 10 }); assert.strictEqual(run(() => [true, at(0), 'wait']), true);   // only waiting, in place
});

process.on('exit', (code) => { if (!code && pending) { console.error(`${pending} async tests did not finish`); process.exitCode = 1; } });

test('time scale: mineflayer still polls physics with setInterval(doPhysics) on perf_hooks time; GAME_SPEED=2 halves the poll and doubles the clock', async () => {
    // src/transport/time_scale.js depends on these two lines of mineflayer's physics plugin; an upgrade that changes them
    // must fail here, not silently run the bots at the wrong speed against a fast server.
    const src = require('fs').readFileSync(require.resolve('mineflayer/lib/plugins/physics.js'), 'utf8');
    assert.ok(/const \{ performance \} = require\('perf_hooks'\)/.test(src), 'physics.js no longer reads perf_hooks performance');
    assert.ok(/setInterval\(doPhysics, PHYSICS_INTERVAL_MS\)/.test(src), 'physics.js no longer polls with setInterval(doPhysics, ...)');
    const { execFile } = require('child_process');   // async: the other tests' timers keep running meanwhile
    const probe = `const { performance } = require('perf_hooks'); require('./src/transport/time_scale').fromEnv();
        const t0 = performance.now(), w0 = Date.now(); let n = 0;
        const id = setInterval(function doPhysics() { if (++n === 40) { clearInterval(id);
            console.log(JSON.stringify({ wall: Date.now() - w0, clock: performance.now() - t0 })); } }, 50);`;
    const out = JSON.parse(await new Promise((res, rej) => execFile(process.execPath, ['-e', probe], { cwd: require('path').join(__dirname, '..'), env: { ...process.env, GAME_SPEED: '2' } }, (e, so) => (e ? rej(e) : res(so)))));
    assert.ok(out.wall > 800 && out.wall < 1400, `40 polls took ${out.wall} ms of wall time (expected ~1000 at 25 ms)`);
    assert.ok(Math.abs(out.clock / out.wall - 2) < 0.1, `clock/wall ${out.clock / out.wall}`);
    assert.throws(() => require('../src/transport/time_scale').setTimeScale(11), /\[1, 10\]/);
});

test('sectors: one disjoint cell of the region per bot, inside it, centres far apart', () => {
    for (const n of [1, 4, 8, 16]) {
        const R = 512, cells = Array.from({ length: n }, (_, i) => sector(i, n, R));
        for (const [x0, x1, z0, z1] of cells) assert.ok(x0 >= -R && x1 <= R && z0 >= -R && z1 <= R && x0 < x1 && z0 < z1);
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
            const a = cells[i], b = cells[j];
            assert.ok(a[1] <= b[0] || b[1] <= a[0] || a[3] <= b[2] || b[3] <= a[2], `sectors ${i} and ${j} overlap (n=${n})`);
            const d = Math.hypot((a[0] + a[1] - b[0] - b[1]) / 2, (a[2] + a[3] - b[2] - b[3]) / 2);
            assert.ok(d >= (2 * R) / Math.ceil(Math.sqrt(n)) - 1, `centres ${i},${j} only ${d} apart (n=${n})`);
        }
    }
    assert.strictEqual(describe({ blockAt: () => null, entities: {} }, { cmd: 'tunnel', args: { dir: 'east', dy: -1 } }), 'east down');
});

test('sites (owner 2026-11-02): the committed file parses, one site per bot, bounds checked; the search order is fixed', () => {
    const fs = require('fs'), path = require('path');
    const f = path.join(__dirname, '..', 'config', 'train-sites.json');
    const o = parseArgs(['--base', 't', '--bots', '10', '--sites', f]);
    assert.strictEqual(o.sites.length, 10);
    assert.deepStrictEqual(o.sites[1], [20137, 68, 99842]);
    assert.throws(() => parseArgs(['--base', 't', '--bots', '11', '--sites', f]), /10 sites for 11 bots/);
    assert.strictEqual(parseArgs(['--base', 't', '--sites', '']).sites, null);       // compose passes '' when unset
    const bad = path.join(require('os').tmpdir(), `sites-bad-${process.pid}.json`);
    fs.writeFileSync(bad, JSON.stringify({ sites: [[1.5, 70, 2]] }));
    assert.throws(() => parseArgs(['--base', 't', '--bots', '1', '--sites', bad]), /integers/);
    fs.writeFileSync(bad, JSON.stringify({ sites: [[30000000, 70, 2]] }));
    assert.throws(() => parseArgs(['--base', 't', '--bots', '1', '--sites', bad]), /integers/);
    fs.unlinkSync(bad);
    const r = ring(10, 20, 2);
    assert.strictEqual(r.length, 25);
    assert.deepStrictEqual(r[0], [10, 20]);
    assert.deepStrictEqual(r.slice(1, 5), [[9, 20], [10, 19], [10, 21], [11, 20]]);
    assert.deepStrictEqual(ring(10, 20, 2), r);
});
