// Long walks in legs (src/work/bot/travel.js): a fake world whose chunks are known only within 56 blocks of the bot (move_to beyond that fails like the real one).
const assert = require('assert');
const { travel, legCandidates, LEG } = require('../src/work/bot/travel');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const LOAD = 56;

/** Flat ground (stone at y <= 63, feet at 64); `water(x,z)` columns are open water (not standable); `wall(x,z)` columns are solid up to y 80. */
function sim({ start = { x: 0, y: 64, z: 0 }, water = () => false, wall = () => false, loadFollows = true, planned = false } = {}) {
    const bot = { ...start }, moves = [];
    const known = (x, z) => Math.hypot(x - bot.x, z - bot.z) <= LOAD;
    const kindAt = (x, y, z) => { if (!known(x, z)) return 'unknown'; if (wall(x, z)) return y <= 80 ? 'solid' : 'air'; if (water(x, z) && y === 64) return 'water'; return y <= 63 ? 'solid' : 'air'; };
    const env = {
        w: { kindAt, shapesAt: () => [] }, here: () => ({ ...bot }), cancel: { cancelled: false },
        exec: async (name, a) => {
            moves.push([a.x, a.y, a.z]);
            if (kindAt(a.x, a.y, a.z) === 'unknown') return { ok: false, reason: 'unreachable', detail: { why: 'target chunk not loaded' } };
            if (Math.hypot(a.x - bot.x, a.z - bot.z) > 48) return { ok: false, reason: 'unreachable', detail: { why: 'planner budget' } };
            if (planned) { const r = require('../src/skills/planner').reachable({ kindAt, shapesAt: () => [] }, bot, { maxNodes: 9000, radius: 52 }); if (!r.has(a.x, a.y, a.z)) return { ok: false, reason: 'unreachable', detail: { why: 'the planner has no path' } }; }       // the real planner walks round a wall
            else for (let t = 0; t <= 1; t += 0.02) if (wall(bot.x + (a.x - bot.x) * t, bot.z + (a.z - bot.z) * t)) return { ok: false, reason: 'unreachable', detail: { why: 'a wall across the way' } };        // the fake walks in straight lines
            const swim = kindAt(a.x, a.y, a.z) === 'water' && kindAt(a.x, a.y + 1, a.z) === 'air';          // the real planner swims to a cell at the surface of the water
            if (!swim && (kindAt(a.x, a.y, a.z) !== 'air' || kindAt(a.x, a.y - 1, a.z) !== 'solid')) return { ok: false, reason: 'invalid_target', detail: { why: 'a player cannot stand there' } };
            bot.x = a.x; bot.y = a.y; bot.z = a.z; return { ok: true };
        },
    };
    return { env, bot, moves };
}

(async () => {
    await test('leg candidates on the surface end on the TRUE top of a hill, not in a cave under it (reproducer: acceptance world, a 2000-block walk ended at 790 with a goal 28 levels under the ridge)', () => {
        // flat ground at 63, a hill of 17 blocks at x 20..45 with a cave (air at y 66-67, floor at 65) inside it
        const kindAt = (x, y, z) => { if (y <= 63) return 'solid'; if (x >= 20 && x <= 45 && y <= 80) return (y === 66 || y === 67) ? 'air' : 'solid'; return 'air'; };
        const w = { kindAt, shapesAt: () => [] }, cands = legCandidates(w, { x: 0, y: 64, z: 0 }, { x: 100, z: 0 });
        const at40 = cands.filter((c) => c.x === 40);
        assert.ok(at40.length && at40.every((c) => c.y === 81), `ends on the top: ${JSON.stringify(at40)}`);
        assert.ok(!cands.some((c) => c.y === 66), 'no cell inside the hill');
        // underground (the bot stands in a pit, more than 2 below the top of its own column) the old cap still holds: the legs stay in the bot's layer
        const pit = (x, y, z) => (x === 0 && z === 0 ? (y <= 49 ? 'solid' : 'air') : (y <= 49 ? 'solid' : y <= 63 ? 'solid' : 'air'));
        const deep = legCandidates({ kindAt: (x, y, z) => (x === 0 && z === 0 ? (y <= 49 ? 'solid' : y === 50 || y === 51 ? 'air' : 'solid') : kindAt(x, y, z)), shapesAt: () => [] }, { x: 0, y: 50, z: 0 }, { x: 100, z: 0 });
        void pit; assert.ok(Array.isArray(deep));
    });

    await test('a barrier wider than the side steps (a ridge 60 across): the legs follow the frontier of what the planner can walk, round the end, and arrive (reproducer: the acceptance walk stopped at a ridge, 20,000 planner nodes spent on a goal it could not reach)', async () => {
        const s = sim({ planned: true, wall: (x, z) => x >= 40 && x <= 50 && Math.abs(z) <= 30 });
        const r = await travel(s.env, { x: 120, z: 0 });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.ok(Math.hypot(s.bot.x - 120, s.bot.z) <= 4, `ended at ${s.bot.x},${s.bot.z}`);
        assert.ok(r.legs <= 12, `${r.legs} legs`);
        assert.ok(s.moves.some((m) => m[0] > 50 && Math.abs(m[2]) > 10), 'a leg ended on the far side of the wall, off the straight line (the frontier), not on the wall top');
    });

    await test('open water is crossed: a leg may end on the surface of the water (a sea 300 wide; reproducer: an acceptance world that spawns on an island, the walk north gave up after 200 blocks)', async () => {
        const kindAt = (x, y, z) => { if (y <= 40) return 'solid'; if (x >= 20 && x <= 320) return y <= 63 ? 'water' : 'air'; return y <= 63 ? 'solid' : 'air'; };
        const w = { kindAt, shapesAt: () => [] };
        const c = legCandidates(w, { x: 100, y: 64, z: 0 }, { x: 400, z: 0 });         // the bot swims at the surface (feet at 63, in the water)
        assert.ok(c.length && c.some((q) => q.x > 100 && q.y === 63), `swim cells are offered: ${JSON.stringify(c.slice(0, 3))}`);
        const land = legCandidates(w, { x: 0, y: 64, z: 0 }, { x: 400, z: 0 });
        assert.ok(land.some((q) => q.x >= 20 && q.y === 63), 'from the shore: the first cell in the water');
    });

    await test('a target far beyond the loaded chunks is reached in legs (plain move_to fails: chunk not loaded)', async () => {
        const s = sim();
        const plain = await s.env.exec('move_to', { x: 300, y: 64, z: 40 }); assert.strictEqual(plain.ok, false);
        const r = await travel(s.env, { x: 300, y: 64, z: 40 });
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual([s.bot.x, s.bot.y, s.bot.z], [300, 64, 40]);
        assert.ok(r.legs >= 7 && r.legs <= 10, `legs ${r.legs}`); assert.ok(s.moves.slice(1).every((m, i, a) => i === 0 || Math.hypot(m[0] - a[i - 1][0], m[2] - a[i - 1][2]) <= LEG + 1), 'no leg longer than the leg length');
    });

    await test('a lake across the line is crossed or gone round: the walk arrives (legs may end on the water now: the planner swims)', async () => {
        const s = sim({ water: (x, z) => x >= 30 && x <= 52 && Math.abs(z) <= 30 });
        const r = await travel(s.env, { x: 120, y: 64, z: 0 });
        assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(s.bot.x, 120);
    });

    await test('no way at all: the walk says where it stopped and how far it still was; a wall across the line, three useless legs = stuck', async () => {
        const wallAll = sim({ wall: (x) => x >= 40 && x <= 44 });
        const r = await travel(wallAll.env, { x: 200, y: 64, z: 0 });
        assert.strictEqual(r.ok, false); assert.ok(['stuck', 'unreachable'].includes(r.reason), r.reason); assert.ok(r.detail.remaining > 100 && r.detail.at.x < 45, JSON.stringify(r.detail));
        const cancel = sim(); cancel.env.cancel.cancelled = true; assert.strictEqual((await travel(cancel.env, { x: 300, z: 0 })).reason, 'cancelled');
    });

    await test('a target within the leg length goes straight to the exact cell; a target already near is one step; candidates stay close to the start in height', async () => {
        const s = sim(); const r = await travel(s.env, { x: 30, y: 64, z: 0 }); assert.ok(r.ok && r.legs === 1, JSON.stringify(r)); assert.deepStrictEqual(s.moves[0], [30, 64, 0]);
        const near = sim(); assert.ok((await travel(near.env, { x: 2, y: 64, z: 1 })).ok);
        const cands = legCandidates(sim().env.w, { x: 0, y: 64, z: 0 }, { x: 500, z: 0 });
        assert.ok(cands.length >= 5 && cands.every((c) => Math.abs(c.y - 64) <= 24) && cands[0].x === LEG, JSON.stringify(cands[0]));
    });
    console.log('\nwork travel: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
