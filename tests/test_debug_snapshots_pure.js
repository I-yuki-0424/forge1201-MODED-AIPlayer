'use strict';
// Stuck snapshots (TASK-20261127-084): the PNG encoder (read back with zlib alone), the renderer on a known scene (a bot on a floating bottom slab, a bed, an open trapdoor;
// pixels compared), the server's truth, the progress picture, the triggers and their limits, the byte budget, a whole event written by the watcher, and the console's
// routes (session, closed paths, no traversal). Each with a negative control.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const P = require('../src/debug/png');
const S = require('../src/debug/scene');
const Rn = require('../src/debug/render');
const { Textures } = require('../src/debug/textures');
const W = require('../src/debug/stuck');

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ok ${name}`); }
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

/** Read a PNG with zlib alone: { w, h, type, plte, rows (filter byte stripped) }; checks every chunk's CRC. */
function readBack(buf) {
    assert.ok(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'signature');
    let o = 8, w, h, type, plte = null; const idat = [];
    while (o < buf.length) {
        const len = buf.readUInt32BE(o), t = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
        assert.strictEqual(buf.readUInt32BE(o + 8 + len), (P.crc32(d, P.crc32(Buffer.from(t))) ^ 0xffffffff) >>> 0, `crc of ${t}`);
        if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); type = d[9]; } else if (t === 'PLTE') plte = d; else if (t === 'IDAT') idat.push(d);
        o += 12 + len;
    }
    const z = zlib.inflateSync(Buffer.concat(idat)), bpp = type === 6 ? 4 : 1, rows = [];
    for (let y = 0; y < h; y++) { assert.strictEqual(z[y * (w * bpp + 1)], 0, 'filter 0'); rows.push(z.subarray(y * (w * bpp + 1) + 1, (y + 1) * (w * bpp + 1))); }
    return { w, h, type, plte, rows };
}

/** The test scene: grass at y 60; a bottom slab floating at y 64 with the bot on it; a bed and an open trapdoor at y 61 on the bot's line (it faces east). */
function scene(slab = [[0, 0, 0, 1, 0.5, 1]]) {
    const map = new Map(), put = (x, y, z, name, shapes, props = {}) => map.set(`${x},${y},${z}`, { name, shapes, props });
    for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) put(x, 60, z, 'grass_block', [[0, 0, 0, 1, 1, 1]]);
    put(0, 64, 0, 'smooth_stone_slab', slab, { type: 'bottom' });
    put(2, 61, 0, 'red_bed', [[0, 0, 0, 1, 0.5625, 1]], { part: 'foot', facing: 'east' });
    put(-2, 61, 0, 'oak_trapdoor', [[0, 0, 0, 0.1875, 1, 1]], { open: true, facing: 'east' });
    put(0, 66, 0, 'stone', [[0, 0, 0, 1, 1, 1]]);
    const at = (x, y, z) => map.get(`${x},${y},${z}`) || { name: 'air', shapes: [], props: {} };
    return S.capture(at, { x: 0.5, y: 64.5, z: 0.5 }, -Math.PI / 2, {});           // yaw -pi/2: looking to +X (east)
}

(async () => {
    await test('png: RGBA and indexed PNGs read back with zlib alone (CRCs, rows, palette) and with the decoder; a changed pixel reads back changed; not a PNG is refused', async () => {
        const w = 5, h = 3, px = new Uint8Array(w * h * 4); for (let i = 0; i < w * h; i++) px.set([i * 10, 255 - i * 10, (i * 37) & 255, 255], i * 4);
        const a = readBack(P.encode(w, h, px)); assert.deepStrictEqual([a.w, a.h, a.type], [5, 3, 6]);
        assert.deepStrictEqual([...a.rows[1].subarray(0, 4)], [50, 205, (5 * 37) & 255, 255], 'row 1 pixel 0');
        const d = P.decode(await P.encodeAsync(w, h, px)); assert.deepStrictEqual(Buffer.from(d.data), Buffer.from(px), 'decoder round trip');
        const q = await P.encodeIndexedAsync(w, h, px), b = readBack(q.png);
        assert.strictEqual(b.type, 3); assert.strictEqual(q.lossy, false, '15 colours: exact');
        const k = b.rows[2][4]; assert.deepStrictEqual([...b.plte.subarray(k * 3, k * 3 + 3)], [140, 115, (14 * 37) & 255], 'palette entry of the last pixel');
        assert.deepStrictEqual(Buffer.from(P.decode(q.png).data), Buffer.from(px), 'indexed decodes exactly');
        const px2 = Uint8Array.from(px); px2[0] = 1;                                            // negative control
        assert.notDeepStrictEqual(Buffer.from(P.decode(P.encode(w, h, px2)).data), Buffer.from(px));
        const many = new Uint8Array(32 * 32 * 4); for (let i = 0; i < 1024; i++) many.set([i & 255, (i >> 2) & 255, (i * 7) & 255, 255], i * 4);
        assert.strictEqual((await P.encodeIndexedAsync(32, 32, many)).lossy, true, 'over 256 colours: quantised');
        assert.throws(() => P.decode(Buffer.from('GIF89a not a png at all, padding padding')), /not a PNG/);
    });

    await test('render: slab half high under the body, bed 9/16, open trapdoor a thin wall at its west edge, body box from the exact position; a full block instead of the slab fills the upper half (control)', async () => {
        const tex = new Textures(null), C = Rn.C, sc = scene(), r = Rn.panel(sc, 'along', 'bot', tex).r;
        assert.strictEqual(sc.dir, 'east');
        const R = sc.r, px = (a, y, fu, fy) => r.get(Math.floor((a - sc.c.x + R + fu) * C), Math.floor((sc.c.y + R + 1 - y - fy) * C));         // cell a (x), y; fractions
        const sky = (p) => p.join() === Rn.SKY.join();
        assert.ok(!sky(px(0, 64, 0.1, 0.25)), 'slab: lower half drawn');
        assert.ok(sky(px(0, 64, 0.1, 0.75)), 'slab: upper half is air');
        assert.ok(!sky(px(2, 61, 0.5, 0.5)) && sky(px(2, 61, 0.5, 0.7)), 'bed: 9/16 high');
        assert.ok(!sky(px(-2, 61, 0.08, 0.5)) && sky(px(-2, 61, 0.5, 0.5)), 'open trapdoor: a thin wall at the west edge');
        Rn.overlays(sc, 'along', { r, toPx: (x, y, z) => [(x - sc.c.x + R) * C, (sc.c.y + R + 1 - y) * C] });
        assert.deepStrictEqual(px(0, 64, 0.2, 0.5 + 0.9).slice(), Rn.COL.body, 'body box edge at x - 0.3, from the feet at y + 0.5');
        const full = Rn.panel(scene([[0, 0, 0, 1, 1, 1]]), 'along', 'bot', tex).r;               // negative control
        assert.ok(!sky(full.get(Math.floor((R + 0.1) * C), Math.floor((R + 0.25) * C))), 'a full block fills the upper half');
        const top = Rn.panel(sc, 'top', 'bot', tex).r; assert.strictEqual(sc.usualDepth, 4, 'the ground is mostly 4 under the feet');
        assert.ok(!sky(top.get((R + 0.5) * C | 0, (R + 0.5) * C | 0)), 'top: the slab is under the body');
        const pic = Rn.picture(sc, 'across', tex); assert.ok(pic.w > 2 * C * 13 / 2 && pic.h > C * 13, 'a picture with margins');
    });

    await test('truth: cells the server disagrees on are classed (ghost, missing, state) and drawn on the server panel only; the RCON commands name the dimension', async () => {
        const sc = scene(), cmds = [];
        const rcon = async (cmd) => {
            cmds.push(cmd);
            if (/ 0 66 0 minecraft:stone$/.test(cmd)) return 'Test failed';                   // a ghost: the server has air there
            if (/ 0 66 0 minecraft:air$/.test(cmd)) return 'Test passed';
            if (/ 0 63 0 minecraft:air$/.test(cmd)) return 'Test failed';                     // missing: the server has a block the bot does not see
            if (/ 2 61 0 minecraft:red_bed\[/.test(cmd)) return 'Test failed';               // the state differs
            return 'Test passed';
        };
        await S.truth(sc, rcon, { dim: 'minecraft:the_nether' });
        assert.deepStrictEqual(sc.diff, { '0,66,0': 'ghost', '0,63,0': 'missing', '2,61,0': 'state' });
        assert.ok(cmds.every((c) => c.startsWith('execute in minecraft:the_nether if block ')), 'dimension');
        const tex = new Textures(null), C = Rn.C, R = sc.r, at = (rr) => rr.get(Math.floor((R + 0.5) * C), Math.floor((R - 2 + 0.2) * C));      // the stone cell (y 66), off the X
        const bot = Rn.panel(sc, 'along', 'bot', tex).r, srv = Rn.panel(sc, 'along', 'server', tex).r;
        assert.notDeepStrictEqual(at(bot), Rn.SKY, 'the bot sees stone');
        assert.deepStrictEqual(at(srv), Rn.SKY_SERVER, 'the server panel shows the ghost cell as air (with an X over the edges)');
        const sc2 = scene(); await S.truth(sc2, async () => 'Test passed'); assert.deepStrictEqual(sc2.diff, {}, 'control: all agree');
    });

    await test('progress picture: done columns green, columns with work left not green, bots drawn', async () => {
        const p = { job: 'j1', stage: 'place', right: 10, total: 20, box: { x: 0, y: 60, z: 0, sx: 4, sy: 3, sz: 4 }, top: { '1,1': [3, 0, 1], '2,2': [0, 1, 0] }, side: { '1,60': [3, 0, 0] }, bots: [{ name: 'B1', x: 3.5, y: 61, z: 3.5 }], temps: [], work: { place: 3 } };
        const r = Rn.progressPicture(p), C2 = 24, ox = Rn.PAD.l, top = 34;
        assert.deepStrictEqual(r.get(ox + C2 / 2, top + C2 / 2), [80, 170, 80], 'column 0,0 is done');
        assert.notDeepStrictEqual(r.get(ox + C2 + C2 / 2, top + C2 + C2 / 2), [80, 170, 80], 'column 1,1 has work left');
        assert.deepStrictEqual(r.get(ox + Math.floor(3.5 * C2), top + Math.floor(3.5 * C2)), Rn.COL.body, 'the bot');
    });

    await test('triggers: the kinds of log lines and pauses, the bot named, the places in the line; nothing for an ordinary line', async () => {
        assert.strictEqual(W.classify('job j3: [stall] Bd4e no action for 61 s at 1.50,64.50,-2.30 in step > walk'), 'stall');
        assert.strictEqual(W.classify('job j3: Bd4e: evacuated from 1 64 2: nothing done for 4 min'), 'evacuate');
        assert.strictEqual(W.classify('job j3: [move] Bd4e: no start at 1,64,2 (in air, on smooth_stone_slab, body at 64.500, on the ground true)'), 'move_no_start');
        assert.strictEqual(W.classify('job j3: claims in the last minute: {}'), null, 'control');
        assert.strictEqual(W.botOf('[stall] Bd4e no action', ['Bd4', 'Bd4e', 'Bd']), 'Bd4e', 'the longest name that stands as a word');
        assert.strictEqual(W.botOf('[stall] Bd4ex no action', ['Bd4e']), null, 'not inside another word');
        assert.deepStrictEqual(W.placesOf('stall', '[stall] B no action for 61 s at 1.50,64.50,-2.30 in x').pos, { x: 1.5, y: 64.5, z: -2.3 });
        assert.deepStrictEqual(W.placesOf('no_stance', 'B: no way to the stance 4,65,-7 (no plan)').mark, { x: 4, y: 65, z: -7, label: 'S' });
        assert.strictEqual(W.slowOf({ ms: 16000, stack: ['step', 'cpu: plan (a walk)'], sub: null, fail: null }), 'slow_plan');
        assert.strictEqual(W.slowOf({ ms: 31000, stack: ['step'], sub: 'server: chunk not loaded', fail: null }), 'long_wait');
        assert.strictEqual(W.slowOf({ ms: 21000, stack: ['step'], sub: 'walk', fail: 'walk' }), 'retry');
        assert.strictEqual(W.slowOf({ ms: 9000, stack: ['cpu: plan'], sub: null, fail: null }), null, 'control: short');
    });

    await test('limits: one event per bot per interval and kind, a cap per run and kind; another bot or another kind is not held back', async () => {
        let t = 0; const L = new W.Limiter({ limits: { stall: { every: 120000, max: 3 }, death: { every: 60000, max: 5 } }, now: () => t });
        assert.ok(L.allow('stall', 'B1')); assert.ok(!L.allow('stall', 'B1'), 'same bot within 2 min');
        assert.ok(L.allow('stall', 'B2'), 'control: another bot'); assert.ok(L.allow('death', 'B1'), 'control: another kind');
        t = 119999; assert.ok(!L.allow('stall', 'B1')); t = 120000; assert.ok(L.allow('stall', 'B1'), 'after the interval');
        t = 999999; assert.ok(!L.allow('stall', 'B3'), 'cap of 3 per run'); assert.ok(!L.allow('nosuchkind', 'B1'), 'unknown kind');
        assert.strictEqual(L.refused['stall:cap'], 1); assert.strictEqual(L.refused['stall:interval'], 2);
        assert.ok(new W.Limiter({ limits: { stall: { every: 1, max: 3 } }, scale: 0.34 }).allow('stall', 'x'), 'scale keeps at least one');
    });

    await test('budget: the oldest events go first until the folder fits, the run index forgets them, an emptied run goes; within the budget nothing goes (control)', async () => {
        const root = tmp('stuckb-'), mk = (run, id, bytes, age) => { const d = path.join(root, run, id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'top.png'), Buffer.alloc(bytes)); const t = (Date.now() - age) / 1000; fs.utimesSync(d, t, t); };
        mk('r1', '001-stall-B1', 1000, 5000); mk('r1', '002-stall-B2', 1000, 3000); mk('r2', '001-death-B1', 1000, 1000);
        fs.writeFileSync(path.join(root, 'r1', 'index.json'), JSON.stringify({ events: [{ id: '001-stall-B1', cause: 'stall' }, { id: '002-stall-B2', cause: 'stall' }] }));
        assert.strictEqual(W.prune(root, 10000).pruned, 0, 'control: within the budget');
        const r = W.prune(root, 2500);
        assert.strictEqual(r.pruned, 1); assert.ok(!fs.existsSync(path.join(root, 'r1', '001-stall-B1')) && fs.existsSync(path.join(root, 'r1', '002-stall-B2')), 'the oldest went');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(root, 'r1', 'index.json'), 'utf8')).events.map((e) => e.id), ['002-stall-B2']);
        W.prune(root, 500); assert.ok(!fs.existsSync(path.join(root, 'r1')), 'an emptied run folder goes');
    });

    await test('watcher: a stall line writes three indexed PNGs, event.json and the index for its bot; the second line within 2 min writes nothing; a line of an unknown bot nothing', async () => {
        const root = tmp('stucke-'), map = new Map(), log = [];
        for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) map.set(`${x},60,${z}`, { name: 'stone', shapes: [[0, 0, 0, 1, 1, 1]], getProperties: () => ({}) });
        const bot = { version: '1.21.1', health: 20, food: 20, game: { dimension: 'overworld' }, controlState: { jump: true }, entity: { position: { x: 0.5, y: 61, z: 0.5 }, yaw: 0, pitch: 0, onGround: true }, blockAt: (v) => map.get(`${v.x},${v.y},${v.z}`) || { name: 'air', shapes: [], getProperties: () => ({}) } };
        const svc = { bots: new Map([['B1', { name: 'B1', bot, path: { cells: [[0, 61, 0], [0, 61, -3]], at: Date.now() } }]]), jobs: new Map(), temps: { list: () => [{ x: 1, y: 61, z: 0, by: 'B1', kind: 'pillar' }] }, log, o: {}, note: (l, m) => log.push({ t: Date.now(), level: l, msg: m }) };
        const w = new W.StuckWatch({ root, run: 'unit run', afterMs: 0, pauses: null });
        const line = (m) => { const e = { t: Date.now(), level: 'info', msg: m }; log.push(e); return w.observe(svc, e); };
        assert.ok(line('job j1: [stall] B1 no action for 61 s at 0.50,61.00,0.50 in step'));
        assert.strictEqual(line('job j1: [stall] B1 no action for 75 s at 0.50,61.00,0.50 in step'), null, 'within 2 min');
        assert.strictEqual(line('job j1: [stall] Zed no action for 61 s at 0,0,0'), null, 'not a bot of the service');
        for (let i = 0; i < 100 && !(w.events.length); i++) await new Promise((r) => setTimeout(r, 20));
        await w.busy; w.stop();
        const dir = path.join(root, 'unit_run', '001-stall-B1');
        for (const f of ['top.png', 'along.png', 'across.png']) assert.strictEqual(readBack(fs.readFileSync(path.join(dir, f))).type, 3, `${f} indexed`);
        const ev = JSON.parse(fs.readFileSync(path.join(dir, 'event.json'), 'utf8'));
        assert.strictEqual(ev.kind, 'stall'); assert.strictEqual(ev.server.error, 'no RCON: the bot view only'); assert.deepStrictEqual(ev.controls, ['jump']); assert.strictEqual(ev.temps.length, 1);
        assert.ok(ev.before.some((l) => l.includes('[stall] B1')), 'the lines before');
        const ix = JSON.parse(fs.readFileSync(path.join(root, 'unit_run', 'index.json'), 'utf8'));
        assert.deepStrictEqual(ix.byKind, { stall: ['001-stall-B1'] }); assert.strictEqual(ix.refused['stall:interval'], 1);
        assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8')).bytes > 0, 'status with the folder size');
        assert.strictEqual(W.enabled({ STUCK_SNAPSHOTS: '0' }), false); assert.strictEqual(W.enabled({ STUCK_SNAPSHOTS: '1' }), true);
    });

    await test('console routes: 401 without a session; runs, index, event and pictures with one; traversal, other names and a symlink out of the folder refused (a real file is served: control)', async () => {
        const root = tmp('stuckr-'), outside = tmp('stucko-'), d = path.join(root, 'run1', '001-stall-B1');
        fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'top.png'), P.encode(1, 1, new Uint8Array([1, 2, 3, 255]))); fs.writeFileSync(path.join(d, 'event.json'), '{"id":"001-stall-B1"}');
        fs.writeFileSync(path.join(root, 'run1', 'index.json'), JSON.stringify({ run: 'run1', events: [{ id: '001-stall-B1', cause: 'stall' }], byKind: { stall: ['001-stall-B1'] } }));
        fs.writeFileSync(path.join(outside, 'secret.png'), 'secret'); fs.symlinkSync(path.join(outside, 'secret.png'), path.join(d, 'along.png'));
        fs.writeFileSync(path.join(root, 'status.json'), JSON.stringify({ bytes: 5, budget: 10 }));
        const { WorkService } = require('../src/work/service'), { createConsole } = require('../src/work/web/server');
        const svc = new WorkService({ dataDir: tmp('stucksvc-'), factory: () => { throw new Error('no bots'); }, envFactory: () => ({}), display: false });
        const { server } = createConsole({ service: svc, stuckDir: root }); await new Promise((r) => server.listen(0, '127.0.0.1', r)); const port = server.address().port;
        const call = (u, cookie) => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path: u, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => { const b = []; res.on('data', (c) => b.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(b) })); }).on('error', reject); });
        try {
            assert.strictEqual((await call('/api/stuck/runs')).status, 401, 'no session');
            assert.strictEqual((await call('/api/stuck/img/run1/001-stall-B1/top.png')).status, 401, 'no session, no picture');
            const s = await call('/api/session'), cookie = String(s.headers['set-cookie']).split(';')[0];
            const runs = JSON.parse((await call('/api/stuck/runs', cookie)).body);
            assert.deepStrictEqual(runs.runs.map((r) => [r.run, r.events, r.byKind.stall]), [['run1', 1, 1]]); assert.strictEqual(runs.status.budget, 10);
            assert.strictEqual(JSON.parse((await call('/api/stuck/run/run1', cookie)).body).run, 'run1');
            assert.strictEqual(JSON.parse((await call('/api/stuck/event/run1/001-stall-B1', cookie)).body).id, '001-stall-B1');
            const png = await call('/api/stuck/img/run1/001-stall-B1/top.png', cookie);
            assert.strictEqual(png.status, 200, 'control: a real file'); assert.strictEqual(png.headers['content-type'], 'image/png');
            assert.strictEqual((await call('/api/stuck/img/run1/001-stall-B1/along.png', cookie)).status, 404, 'a symlink out of the folder');
            for (const bad of ['/api/stuck/img/run1/001-stall-B1/../../../etc/passwd', '/api/stuck/img/..%2F..%2Fetc/001-stall-B1/top.png', '/api/stuck/img/run1/001-stall-B1/event.json',
                '/api/stuck/img/run1/001-stall-B1/top.PNG', '/api/stuck/run/..', '/api/stuck/run/.hidden', '/api/stuck/event/run1/..%2Fstatus', '/api/stuck/img/run1/x/top.png', '/api/stuck/img/run1/001-stall-B1/missing.png']) {
                const r = await call(bad, cookie); assert.ok([400, 404].includes(r.status), `${bad}: ${r.status}`); assert.ok(!r.body.includes('secret'), bad);
            }
        } finally { server.close(); await svc.stop(); }
    });

    console.log(`test_debug_snapshots_pure: ${passed} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
