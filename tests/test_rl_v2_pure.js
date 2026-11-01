// Pure-logic tests of RL v2 (docs/proposed/RL-TRAINING-v2.md): reward table and scoring, progress events from server
// packets, skill-level candidates and observation contract. No server; the live run is scripts/train/smoke.sh.
const assert = require('assert');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');
const { CrafterReward, TABLE, MILESTONES, NOTABLE, PROGRESS_DIM, advancementScore, targetVector, stageReward } = require('../src/rl/crafter_reward');
const { ProgressTracker, complete } = require('../src/rl/progress');
const { SkillSpace, vocab, obsSpec, actionSpec, K, CMDS } = require('../src/rl/skill_space');
const { specHash } = require('../src/rl/action_spec');
const { parseArgs, queued, describe, StuckDetector } = require('../src/rl/run_skill_env');
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
    assert.strictEqual(advancementScore('create:root'), 1);
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

function worldBot() {
    const bot = fakeBot(), reg = bot.registry;
    const blocks = new Map();
    const set = (x, y, z, name) => blocks.set(`${x},${y},${z}`, name);
    for (let x = -12; x <= 12; x++) for (let z = -12; z <= 12; z++) { set(x, 63, z, 'grass_block'); set(x, 62, z, 'stone'); }
    set(2, 64, 0, 'oak_log'); set(3, 63, 1, 'iron_ore');
    bot.blockAt = (v) => {
        const name = blocks.get(`${v.x},${v.y},${v.z}`) || 'air', b = reg.blocksByName[name];
        return { name, position: new Vec3(v.x, v.y, v.z), boundingBox: b.boundingBox, shapes: name === 'air' ? [] : [[0, 0, 0, 1, 1, 1]], diggable: b.diggable };
    };
    bot.entity = { position: new Vec3(0.5, 64, 0.5), yaw: 0, onGround: true };
    const items = [{ name: 'oak_planks', type: reg.itemsByName.oak_planks.id, count: 4 }, { name: 'bread', type: reg.itemsByName.bread.id, count: 2 }];
    bot.inventory = { items: () => items, slots: Array.from({ length: 46 }, (_, i) => (i === 36 ? items[0] : i === 37 ? items[1] : null)) };
    bot.entities = { 7: { id: 7, name: 'zombie', type: 'hostile', position: new Vec3(5, 64, 5) }, 8: { id: 8, name: 'item', type: 'other', position: new Vec3(-2, 64, 1), getDroppedItem: () => ({ name: 'stick', count: 1 }) } };
    bot.health = 20; bot.food = 15; bot.game = { dimension: 'minecraft:overworld' };
    bot.findBlock = () => null; bot.findBlocks = () => [];
    bot.recipesFor = (id) => (reg.items[id].name === 'stick' || reg.items[id].name === 'crafting_table' ? [{}] : []);
    return bot;
}

test('candidates: generic nearest-of-each-kind, within K, wait always present, every one passes the command schema', () => {
    const bot = worldBot(), voc = vocab(bot.registry, null), space = new SkillSpace(bot, voc);
    const c = space.candidates(), byCmd = (k) => c.filter((x) => x.cmd === k);
    assert.ok(c.length <= K && byCmd('wait').length === 1);
    assert.ok(byCmd('move_to').length >= 8);
    const mined = byCmd('mine').map((m) => voc.items[m.item]);
    assert.ok(mined.includes('oak_log') && mined.includes('iron_ore') && mined.includes('grass_block'));
    assert.deepStrictEqual(byCmd('attack').map((a) => a.args.entity), [7]);
    assert.deepStrictEqual(byCmd('pickup').map((a) => a.args.entity), [8]);
    assert.deepStrictEqual(byCmd('craft').map((a) => a.args.item).sort(), ['crafting_table', 'stick']);
    assert.deepStrictEqual(byCmd('eat').map((a) => a.args.item), ['bread']);
    const { validateArgs } = require('../src/skills');
    for (const x of c) if (x.cmd !== 'wait') validateArgs(x.cmd, x.args);
});

test('candidates: never the block underfoot; a bot in a pit is offered the head-height wall block (the step out)', () => {
    const reg = require('minecraft-data')('1.20.1');
    // A 1x1 pit two deep in dirt: the bot stands at y 62, ground level is 64, walls of dirt around y 62..63.
    const bot = worldBot();
    const dirt = (x, y, z) => { if (x === 0 && z === 0) return y <= 61; return y <= 63; };
    bot.blockAt = (v) => { const solid = dirt(v.x, v.y, v.z); const b = solid ? reg.blocksByName.dirt : reg.blocksByName.air;
        return { name: b.name, type: b.id, position: v, boundingBox: solid ? 'block' : 'empty', diggable: solid, shapes: solid ? [[0, 0, 0, 1, 1, 1]] : [], stateId: b.defaultState }; };
    bot.entity = { position: new Vec3(0.5, 62, 0.5), yaw: 0, onGround: true };
    const space = new SkillSpace(bot, vocab(bot.registry, null));
    const mine = space.candidates().filter((c) => c.cmd === 'mine').map((c) => c.args);
    assert.ok(!mine.some((a) => a.x === 0 && a.z === 0 && a.y < 62), 'block under the feet offered');
    assert.ok(mine.some((a) => a.y === 63 && Math.abs(a.x) + Math.abs(a.z) === 1), `no head-height wall block: ${JSON.stringify(mine)}`);
});

test('observation matches the declared spec exactly (shapes, dtypes, masks)', () => {
    const bot = worldBot(), space = new SkillSpace(bot, vocab(bot.registry, null));
    const o = space.observe(new CrafterReward().progress(), { reason: 'not_visible', ticks: 37 });
    const spec = obsSpec().fields;
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
});

test('skills_v1 action spec: one select over K candidates; hash equals DPOD ActionSpec.spec_hash()', () => {
    const s = actionSpec();
    assert.deepStrictEqual(s.components, [{ kind: 'select', name: 'candidate', n: K }]);
    assert.strictEqual(specHash(s), '3d35ee5859e21a04b5c1eaa81ffc9048a1c6e716db872f173a90348295ec0558');
});

test('runner: args, RCON queue keeps order and one command at a time', async () => {
    assert.throws(() => parseArgs(['--bots', '2']), /--base/);
    assert.strictEqual(parseArgs(['--base', 'train1', '--bots', '3']).bots, 3);
    let active = 0, maxActive = 0;
    const log = [];
    const cmd = queued({ command: async (c) => { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 5)); log.push(c); active--; return c; } });
    await Promise.all(['a', 'b', 'c'].map(cmd));
    assert.deepStrictEqual(log, ['a', 'b', 'c']); assert.strictEqual(maxActive, 1);
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
});

process.on('exit', (code) => { if (!code && pending) { console.error(`${pending} async tests did not finish`); process.exitCode = 1; } });
