// Long walks in legs (src/work/bot/travel.js): a fake world whose chunks are known only within 56 blocks of the bot (move_to beyond that fails like the real one).
const assert = require('assert');
const { travel, legCandidates, LEG } = require('../src/work/bot/travel');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const LOAD = 56;

/** Flat ground (stone at y <= 63, feet at 64); `water(x,z)` columns are open water (not standable); `wall(x,z)` columns are solid up to y 80. */
function sim({ start = { x: 0, y: 64, z: 0 }, water = () => false, wall = () => false, loadFollows = true } = {}) {
    const bot = { ...start }, moves = [];
    const known = (x, z) => Math.hypot(x - bot.x, z - bot.z) <= LOAD;
    const kindAt = (x, y, z) => { if (!known(x, z)) return 'unknown'; if (wall(x, z)) return y <= 80 ? 'solid' : 'air'; if (water(x, z) && y === 64) return 'water'; return y <= 63 ? 'solid' : 'air'; };
    const env = {
        w: { kindAt, shapesAt: () => [] }, here: () => ({ ...bot }), cancel: { cancelled: false },
        exec: async (name, a) => {
            moves.push([a.x, a.y, a.z]);
            if (kindAt(a.x, a.y, a.z) === 'unknown') return { ok: false, reason: 'unreachable', detail: { why: 'target chunk not loaded' } };
            if (Math.hypot(a.x - bot.x, a.z - bot.z) > 48) return { ok: false, reason: 'unreachable', detail: { why: 'planner budget' } };
            for (let t = 0; t <= 1; t += 0.02) if (wall(bot.x + (a.x - bot.x) * t, bot.z + (a.z - bot.z) * t)) return { ok: false, reason: 'unreachable', detail: { why: 'a wall across the way' } };        // the fake walks in straight lines
            if (kindAt(a.x, a.y, a.z) !== 'air' || kindAt(a.x, a.y - 1, a.z) !== 'solid') return { ok: false, reason: 'invalid_target', detail: { why: 'a player cannot stand there' } };
            bot.x = a.x; bot.y = a.y; bot.z = a.z; return { ok: true };
        },
    };
    return { env, bot, moves };
}

(async () => {
    await test('a target far beyond the loaded chunks is reached in legs (plain move_to fails: chunk not loaded)', async () => {
        const s = sim();
        const plain = await s.env.exec('move_to', { x: 300, y: 64, z: 40 }); assert.strictEqual(plain.ok, false);
        const r = await travel(s.env, { x: 300, y: 64, z: 40 });
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual([s.bot.x, s.bot.y, s.bot.z], [300, 64, 40]);
        assert.ok(r.legs >= 7 && r.legs <= 10, `legs ${r.legs}`); assert.ok(s.moves.slice(1).every((m, i, a) => i === 0 || Math.hypot(m[0] - a[i - 1][0], m[2] - a[i - 1][2]) <= LEG + 1), 'no leg longer than the leg length');
    });

    await test('a lake across the line is gone round: a leg that cannot be stood in is tried shorter and to the side', async () => {
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
