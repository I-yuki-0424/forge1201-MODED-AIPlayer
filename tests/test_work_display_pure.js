// The in-game display (src/work/display/*, src/work/service/display.js): shapes, what a frame holds and how many particles, who sees it,
// the service state it draws (planned paths, pit lanes, tags with links) and the switches.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const shapes = require('../src/work/display/shapes');
const { Overlay, framePoints, VIEW_TAG } = require('../src/work/display/overlay');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    await test('shapes: a segment includes both ends at the spacing; an outline closes; thinning keeps the spread; the command is a forced dust particle for the selector', () => {
        const s = shapes.segment([0, 64, 0], [10, 64, 0], 2, 1);
        assert.strictEqual(s.length, 6); assert.deepStrictEqual([s[0].x, s[5].x], [0, 10]); assert.ok(s.every((p) => p.c === 1));
        const r = shapes.rectOutline({ x0: 0, x1: 3, z0: 0, z1: 1 }, 70, 1, 0);                  // the box spans x 0..4, z 0..2 (block edges)
        assert.deepStrictEqual([r[0].x, r[0].z], [0, 0]); assert.deepStrictEqual([r[r.length - 1].x, r[r.length - 1].z], [0, 0]);
        assert.ok(r.every((p) => p.x >= 0 && p.x <= 4 && p.z >= 0 && p.z <= 2));
        const t = shapes.thin(s.concat(s, s), 5); assert.strictEqual(t.length, 5); assert.strictEqual(shapes.thin(s, 50), s);
        assert.strictEqual(shapes.corners({ x0: 0, x1: 1, z0: 0, z1: 1 }, 60, 64, 2, 2).length, 4 * 3);
        const cmd = shapes.dustCommand({ x: 1.234, y: 70, z: -2, c: 0 }, '@a[tag=aip_see]');
        assert.match(cmd, /^particle minecraft:dust 1 0\.25 0\.25 3 1\.23 70 -2 0\.05 0\.05 0\.05 0 3 force @a\[tag=aip_see\]$/);
        assert.match(shapes.dustCommand({ x: 1, y: 2, z: 3, c: 0, k: 'rod' }, '@a'), /^particle minecraft:end_rod 1 2 3 .* force @a$/);
        assert.match(shapes.dustCommand({ x: 0, y: 0, z: 0, c: -1, s: 4 }, '@a'), /dust 1 1 1 4 /, 'a negative or large colour index wraps around the palette');
    });

    const state = (extra = {}) => ({
        viewers: [{ name: 'Seia_Y', x: 0, y: 70, z: 0 }],
        bots: [{ name: 'W1', color: 1, pos: { x: 5.5, y: 64, z: 0.5 }, path: { cells: [[0, 64, 0], [1, 64, 0], [2, 64, 0], [3, 64, 0], [4, 64, 0], [5, 64, 0], [6, 64, 0], [7, 64, 0]] } }],
        lanes: [{ job: 'j1', id: 'l0', color: 2, box: { x0: 0, x1: 7, z0: 0, z1: 7 }, rim: 80, activeY: 70 }],
        tags: [{ name: 'furnace', x: 3, y: 64, z: 3, machine: true, end: { x: 3, y: 64, z: 6 } }, { name: 'chest', x: 3, y: 64, z: 6, machine: false, end: null }], ...extra,
    });

    await test('frame: the path ahead of the bot only, lanes at the rim and at the working layer with posts, tags with the link; far shapes are left out', () => {
        const all = framePoints(state(), { paths: true, lanes: true, tags: true }, 1000);
        const path = all.filter((p) => p.c === 1);
        assert.ok(path.length >= 3 && Math.min(...path.map((p) => p.x)) >= 5.5, 'cells behind the bot (x < 5.5) are not drawn');
        assert.ok(path.some((p) => p.k === 'rod'), 'the destination has a glowing mark');
        const lane = all.filter((p) => p.c === 2);
        assert.ok(lane.some((p) => Math.abs(p.y - 81.02) < 1e-9) && lane.some((p) => Math.abs(p.y - 71.02) < 1e-9), 'rim and working layer');
        assert.ok(lane.some((p) => p.x === 0 && p.z === 0 && p.y > 72 && p.y < 80), 'corner posts between them');
        assert.ok(all.some((p) => p.c === 6) && all.some((p) => p.c === 5), 'machine and container colours');
        assert.strictEqual(framePoints(state({ viewers: [{ name: 'X', x: 5000, y: 70, z: 5000 }] }), { paths: true, lanes: true, tags: true }, 1000).length, 0, 'nothing near a viewer, nothing drawn');
        assert.strictEqual(framePoints(state(), { paths: false, lanes: false, tags: false }, 1000).length, 0);
        const thin = framePoints(state(), { paths: true, lanes: true, tags: true }, 20);
        assert.ok(thin.length <= 20 + 4 * 3, `budget respected: ${thin.length}`);
        assert.ok(thin.some((p) => p.c === 1) && thin.some((p) => p.c === 2) && thin.some((p) => p.c >= 5), 'every layer keeps a share');
    });

    await test('overlay: off or nobody watching sends nothing; viewers are tagged once; a backed-up queue skips the frame; every command is a forced dust particle', async () => {
        const sent = []; let pending = 0, cfg = { on: true }, humans = [{ name: 'Seia_Y', x: 0, y: 70, z: 0 }], st = state();
        const o = new Overlay({ rcon: async (c) => { sent.push(c); return ''; }, state: () => st, config: () => cfg, humans: async () => humans, pending: () => pending, budget: 40 });
        assert.ok((await o.frame(1000)) > 0 && sent.filter((c) => c.startsWith('tag ')).length === 1 && sent.includes(`tag Seia_Y add ${VIEW_TAG}`));
        const particles = sent.filter((c) => c.startsWith('particle'));
        assert.deepStrictEqual(sent.filter((c) => c.startsWith('gamerule')), ['gamerule sendCommandFeedback false', 'gamerule logAdminCommands false']);
        assert.ok(particles.length <= 40 + 12 && particles.every((c) => / force @a\[tag=aip_see\]$/.test(c)), `${particles.length} particles`);
        sent.length = 0; await o.frame(2000); assert.ok(!sent.some((c) => c.startsWith('tag ')), 'tagged once, not every frame');
        sent.length = 0; pending = 5; assert.strictEqual(await o.frame(3000), 0); assert.strictEqual(sent.length, 0); pending = 0;
        cfg = { on: false }; assert.strictEqual(await o.frame(4000), 0); cfg = { on: true };
        humans = []; assert.strictEqual(await o.frame(20000), 0, 'nobody to see it');
        humans = [{ name: 'Seia_Y', x: 0, y: 70, z: 0 }, { name: 'Friend', x: 1, y: 70, z: 1 }]; sent.length = 0; await o.frame(40000);
        assert.ok(sent.includes('tag Friend add aip_see'), 'a new player is tagged as they arrive');
        st = null; sent.length = 0; assert.strictEqual(await o.frame(60000), 0);
    });

    // ---- the service
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wdisp-')), rcon = [];
    const factory = (name) => { const b = new EventEmitter(); Object.assign(b, { username: name, entity: { position: { x: 1, y: 70, z: 1 } }, inventory: { items: () => [], slots: [], emptySlotCount: () => 30 }, quit() {} }); setTimeout(() => b.emit('spawn'), 5); return b; };
    const svc = new WorkService({ dataDir: dir, factory, envFactory: () => ({}), display: false, rcon: { command: async (c) => { rcon.push(c); return ''; } } });
    svc.addBot('Bot1'); while (svc.status().bots[0].state !== 'online') await sleep(10);

    await test('service: a walk phase on the bot is remembered as its path; it is shown only while the bot is busy and fresh', () => {
        const rec = svc.bots.get('Bot1');
        rec.bot.__onPhase({ phase: 'walk', cells: [[1, 70, 1], [2, 70, 1]] }); rec.bot.__onPhase({ phase: 'mine' });
        assert.strictEqual(svc.displayState().bots[0].path, null, 'idle bot: no path');
        rec.bot.__onPhase({ phase: 'walk', cells: [[1, 70, 1], [2, 70, 1]] }); rec.cmd = { status: 'running' };
        assert.deepStrictEqual(svc.displayState().bots[0].path.cells, [[1, 70, 1], [2, 70, 1]]);
        rec.cmd = null; rec.path = { cells: [[1, 70, 1]], at: Date.now() - 60000 }; rec.script = { name: 'x' };
        assert.strictEqual(svc.displayState().bots[0].path, null, 'a stale path is dropped');
    });

    await test('service: pit lanes with their rim and working layer, tagged blocks with where the link ends', () => {
        svc.createPit({ name: 'p', box: { x0: 0, z0: 0, x1: 15, z1: 15, top: 80, bottom: 70 }, lanes: 4 });
        const st = svc.displayState();
        assert.ok(st.lanes.length >= 4 && st.lanes.every((l) => l.rim === 80 && l.activeY === 80 && l.box.x1 >= l.box.x0 && [0, 1, 2, 3].includes(l.color % 8) !== undefined));
        assert.deepStrictEqual(new Set(st.lanes.map((l) => l.color)).size, st.lanes.length, 'a colour per lane');
        svc.addSite({ name: 'chest', x: 3, y: 64, z: 6, tags: ['storage'] }); svc.addSite({ name: 'furnace', x: 3, y: 64, z: 5, tags: ['machine'], via: 'chest' });
        const t = svc.displayState().tags.find((x) => x.name === 'furnace'); assert.strictEqual(t.machine, true); assert.deepStrictEqual([t.end.x, t.end.z], [3, 6]);
    });

    await test('settings: the display switches change one by one; other values are ignored', () => {
        assert.deepStrictEqual(svc.settings.display, { on: true, paths: true, lanes: true, tags: true });
        svc.setSettings({ display: { paths: false, bogus: true, lanes: 'yes' } });
        assert.deepStrictEqual(svc.settings.display, { on: true, paths: false, lanes: true, tags: true });
        svc.setSettings({ display: { on: false } }); assert.strictEqual(svc.settings.display.on, false);
    });

    await test('service with RCON starts the overlay and stops it', async () => {
        const s2 = new WorkService({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wdisp-')), factory, envFactory: () => ({}), displayMs: 20, rcon: { command: async (c) => (c === 'list' ? 'There are 1 of a max of 20 players online: Seia_Y' : c.includes('Pos') ? 'x has the following entity data: [1.5d, 70.0d, 1.5d]' : c.includes('Dimension') ? 'x has the following entity data: "minecraft:overworld"' : '') } });
        s2.addBot('Bot2'); while (s2.status().bots[0].state !== 'online') await sleep(10);
        s2.addSite({ name: 'chest', x: 3, y: 64, z: 6, tags: ['storage'] });
        const seen = []; const orig = s2.rcon.bind(s2); s2.rcon = (c) => { seen.push(c); return orig(c); };
        const t0 = Date.now(); while (!seen.some((c) => c.startsWith('particle')) && Date.now() - t0 < 3000) await sleep(20);
        assert.ok(seen.includes(`tag Seia_Y add ${VIEW_TAG}`) && seen.some((c) => /^particle minecraft:dust .* force @a\[tag=aip_see\]$/.test(c)), seen.slice(0, 4).join(' | '));
        await s2.stop(); const n = seen.length; await sleep(100); assert.strictEqual(seen.length, n, 'stopped');
    });
    await svc.stop();
    console.log('\ndisplay: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
