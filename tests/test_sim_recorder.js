'use strict';
// scripts/sim/record.js (TASK-20261125-078): the parity recorder on a fake 1.21.1 bot over a flat chunk, no server.
// 1. install() wraps execute and the runner before anyone else loads them, records a command once (not again for the runner call inside
//    it), and changes nothing in the result.
// 2. The trace of a short scripted session (mine, place, place into short grass, activate) is exactly tools/sim/tests/trace_flat.jsonl, the
//    fixture the Rust replayer's tests read (`node tests/test_sim_recorder.js --write` rewrites it after a deliberate format change).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const Vec3 = require('vec3');

const REC = require('../scripts/sim/record');
const VERSION = '1.21.1';
const registry = require('prismarine-registry')(VERSION);
const Chunk = require('prismarine-chunk')(registry);
const Item = require('prismarine-item')(registry);
const FIXTURE = path.join(__dirname, '..', 'tools', 'sim', 'tests', 'trace_flat.jsonl');

function fakeBot(name) {
    const col = new Chunk({ minY: -64, worldHeight: 384 });
    const S = (n, props) => (props ? require('prismarine-block')(registry).fromProperties(n, props, 0).stateId : registry.blocksByName[n].defaultState);
    for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) {
        for (let y = -64; y < 64; y++) col.setBlockStateId(new Vec3(x, y, z), y === -64 ? S('bedrock') : S('stone'));
        col.setBlockStateId(new Vec3(x, 64, z), S('grass_block', { snowy: false }));
    }
    col.setBlockStateId(new Vec3(12, 65, 8), S('short_grass'));
    const bot = new EventEmitter();
    Object.assign(bot, {
        username: name, version: VERSION, registry,
        game: { minY: -64, height: 384, dimension: 'overworld', difficulty: 'peaceful', gameMode: 'survival' },
        entity: { position: new Vec3(8.5, 65, 8.5), velocity: new Vec3(0, -0.0784, 0), yaw: 0, pitch: 0, onGround: true },
        health: 20, food: 20, foodSaturation: 5, oxygenLevel: 20, quickBarSlot: 0,
        inventory: { slots: new Array(46).fill(null) },
        world: Object.assign(new EventEmitter(), { getColumn: (cx, cz) => (cx === 0 && cz === 0 ? col : null) }),
    });
    bot.setBlock = (x, y, z, n) => {
        const old = { position: new Vec3(x, y, z), stateId: col.getBlockStateId(new Vec3(x, y, z)) };
        col.setBlockStateId(new Vec3(x, y, z), S(n));
        bot.emit('blockUpdate', old, { position: new Vec3(x, y, z), stateId: S(n) });
    };
    bot.setSlot = (slot, n, count) => { bot.inventory.slots[slot] = n ? new Item(registry.itemsByName[n].id, count) : null; };
    return bot;
}

// Deterministic clock for the fixture: every Date.now() call advances 5 ms.
let clock = 1764000000000;
const realNow = Date.now;
Date.now = () => (clock += 5);

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simrec-'));
    try {
        // ---- 1. install() and the wrap ----
        const { recs, closeAll } = REC.install({ dir: path.join(tmp, 'live'), r: 0 });
        assert.throws(() => REC.install({ dir: path.join(tmp, 'again') }), /loaded before the recorder/, 'a second install after src/skills is loaded is refused');
        const { execute } = require('../src/skills');
        const bot = fakeBot('Live1');
        const res = await execute(bot, 'mine', { x: 'not a number', y: 64, z: 8 });
        assert.strictEqual(res.reason, 'invalid_args', 'the command result passes through unchanged');
        const runner = require('../src/skills/runner');
        assert.notStrictEqual(runner.run.name, 'run', 'the runner is wrapped too');
        closeAll();
        const live = fs.readFileSync(path.join(tmp, 'live', 'Live1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(live.map((l) => l.t).filter((t) => t !== 'st'), ['hello', 'chunk', 'cmd', 'res'], 'one chunk, one command, one result');
        const cmd = live.find((l) => l.t === 'cmd'), out = live.find((l) => l.t === 'res');
        assert.strictEqual(cmd.layer, 'execute'); assert.strictEqual(cmd.name, 'mine'); assert.deepStrictEqual(cmd.before.pos, [8.5, 65, 8.5]);
        assert.strictEqual(out.reason, 'invalid_args'); assert.strictEqual(out.ok, false);
        assert.ok(recs.size === 1);
        const hello = live[0];
        assert.strictEqual(hello.version, VERSION); assert.strictEqual(hello.difficulty, 'peaceful'); assert.strictEqual(hello.format, REC.FORMAT);
        const names = new Map(live.filter((l) => l.t === 'st').map((l) => [l.id, l.n]));
        assert.deepStrictEqual([...names.values()].sort(), ['air', 'bedrock', 'grass_block', 'short_grass', 'stone'], 'every state in the chunk is named once');
        assert.deepStrictEqual(live.find((l) => l.t === 'st' && l.n === 'grass_block').p, { snowy: false }, 'with its properties');

        // ---- 2. the fixture session, written by BotRec directly (the outcomes are what a server would answer) ----
        clock = 1764000000000;
        const dir = path.join(tmp, 'fix');
        fs.mkdirSync(dir);
        const b = fakeBot('Fix1');
        const rec = new REC.BotRec(b, dir, { r: 0, trace: false });
        b.on('physicsTick', () => {});
        const step = (n) => { for (let i = 0; i < n; i++) b.emit('physicsTick'); };
        // 1: mine the grass block two east of the bot: it becomes air, a dirt comes into the pack (slot 36)
        let id = rec.begin('execute', 'mine', { x: 10, y: 64, z: 8 }, {});
        step(71); b.setBlock(10, 64, 8, 'air'); b.setSlot(36, 'dirt', 1);
        rec.end(id, { ok: true, reason: null, detail: {}, ticks: 71, ms: 3550, phases: [] });
        // 2: place the dirt back
        id = rec.begin('execute', 'place', { x: 10, y: 64, z: 8, item: 'dirt' }, {});
        step(8); b.setBlock(10, 64, 8, 'dirt'); b.setSlot(36, null);
        rec.end(id, { ok: true, reason: null, detail: {}, ticks: 8, ms: 400, phases: [] });
        // 3: place dirt into the short grass at (12,65,8): vanilla replaces short grass
        b.setSlot(36, 'dirt', 1);
        id = rec.begin('execute', 'place', { x: 12, y: 65, z: 8, item: 'dirt' }, {});
        step(9); b.setBlock(12, 65, 8, 'dirt'); b.setSlot(36, null);
        rec.end(id, { ok: true, reason: null, detail: {}, ticks: 9, ms: 450, phases: [] });
        // 4: a command the simulator does not model
        id = rec.begin('execute', 'activate', { x: 12, y: 65, z: 8 }, {});
        step(3);
        rec.end(id, { ok: false, reason: 'invalid_target', detail: { why: 'nothing to use' }, ticks: 3, ms: 150, phases: [] });
        rec.close();
        const text = fs.readFileSync(path.join(dir, 'Fix1.jsonl'), 'utf8');
        if (process.argv.includes('--write')) { fs.writeFileSync(FIXTURE, text); console.log(`wrote ${FIXTURE}`); }
        else assert.strictEqual(text, fs.readFileSync(FIXTURE, 'utf8'), 'the recorder writes exactly the fixture the Rust replayer is tested on (rewrite it with --write after a deliberate format change)');
        const lines = text.trim().split('\n').map((l) => JSON.parse(l));
        assert.deepStrictEqual(lines.filter((l) => l.t === 'blk').map((l) => l.p), [[10, 64, 8], [10, 64, 8], [12, 65, 8]], 'block updates of tracked chunks only, in order');
        const r1 = lines.find((l) => l.t === 'res' && l.id === 1);
        assert.deepStrictEqual(r1.after.inv, [[36, 'dirt', 1]]);
        assert.strictEqual(lines.find((l) => l.t === 'blk').tick, 71, 'block updates carry the bot\'s physics tick');
        console.log('test_sim_recorder: ok');
    } finally {
        Date.now = realNow;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
})().catch((e) => { console.error(e); process.exit(1); });
