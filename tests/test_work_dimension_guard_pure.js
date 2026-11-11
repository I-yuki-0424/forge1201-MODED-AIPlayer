// Work in another dimension (owner 2026-11-10, first job that spans dimensions): a bot that is not in the job's dimension stops working instead of walking toward the other dimension's
// coordinates; the End's platform-to-island gap is crossed by a level bridge, not by a pillar over the void; a bot standing on a block the planner cannot start from steps off it.
const assert = require('assert');
const { runWorker } = require('../src/work/bot/worker');
const { travel } = require('../src/work/bot/travel');
const { planToward, gapOn, launchCell, launchCells, gapAhead, bridgeToward } = require('../src/work/bot/bridge');
const { stepOffCell } = require('../src/skills/motion');
const pit = require('../src/work/jobs/pit');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const P = { x: 0, z: 0 };

/** The End in miniature: an obsidian platform x 0..4 at y 48 (feet 49), void x 5..39, land x >= 40 (stone up to y 55 = a flank, feet at 56 are air from x = 45). */
function endWorld() {
    const m = new Map(), key = (x, y, z) => `${x},${y},${z}`;
    const kindAt = (x, y, z) => {
        if (m.has(key(x, y, z))) return m.get(key(x, y, z));
        if (x >= 0 && x <= 4 && y <= 48 && y >= 47) return 'solid';
        if (x >= 40 && y <= 55) return 'solid';
        return 'air';
    };
    return { kindAt, nameAt: (x, y, z) => (kindAt(x, y, z) === 'air' ? 'air' : 'stone'), set: (x, y, z, k) => m.set(key(x, y, z), k) };
}

(async () => {
    await test('worker: a bot in the wrong dimension claims nothing and ends wrong_dimension (the service sends it through the gate)', async () => {
        const job = pit.createPitJob({ x0: 0, x1: 4, z0: 0, z1: 4, top: 10, bottom: 9 }, { gate: true, leaseMs: 60000 }, { method: 'sweep', road: false });
        let ran = 0;
        const jobRun = { ...job, runUnit: async () => { ran++; return { ok: true }; } };
        const events = [], env = { w: { kindAt: () => 'air' }, now: Date.now, pos: () => P, here: () => ({ x: 2, y: 11, z: 2 }), exec: async () => ({ ok: true }), inv: () => ({ items: [], slotsFree: 30 }), dimension: () => 'overworld', wrongDim: () => true };
        const r = await runWorker(jobRun, 'A', env, { pollMs: 5, onEvent: (ev, d) => events.push([ev, d && d.have]) });
        assert.strictEqual(r.ended, 'wrong_dimension'); assert.strictEqual(ran, 0, 'no unit was started');
        assert.deepStrictEqual(events, [['wrong_dimension', 'overworld']]);
        const L = job.ledger; assert.ok(L.claim('B', P, Date.now()), 'every unit is still free for the others');
    });

    await test('worker: a bot that leaves the dimension during a unit (it died, came back at its bed) is not charged for the unit', async () => {
        const job = pit.createPitJob({ x0: 0, x1: 4, z0: 0, z1: 4, top: 10, bottom: 9 }, { gate: true, leaseMs: 60000 }, { method: 'sweep', road: false });
        let wrong = false;
        const jobRun = { ...job, runUnit: async () => { wrong = true; return { ok: false, reason: 'unreachable', detail: { why: 'walking back to the job failed', stage: 'rejoin', cell: { x: 81, y: 57, z: 17 } } }; } };
        const env = { w: { kindAt: () => 'air' }, now: Date.now, pos: () => P, here: () => ({ x: 2, y: 11, z: 2 }), exec: async () => ({ ok: true }), inv: () => ({ items: [], slotsFree: 30 }), dimension: () => 'overworld', wrongDim: () => wrong };
        const r = await runWorker(jobRun, 'A', env, { pollMs: 5 });
        assert.strictEqual(r.ended, 'wrong_dimension');
        assert.strictEqual(job.ledger.stuck.length, 0, 'nothing parked'); assert.strictEqual(r.failed, 0, 'not counted as a failure of the bot either');
        const again = job.ledger.claim('B', P, Date.now() + 100000); assert.ok(again, 'the unit goes back to the pool');
        assert.strictEqual(job.ledger.regions.get(again.region).attempts[again.units[0].unit], 0, 'no attempt counted');
    });

    await test('worker: with no dimension rule (an old job) nothing changes', async () => {
        const job = pit.createPitJob({ x0: 0, x1: 1, z0: 0, z1: 1, top: 10, bottom: 10 }, { gate: true, leaseMs: 60000 }, { method: 'sweep', road: false });
        const jobRun = { ...job, runUnit: async () => ({ ok: true }) };
        const env = { w: { kindAt: () => 'air' }, now: Date.now, pos: () => P, here: () => ({ x: 0, y: 11, z: 0 }), exec: async () => ({ ok: true }), inv: () => ({ items: [], slotsFree: 30 }) };
        const r = await runWorker(jobRun, 'A', env, { pollMs: 5 });
        assert.strictEqual(r.ended, 'finished');
    });

    await test('travel: stops at once when the bot is not in the dimension of the target', async () => {
        let moves = 0;
        const r = await travel({ w: { kindAt: () => 'solid' }, here: () => ({ x: 0, y: 64, z: 0 }), exec: async () => { moves++; return { ok: true }; }, wrongDim: () => true }, { x: 800, z: 800 });
        assert.strictEqual(r.reason, 'wrong_dimension'); assert.strictEqual(moves, 0);
    });

    await test('goToStation: in the wrong dimension no walk is made and the failure is the bot\'s (not the unit\'s)', async () => {
        let moves = 0;
        const env = { here: () => ({ x: 1600, y: -20, z: 1700 }), w: { kindAt: () => 'air' }, wrongDim: () => true, exec: async () => { moves++; return { ok: true }; }, travel: async () => { moves++; return { ok: true }; }, rejoin: async () => { moves++; return { ok: true }; } };
        const r = await pit.goToStation({ x: 81, y: 57, z: 17 }, async () => null, env, () => true, {});
        assert.strictEqual(r.reason, 'wrong_dimension'); assert.strictEqual(r.detail.botSide, true); assert.strictEqual(moves, 0);
    });

    await test('bridge toward a station: level bridge from the platform to the island flank, ends on land', async () => {
        const w = endWorld(), from = { x: 4, y: 49, z: 0 };
        assert.ok(gapAhead(w, from, { x: 60, z: 0 }, 0), 'void ahead');
        assert.ok(!gapAhead(w, { x: 2, y: 49, z: 0 }, { x: 0, z: 0 }, 0), 'platform ahead: no gap');
        const p = planToward(w, from, { x: 60, z: 0 });
        assert.ok(p.ok, JSON.stringify(p)); assert.strictEqual(p.stop, 'wall', 'the flank (stone at the feet level) ends it');
        assert.strictEqual(p.place.length, 35, 'x 5..39 get a block'); assert.ok(!p.landed);
        const q = planToward(w, from, { x: 60, z: 0 }, { maxLen: 10 }); assert.strictEqual(q.stop, 'length'); assert.strictEqual(q.place.length, 10);
    });

    await test('bridge toward: land with solid ground under the level ends the bridge there', async () => {
        const w = endWorld(); for (let x = 20; x <= 30; x++) w.set(x, 48, 0, 'solid');            // a stepping stone
        const p = planToward(w, { x: 4, y: 49, z: 0 }, { x: 60, z: 0 });
        assert.ok(p.ok); assert.ok(p.landed && p.stop === 'land'); assert.strictEqual(p.path[p.path.length - 1].x, 20); assert.strictEqual(p.place.length, 15);
    });

    await test('bridge toward: nothing to place, not loaded, no floor under the start', async () => {
        const w = endWorld();
        assert.strictEqual(planToward(w, { x: 4, y: 49, z: 0 }, { x: 4, z: 0 }).reason, 'invalid_target');
        assert.strictEqual(planToward(w, { x: 6, y: 49, z: 0 }, { x: 60, z: 0 }).reason, 'invalid_target', 'in mid-air');
        const unk = { ...w, kindAt: (x, y, z) => (x === 8 ? 'unknown' : w.kindAt(x, y, z)) };
        const p = planToward(unk, { x: 4, y: 49, z: 0 }, { x: 60, z: 0 }); assert.ok(p.ok); assert.strictEqual(p.stop, 'not_loaded'); assert.strictEqual(p.place.length, 3);
    });

    await test('bridgeToward: the move is run per straight segment, the result says what was laid', async () => {
        const w = endWorld(), bot = { x: 4, y: 49, z: 0 }, calls = [];
        const env = { w, here: () => ({ ...bot }), cancel: { cancelled: false }, run: async (name, a) => { calls.push([name, a.y, a.cells.length]); for (const c of a.cells) { w.set(c.x, a.y - 1, c.z, 'solid'); bot.x = c.x; bot.z = c.z; } return { ok: true, detail: { placed: a.cells.filter(() => true) } }; } };
        const r = await bridgeToward(env, { x: 60, z: 0 });
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(calls, [['bridge', 49, 35]]); assert.strictEqual(r.placed, 35);
        const bad = await bridgeToward({ ...env, w: endWorld(), here: () => ({ x: 4, y: 49, z: 0 }), run: async () => ({ ok: false, reason: 'missing_item', detail: { placed: [] } }) }, { x: 60, z: 0 });
        assert.strictEqual(bad.reason, 'missing_item'); assert.strictEqual(bad.detail.stage, 'bridge');
    });

    await test('goToStation: a gap toward the station is bridged (no pillar over the void), then the walk goes on', async () => {
        const w = endWorld(), bot = { x: 4, y: 49, z: 0 }, runs = [];
        const S = { x: 60, y: 56, z: 0 };
        const env = {
            w, here: () => ({ ...bot }), profile: () => ({ minY: 0 }), cancel: { cancelled: false },
            bridgeToward: async (to) => { const r = await bridgeToward(env, to); return r; }, gapOn: (to) => gapOn(w, bot, to, 0),
            run: async (name, a) => { runs.push(name); if (name === 'pillar') return { ok: false, reason: 'not_confirmed' }; for (const c of a.cells) { w.set(c.x, a.y - 1, c.z, 'solid'); bot.x = c.x; bot.z = c.z; } return { ok: true, detail: { placed: a.cells } }; },
            exec: async (name, a) => { if (name === 'move_to') { bot.x = a.x; bot.y = a.y; bot.z = a.z; return { ok: true }; } return { ok: true }; },
        };
        const r = await pit.goToStation(S, async () => null, env, (c) => w.kindAt(c.x, c.y, c.z) === 'air', {});
        assert.strictEqual(r, null, JSON.stringify(r)); assert.ok(runs.includes('bridge') && !runs.includes('pillar'), runs.join());
        assert.strictEqual(w.kindAt(39, 48, 0), 'solid', 'the bridge lies up to the flank'); assert.strictEqual(bot.x, 60, 'and the walk went on to the station');
    });

    await test('goToStation: over a void the learned walk (env.travel) takes the bot to the exact station cell first; when it fails the ladder (gap bridge) still runs', async () => {
        const w = endWorld(), bot = { x: 4, y: 49, z: 0 }, S = { x: 60, y: 49, z: 3 }, calls = [];
        const mk = (travel) => ({
            w, here: () => ({ ...bot }), profile: () => ({ minY: 0, voidBelow: true }), cancel: { cancelled: false }, travel,
            bridgeToward: async (to) => bridgeToward(env2, to), gapOn: (to) => gapOn(w, bot, to, 0),
            run: async (name, a) => { calls.push(name); for (const c of a.cells) { w.set(c.x, a.y - 1, c.z, 'solid'); bot.x = c.x; bot.z = c.z; } return { ok: true, detail: { placed: a.cells } }; },
            exec: async (name, a) => { calls.push(`move ${a.x},${a.y},${a.z}`); bot.x = a.x; bot.y = a.y; bot.z = a.z; return { ok: true }; },
        });
        let env2 = mk(async (to, o) => { calls.push(`travel ${to.x},${to.y},${to.z} near ${o.near}`); bot.x = to.x; bot.y = to.y; bot.z = to.z; return { ok: true }; });
        let r = await pit.goToStation(S, async () => null, env2, (c) => w.kindAt(c.x, c.y, c.z) === 'air', {});
        assert.strictEqual(r, null, JSON.stringify(r)); assert.deepStrictEqual(calls, ['travel 60,49,3 near 0'], 'the exact cell, no ladder');
        // the walk fails (not fatal): the ladder runs as before
        calls.length = 0; bot.x = 4; bot.y = 49; bot.z = 0;
        env2 = mk(async () => { calls.push('travel'); return { ok: false, reason: 'stuck' }; });
        r = await pit.goToStation(S, async () => null, env2, (c) => w.kindAt(c.x, c.y, c.z) === 'air', {});
        assert.strictEqual(r, null, JSON.stringify(r)); assert.ok(calls[0] === 'travel' && calls.includes('bridge'), calls.join());
        // a fatal reason ends the unit as the bot's own trouble
        calls.length = 0; bot.x = 4; bot.y = 49; bot.z = 0;
        env2 = mk(async () => ({ ok: false, reason: 'died' }));
        r = await pit.goToStation(S, async () => null, env2, (c) => w.kindAt(c.x, c.y, c.z) === 'air', {});
        assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'died'); assert.strictEqual(r.detail.botSide, true);
    });

    await test('goToStation: a bot standing inside a base beside the void walks to the edge first, then bridges', async () => {
        const w = endWorld(), bot = { x: 1, y: 49, z: 0 }, runs = [], S = { x: 60, y: 56, z: 0 };
        const env = {
            w, here: () => ({ ...bot }), profile: () => ({ minY: 0 }), cancel: { cancelled: false },
            bridgeToward: async (to) => bridgeToward(env, to), gapOn: (to) => gapOn(w, bot, to, 0),
            run: async (name, a) => { runs.push(name); for (const c of a.cells) { w.set(c.x, a.y - 1, c.z, 'solid'); bot.x = c.x; bot.z = c.z; } return { ok: true, detail: { placed: a.cells } }; },
            exec: async (name, a) => { runs.push(`move ${a.x}`); bot.x = a.x; bot.y = a.y; bot.z = a.z; return { ok: true }; },
        };
        const g = gapOn(w, bot, S, 0); assert.deepStrictEqual([g.edge.x, g.atEdge], [4, false]);
        const r = await pit.goToStation(S, async () => null, env, (c) => w.kindAt(c.x, c.y, c.z) === 'air', {});
        assert.strictEqual(r, null, JSON.stringify(r)); assert.deepStrictEqual(runs.slice(0, 2), ['move 4', 'bridge'], runs.join());
        assert.strictEqual(gapOn(w, { x: 40, y: 56, z: 0 }, { x: 60, z: 0 }, 0), null, 'land all the way: no gap');
    });

    await test('launchCell: a bot on a base whose own level is walled in is sent to the top of the wall, from which the gap is bridged', async () => {
        const w = endWorld();
        for (let x = 5; x <= 12; x++) for (let z = -2; z <= 2; z++) w.set(x, 46, z, 'solid');        // a base east of the platform at y 46 (feet 47)
        for (let z = -2; z <= 2; z++) { w.set(12, 47, z, 'solid'); w.set(12, 48, z, 'solid'); }       // a wall at its far edge: the line at the base's own level is blocked
        const base = { x: 9, y: 47, z: 0 }, S = { x: 60, y: 56, z: 0 };
        assert.strictEqual(gapOn(w, base, S, 0), null, 'blocked at the base level');
        const c = launchCell(w, base, S, 0); assert.ok(c, 'a launch cell'); assert.strictEqual(c.y, 49, 'on top of the wall'); assert.ok(gapOn(w, c, S, 0));
        const many = launchCells(w, base, S, 0, { n: 3 }); assert.ok(many.length >= 2 && many.length <= 3, 'several distinct places, nearest first'); for (let i = 1; i < many.length; i++) assert.ok(Math.hypot(many[i].x - many[0].x, many[i].z - many[0].z) + Math.abs(many[i].y - many[0].y) > 3);
        assert.strictEqual(launchCell(w, { x: 100, y: 60, z: 100 }, S, 0), null, 'nothing to launch from far from any edge (radius 12)');
    });

    await test('goToStation: the pillar rise is only for a station above the bot\'s own column (not 30 blocks away)', async () => {
        const w = { kindAt: (x, y, z) => (y <= 48 ? 'solid' : 'air') }, runs = [];
        const env = { w, here: () => ({ x: 0, y: 49, z: 0 }), cancel: { cancelled: false }, run: async (name) => { runs.push(name); return { ok: true, detail: {} }; }, exec: async () => ({ ok: false, reason: 'unreachable' }), rejoin: async () => ({ ok: false, reason: 'refused' }) };
        const r = await pit.goToStation({ x: 30, y: 60, z: 0 }, async () => null, env, (c) => w.kindAt(c.x, c.y, c.z) === 'air', {});
        assert.ok(r && r.reason === 'unreachable' && r.detail.stage === 'station', JSON.stringify(r)); assert.ok(!runs.includes('pillar'));
    });

    await test('stepOffCell: a neighbour that is surely standable, one level down first-class (an Ender chest on an iron floor)', async () => {
        // The bot stands in cell y 22 on a chest (solid at y 21 in the model it cannot start from); the floor around it is iron at y 20.
        const k = (x, y, z) => (y <= 20 ? 'solid' : (x === 5 && z === 5 && y === 21) ? 'partial' : 'air');
        const w = { kindAt: k };
        const c = stepOffCell(w, { x: 5, y: 22, z: 5 });
        assert.ok(c, 'found'); assert.strictEqual(c.y, 21, 'down onto the iron floor'); assert.strictEqual(Math.abs(c.x - 5) + Math.abs(c.z - 5), 1);
        assert.strictEqual(stepOffCell({ kindAt: () => 'air' }, { x: 0, y: 0, z: 0 }), null, 'a drop all round: nowhere to step');
    });

    console.log('ALL OK'); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
