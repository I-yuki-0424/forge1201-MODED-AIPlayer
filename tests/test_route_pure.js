// The chunk-exit router (src/experts/route, docs/implemented/ROUTE-v1.md): the candidate geometry, the waypoint rule, the policy file, and walks on the training simulator's worlds
// (the real path calculator, the bots' view limit). Pure test, no server.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../src/experts/route/candidates');
const P = require('../src/experts/route/policy');
const F = require('../src/experts/route/features');
const stats = require('../src/experts/route/stats');
const { route, heuristicModel } = require('../src/experts/route/router');
const S = require('../tools/route/sim');

const queue = [];
const test = (name, fn) => queue.push([name, fn]);
/** A flat world of stone (feet at y 64), everything known. */
const flat = (extra = () => null) => ({ kindAt: (x, y, z) => { const e = extra(x, y, z); if (e) return e; return y <= 63 ? 'solid' : 'air'; } });
const botOn = (w, start) => { const pos = { ...start }, moves = []; return { pos, moves, env: { w, here: () => ({ ...pos }), cancel: { cancelled: false }, exec: async (n, a) => { moves.push([a.x, a.y, a.z]); pos.x = a.x; pos.y = a.y; pos.z = a.z; return { ok: true }; } } }; };

test('chunk step: the next chunk on the straight chunk line, diagonal only when both axes matter', () => {
    assert.deepStrictEqual(C.chunkStep({ x: 0, z: 0 }, { x: 10, z: 0 }), { x: 1, z: 0 });
    assert.deepStrictEqual(C.chunkStep({ x: 0, z: 0 }, { x: 10, z: 3 }), { x: 1, z: 0 });
    assert.deepStrictEqual(C.chunkStep({ x: 0, z: 0 }, { x: 10, z: 6 }), { x: 1, z: 1 });
    assert.deepStrictEqual(C.chunkStep({ x: 5, z: 5 }, { x: -3, z: 5 }), { x: -1, z: 0 });
    assert.deepStrictEqual(C.chunkStep({ x: 2, z: 2 }, { x: 2, z: 2 }), { x: 0, z: 0 });
});

test('waypoints: one per 3 blocks of the straight-line distance, rounded down', () => {
    assert.deepStrictEqual([0, 2.9, 3, 5.9, 6, 14].map(C.waypointCount), [0, 0, 1, 1, 2, 4]);
});

test('exit candidates: the first row of the chunk beyond the border, 16 columns, forward side; lateral sides too; back only on demand; negative chunks', () => {
    const w = flat(), here = { x: 5, y: 64, z: 5 }, to = { x: 100, y: 64, z: 5 };
    const c = C.exitCandidates(w, here, to);
    const fwd = c.filter((q) => q.side === 'fwd'), lat = c.filter((q) => q.side === 'lat');
    assert.strictEqual(fwd.length, 16); assert.ok(fwd.every((q) => q.x === 16 && q.y === 64 && q.z >= 0 && q.z <= 15), 'the column x = 16, z of this chunk');
    assert.strictEqual(lat.length, 32); assert.ok(c.every((q) => q.side !== 'back'));
    assert.strictEqual(C.exitCandidates(w, here, to, { back: true }).filter((q) => q.side === 'back').length, 16);
    const neg = C.exitCandidates(w, { x: -3, y: 64, z: -3 }, { x: -100, y: 64, z: -3 }).filter((q) => q.side === 'fwd');
    assert.ok(neg.every((q) => q.x === -17), 'chunk -1 spans -16..-1, the next chunk westward starts at -17 going down');
    const diag = C.exitCandidates(w, here, { x: 100, y: 64, z: 80 }), corner = diag.filter((q) => q.diag);
    assert.strictEqual(corner.length, 1); assert.deepStrictEqual([corner[0].x, corner[0].z], [16, 16]);
});

test('exit candidates keep the standable cells nearest the bot\'s level, several levels of one column (a ledge over a cave)', () => {
    const w = flat((x, y, z) => (x === 16 && z === 3 ? (y <= 40 || y === 50 || y === 51 ? 'solid' : 'air') : null));        // column 16,3: floor at 41, a ledge at 52
    const c = C.exitCandidates(w, { x: 5, y: 64, z: 5 }, { x: 100, y: 64, z: 5 }, { ty: 41 }).filter((q) => q.x === 16 && q.z === 3);
    assert.deepStrictEqual(c.map((q) => q.y).sort((a, b) => a - b), [41, 52]);
});

test('the policy file: vector and document round-trip, scores equal, wrong dimensions refused', () => {
    const v = P.heuristicVector(); for (let i = P.DIN; i < v.length; i++) v[i] = Math.sin(i) * 0.3;
    const m = P.fromVector(v), m2 = P.load(JSON.parse(JSON.stringify(P.toDoc(m))));
    const feat = Float64Array.from({ length: 3 * F.DK }, (_, i) => Math.cos(i)), ctx = Float64Array.from({ length: F.DC }, (_, i) => i / 10);
    const a = P.scores(m, feat, ctx, 3), b = P.scores(m2, feat, ctx, 3);
    for (let k = 0; k < 3; k++) assert.ok(Math.abs(a[k] - b[k]) < 1e-4, `score ${k}`);
    assert.throws(() => P.fromVector(new Float64Array(10)), /parameters/); assert.throws(() => P.load({ kind: 'route', dk: 1, dc: 1 }), /document is for/);
    assert.strictEqual(P.argmax(new Float64Array([1, 3, 3, 2])), 1); assert.strictEqual(P.argmax(new Float64Array(0)), -1);
});

test('the shipped policy loads and has the layout of the code', () => {
    const file = path.join(__dirname, '..', 'models', 'experts', 'route.json');
    if (!fs.existsSync(file)) return;
    const m = P.load(JSON.parse(fs.readFileSync(file, 'utf8'))); assert.strictEqual(m.hidden, P.HIDDEN);
});

test('features: progress, tabu and visits are what the policy is told; the context says the mode', () => {
    const w = flat(), here = { x: 5, y: 64, z: 5 }, to = { x: 100, y: 64, z: 5 }, cands = C.exitCandidates(w, here, to);
    const mem = { visits: new Map([['1,0', 2]]), failed: [{ x: 16, y: 64, z: 5 }], prev: null }, reach = C.reachMap(w, here);
    const b = F.build({ w, here, to, ty: 64, cands, reach, mem, legs: 3, stalls: 1, failsLeg: 1, wp: false });
    const k = b.cands.findIndex((q) => q.x === 16 && q.z === 5), j = b.cands.findIndex((q) => q.x === 16 && q.z === 12);
    assert.strictEqual(b.feat[k * F.DK + 14], 1, 'tabu'); assert.strictEqual(b.feat[j * F.DK + 14], 0);
    assert.ok(b.feat[j * F.DK + 0] > 0.3, 'progress'); assert.strictEqual(b.feat[j * F.DK + 13], 2 / 3, 'visits of the chunk (1,0)');
    assert.strictEqual(b.feat[j * F.DK + 6], 1, 'reached by the path calculator'); assert.strictEqual(b.ctx[4], 0); assert.ok(b.cands.length <= C.MAX_K);
});

test('open ground far away: arrives, the number of decisions matches the chunks, and the last leg is the exact cell', async () => {
    const w = flat(), s = botOn(w, { x: 3, y: 64, z: 3 });
    const r = await route(s.env, { x: 200, y: 64, z: 40 }, { model: heuristicModel() });
    assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual([s.pos.x, s.pos.y, s.pos.z], [200, 64, 40]);
    assert.ok(r.route.decisions >= 12 && r.route.decisions <= 30, `decisions ${r.route.decisions}`);
});

test('waypoints in the destination chunk: floor(distance / 3) moves, the last one onto the target', async () => {
    const w = flat(), s = botOn(w, { x: 1, y: 64, z: 1 });
    const r = await route(s.env, { x: 13, y: 64, z: 8 }, { model: heuristicModel() });                 // 13.9 blocks: 4 waypoints
    assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(s.moves.length, 4, JSON.stringify(s.moves)); assert.deepStrictEqual(s.moves[3], [13, 64, 8]);
    const t = botOn(w, { x: 1, y: 64, z: 1 }); assert.ok((await route(t.env, { x: 3, y: 64, z: 2 }, { model: heuristicModel() })).ok); assert.strictEqual(t.moves.length, 1, 'closer than 3: just the exact step');
});

test('a failed move is remembered: the next decision does not pick the same exit, and four failures in a row end the walk with the reason', async () => {
    const w = flat(), s = botOn(w, { x: 3, y: 64, z: 3 }), tried = [];
    s.env.exec = async (n, a) => { tried.push(`${a.x},${a.z}`); return { ok: false, reason: 'unreachable', detail: { why: 'x' } }; };
    const r = await route(s.env, { x: 200, y: 64, z: 3 }, { model: heuristicModel() });
    assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'unreachable'); assert.strictEqual(tried.length, 4); assert.strictEqual(new Set(tried).size, 4, 'four different exits');
});

test('cancel, wrong dimension and a fatal reason end the walk at once', async () => {
    const w = flat(), s = botOn(w, { x: 3, y: 64, z: 3 }); s.env.cancel.cancelled = true;
    assert.strictEqual((await route(s.env, { x: 200, y: 64, z: 3 })).reason, 'cancelled');
    const d = botOn(w, { x: 3, y: 64, z: 3 }); d.env.wrongDim = () => true; assert.strictEqual((await route(d.env, { x: 200, y: 64, z: 3 })).reason, 'wrong_dimension');
    const k = botOn(w, { x: 3, y: 64, z: 3 }); k.env.exec = async () => ({ ok: false, reason: 'died' }); assert.strictEqual((await route(k.env, { x: 200, y: 64, z: 3 })).reason, 'died');
});

test('a level target (a chest, a station): ends within near across and nearY levels, no exact last step', async () => {
    const w = flat(), s = botOn(w, { x: 3, y: 64, z: 3 });
    const r = await route(s.env, { x: 60, z: 3, level: 64 }, { near: 6, model: heuristicModel() });
    assert.ok(r.ok, JSON.stringify(r)); assert.ok(Math.hypot(s.pos.x - 60, s.pos.z - 3) <= 6);
});

test('the simulator worlds: a lake, a cliff and a pit that the old legs fail are walked (heuristic policy, real path calculator)', async () => {
    const { travel } = require('../src/work/bot/travel');
    let routed = 0, legacy = 0, n = 0;
    for (const kind of ['lake', 'cliff', 'pit']) for (let seed = 1; seed <= 4; seed++) {
        const p = S.place(S.scenario(seed, kind), seed), b = new S.SimBot(p), r = await route(b.env(), p.target, { model: heuristicModel(), near: 3, maxDecisions: 60 });
        const q = S.place(S.scenario(seed, kind), seed), b2 = new S.SimBot(q), r2 = await travel(b2.env(), q.target);
        n++; routed += r.ok ? 1 : 0; legacy += r2.ok ? 1 : 0;
    }
    assert.ok(routed >= legacy + 4, `router ${routed}/${n}, legacy ${legacy}/${n}`);
});

test('the simulator is deterministic and the bot sees only its 9 x 9 chunks', () => {
    const a = S.place(S.scenario(7, 'ridge'), 7), b = S.place(S.scenario(7, 'ridge'), 7);
    assert.deepStrictEqual([a.here, a.target], [b.here, b.target]);
    assert.strictEqual(a.world.kindAt(a.here.x + 16 * 5, 64, a.here.z), 'unknown'); assert.notStrictEqual(a.world.kindAt(a.here.x + 16 * 3, 70, a.here.z), 'unknown');
});

test('stats: window and totals, the caller\'s outcome counted once', () => {
    stats.reset();
    stats.record('router', { ok: false, reason: 'stuck', route: { decisions: 5, fails: 2, prepMs: 3, thinkMs: 1, thinkMaxMs: 0.5, execMs: 10 } }, 20);
    stats.record('legacy', { ok: true }, 5); stats.final({ ok: true });
    const w = stats.take();
    assert.strictEqual(w.router.calls, 1); assert.deepStrictEqual(w.router.fail, { stuck: 1 }); assert.strictEqual(w.legacy.ok, 1); assert.strictEqual(w.final.calls, 1); assert.strictEqual(w.router.decisions, 5);
    assert.strictEqual(stats.take().router.calls, 0); assert.strictEqual(stats.totals().router.calls, 1);
});

(async () => { for (const [name, fn] of queue) { console.log(`--- test: ${name} ---`); await fn(); console.log('[OK]'); } console.log(`${queue.length} tests passed`); })().catch((e) => { console.error(e); process.exit(1); });
