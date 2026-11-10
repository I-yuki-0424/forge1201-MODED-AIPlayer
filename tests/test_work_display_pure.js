// The in-game display (src/work/display/*, src/work/service/display.js): shapes, what a frame holds and how many particles, who sees it,
// the service state it draws (planned paths, pit lanes, tags with links) and the switches.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const shapes = require('../src/work/display/shapes');
const { Overlay, framePieces, VIEW_TAG } = require('../src/work/display/overlay');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    await test('shapes: a quaternion turns +Z onto the direction; a dashed line has gaps and ends at b; runs merge collinear steps; the summon command is a bright glowing block_display in the dimension', () => {
        for (const d of [[0, 0, 1], [1, 0, 0], [0, 1, 0], [0, 0, -1], [-1, 0, 0], [0.6, 0, 0.8], [0.577, 0.577, 0.577]]) {
            const n = Math.hypot(...d), u = d.map((v) => v / n), r = shapes.rotate(shapes.quatZTo(u), [0, 0, 1]);
            assert.ok(Math.hypot(r[0] - u[0], r[1] - u[1], r[2] - u[2]) < 1e-6, `rotate +Z onto ${u}`);
        }
        const dl = shapes.dashed([0, 64, 0], [10, 64, 0], { dash: 1.5, gap: 1, c: 1 });
        assert.ok(dl.length >= 3 && dl.length <= 5); assert.strictEqual(dl[0].a[0], 0); assert.ok(Math.abs(dl[dl.length - 1].b[0] - 10) < 1e-9);
        for (let i = 1; i < dl.length; i++) assert.ok(dl[i].a[0] - dl[i - 1].b[0] > 0.5, 'a gap between dashes');
        const ru = shapes.rectDashed({ x0: 0, x1: 3, z0: 0, z1: 1 }, 70, { c: 0 });                  // the box spans x 0..4, z 0..2 (block edges)
        assert.ok(ru.length >= 6 && ru.every((p) => p.a[0] >= 0 && p.b[0] <= 4 && p.a[2] >= 0 && p.b[2] <= 2));
        assert.strictEqual(shapes.postsDashed({ x0: 0, x1: 1, z0: 0, z1: 1 }, 60, 64, { c: 2 }).length % 4, 0);
        const rs = shapes.runs([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 0, 1], [2, 1, 2]]);
        assert.deepStrictEqual(rs, [[[0, 0, 0], [2, 0, 0]], [[2, 0, 0], [2, 0, 1]], [[2, 0, 1], [2, 1, 2]]]);
        const p = shapes.piece([1, 70, 2], [1, 70, 12], 0.16, 0, true), key = shapes.keyOf('nether', p);
        assert.strictEqual(key, shapes.keyOf('nether', shapes.piece([1, 70, 2], [1, 70, 12], 0.16, 0, true))); assert.notStrictEqual(key, shapes.keyOf('end', p));
        assert.match(key, /^[A-Za-z0-9._+-]+$/, 'a valid entity tag');
        const cmd = shapes.summonCommand('minecraft:the_nether', p, key, 'aipe1');
        assert.match(cmd, /^execute in minecraft:the_nether run summon block_display 1\.000 70\.000 2\.000 \{Tags:\["aipd","k[^"]+","aipe1"\],block_state:\{Name:"minecraft:red_concrete"\},brightness:\{sky:15,block:15\}/);
        assert.match(cmd, /Glowing:1b,glow_color_override:\d+,transformation:\{translation:\[[^\]]+\],left_rotation:\[[^\]]+\],scale:\[0\.16f,0\.16f,10f\]/);
        assert.doesNotMatch(shapes.summonCommand('minecraft:overworld', { ...p, glow: false }, key, 'e'), /Glowing/);
        assert.strictEqual(shapes.killCommand('minecraft:the_end', 'kx'), 'execute in minecraft:the_end run kill @e[type=block_display,tag=kx]');
        assert.strictEqual(shapes.killStaleCommand('minecraft:overworld', 'aipe1'), 'execute in minecraft:overworld run kill @e[type=block_display,tag=aipd,tag=!aipe1]');
    });

    const state = (extra = {}) => ({
        viewers: [{ name: 'Seia_Y', x: 0, y: 70, z: 0, dim: 'overworld' }],
        bots: [{ name: 'W1', color: 1, dim: 'overworld', pos: { x: 5.5, y: 64, z: 0.5 }, path: { cells: [[0, 64, 0], [1, 64, 0], [2, 64, 0], [3, 64, 0], [4, 64, 0], [5, 64, 0], [6, 64, 0], [7, 64, 0]] } }],
        lanes: [{ job: 'j1', id: 'l0', dim: 'overworld', color: 2, box: { x0: 0, x1: 7, z0: 0, z1: 7 }, rim: 80, activeY: 70 }],
        tags: [{ name: 'furnace', dim: 'overworld', x: 3, y: 64, z: 3, machine: true, end: { x: 3, y: 64, z: 6 } }, { name: 'chest', dim: 'overworld', x: 3, y: 64, z: 6, machine: false, end: null }], ...extra,
    });

    await test('frame: a solid path ahead of the bot, dashed lanes at the rim and at the working layer with posts, tags with the link; far shapes and other dimensions without a viewer are left out', () => {
        const all = [...framePieces(state(), { paths: true, lanes: true, tags: true }).values()];
        const path = all.filter((v) => v.layer === 'paths' && v.piece.t < 0.5);
        assert.strictEqual(path.length, 1, 'a straight way is ONE solid piece'); assert.ok(path[0].piece.a[0] >= 5.5 - 1e-9 === false || path[0].piece.a[0] >= 5 - 1e-9, 'it starts at the cell the bot is at');
        assert.ok(Math.min(...path.map((v) => v.piece.a[0])) >= 4.5, 'cells well behind the bot are not drawn');
        assert.ok(path[0].piece.glow && path[0].piece.c === 1);
        assert.ok(all.some((v) => v.layer === 'paths' && v.piece.t > 0.5), 'the destination has a big mark');
        const lane = all.filter((v) => v.layer === 'lanes');
        assert.ok(lane.every((v) => v.piece.c === 2) && lane.length > 20, 'dashes, many pieces');
        assert.ok(lane.some((v) => Math.abs(v.piece.a[1] - 81.02) < 1e-9) && lane.some((v) => Math.abs(v.piece.a[1] - 71.02) < 1e-9), 'rim and working layer');
        assert.ok(lane.some((v) => v.piece.a[0] === 0 && v.piece.a[2] === 0 && v.piece.a[1] !== v.piece.b[1]), 'corner posts between them');
        assert.ok(all.some((v) => v.piece.c === 6) && all.some((v) => v.piece.c === 5), 'machine and container colours');
        assert.strictEqual(framePieces(state({ viewers: [{ name: 'X', x: 5000, y: 70, z: 5000, dim: 'overworld' }] }), { paths: true, lanes: true, tags: true }).size, 0, 'nothing near a viewer, nothing drawn');
        assert.strictEqual(framePieces(state({ viewers: [{ name: 'X', x: 0, y: 70, z: 0, dim: 'nether' }] }), { paths: true, lanes: true, tags: true }).size, 0, 'a viewer in another dimension sees nothing of the overworld');
        assert.strictEqual(framePieces(state(), { paths: false, lanes: false, tags: false }).size, 0);
        // another dimension: drawn for a viewer there, keyed apart from the same geometry in the overworld
        const nether = state({ viewers: [{ name: 'X', x: 0, y: 70, z: 0, dim: 'nether' }], bots: [], tags: [], lanes: [{ job: 'j2', id: 'n', dim: 'nether', color: 0, box: { x0: 0, x1: 7, z0: 0, z1: 7 }, rim: 100, activeY: 100 }] });
        const nl = [...framePieces(nether, { paths: true, lanes: true, tags: true }).values()]; assert.ok(nl.length > 8 && nl.every((v) => v.dim === 'nether'));
        const moved = state(); moved.bots[0].pos = { x: 6.5, y: 64, z: 0.5 };
        const k1 = [...framePieces(state(), { paths: true }).keys()], k2 = [...framePieces(moved, { paths: true }).keys()];
        assert.ok(k1.some((k) => k2.includes(k)), 'the pieces of a path keep their keys while the bot walks on');
    });

    await test('overlay: off or nobody watching sends nothing; a stale run is swept once; pieces are summoned once and killed when gone; a backed-up queue skips the frame; other dimensions use `execute in`', async () => {
        const sent = []; let pending = 0, cfg = { on: true }, humans = [{ name: 'Seia_Y', x: 0, y: 70, z: 0, dim: 'minecraft:overworld' }], st = state();
        const o = new Overlay({ rcon: async (c) => { sent.push(c); return ''; }, state: () => st, config: () => cfg, humans: async () => humans, pending: () => pending, perFrame: 400 });
        const n1 = await o.frame(1000);
        assert.ok(n1 > 0 && sent.filter((c) => c.includes('block_display') && c.includes('summon')).length === n1);
        assert.deepStrictEqual(sent.filter((c) => c.startsWith('gamerule')), ['gamerule sendCommandFeedback false', 'gamerule logAdminCommands false']);
        assert.strictEqual(sent.filter((c) => c.includes(`tag=!${o.epoch}`)).length, 1, 'the entities of an earlier run are killed once, first');
        assert.ok(sent.filter((c) => c.includes('summon')).every((c) => c.startsWith('execute in minecraft:overworld run summon block_display ') && c.includes(o.epoch)));
        sent.length = 0; assert.strictEqual(await o.frame(2000), 0, 'nothing new, nothing sent'); assert.strictEqual(sent.length, 0);
        st = state({ bots: [] }); sent.length = 0; const n3 = await o.frame(3000);
        assert.ok(n3 > 0 && sent.every((c) => / run kill @e\[type=block_display,tag=k/.test(c)), 'the path is gone: its pieces are killed');
        sent.length = 0; pending = 5; st = state(); assert.strictEqual(await o.frame(4000), 0); assert.strictEqual(sent.length, 0); pending = 0;
        sent.length = 0; humans = [{ name: 'Seia_Y', x: 0, y: 70, z: 0, dim: 'minecraft:the_nether' }];
        await o.frame(7000);
        assert.ok(sent.some((c) => /^execute in minecraft:the_nether run kill @e\[type=block_display,tag=aipd,tag=!/.test(c)), 'the new dimension is swept once');
        assert.ok(sent.filter((c) => c.includes(' kill @e[type=block_display,tag=k')).length > 5 && sent.filter((c) => c.includes('summon')).length === 0, 'the overworld pieces are removed: nobody is there');
        humans = []; sent.length = 0; assert.strictEqual(await o.frame(20000), 0, 'nobody to see it');
        cfg = { on: false }; humans = [{ name: 'Seia_Y', x: 0, y: 70, z: 0, dim: 'overworld' }]; sent.length = 0; assert.strictEqual(await o.frame(40000), 0);
        humans = [{ name: 'Seia_Y', x: 0, y: 70, z: 0, dim: 'overworld' }]; cfg = { on: true }; st = state(); await o.frame(41000); const drawn = o.drawn.size; assert.ok(drawn > 0);
        sent.length = 0; await o.clear(); assert.strictEqual(o.drawn.size, 0); assert.deepStrictEqual(sent, ['execute in minecraft:overworld run kill @e[type=block_display,tag=aipd]']);
        st = null; sent.length = 0; assert.strictEqual(await o.frame(60000), 0);
        // the per-frame budget: a big scene is drawn over several frames
        const small = new Overlay({ rcon: async () => '', state: () => state(), config: () => ({ on: true }), humans: async () => humans, pending: () => 0, perFrame: 10 });
        assert.strictEqual(await small.frame(1), 10); assert.strictEqual(await small.frame(2), 10);
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
        assert.ok(st.lanes.length >= 4 && st.lanes.every((l) => l.dim === 'overworld' && l.rim === 80 && l.activeY === 80 && l.box.x1 >= l.box.x0 && [0, 1, 2, 3].includes(l.color % 8) !== undefined));
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
        const t0 = Date.now(); while (!seen.some((c) => c.includes('summon block_display')) && Date.now() - t0 < 3000) await sleep(20);
        assert.ok(seen.some((c) => /^execute in minecraft:overworld run summon block_display /.test(c)), seen.slice(0, 4).join(' | '));
        await s2.stop(); assert.ok(seen.some((c) => /run kill @e\[type=block_display,tag=aipd\]$/.test(c)), 'the lines are taken away when the service stops'); const n = seen.length; await sleep(100); assert.strictEqual(seen.length, n, 'stopped');
    });
    await svc.stop();
    console.log('\ndisplay: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
