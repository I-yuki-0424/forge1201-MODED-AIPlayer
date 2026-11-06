'use strict';
// Live check of the BOT TODO batch of 2026-11-06 on a REAL Forge server with the play world's mod set (the demo server,
// /mnt/data/forgeaip-play/demo). The system under test is the work console's own WorkService with real bots and real RCON; grading is
// the SERVER's state (RCON), not the bots' reports. Test code.
//
//   (cd /mnt/data/forgeaip-play/demo && ./live.sh [--only direct,discard,audit,climb,defend,glow])
//
//   direct   mined blocks go into the inventory (KubeJS server script): no item entity, inventory grows; control without the tag
//   discard  a full inventory is emptied with `clear`: no item entity, the neighbouring bot gets nothing
//   audit    a pit with a stray block and a leftover put into a finished layer is repaired before the job ends
//   climb    move_to up a wall (no way on foot): rises on a pillar, no temporary block left
//   defend   a zombie attacks a bot that is digging: the bot kills it and the job goes on
//   glow     a problem makes the bot glow (server-side effect), the next good unit clears it; the problem is on record
const fs = require('fs');
const path = require('path');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const FLOOR = -61;                 // top of the flat world's grass; a stone arena is built above it
const BX = 2000, BZ = 2000;        // chunk-aligned, far from spawn
const only = (process.argv.indexOf('--only') > 0 ? process.argv[process.argv.indexOf('--only') + 1] : 'direct,discard,audit,climb,defend,glow').split(',');
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 260) : ''}`); };

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const dir = fs.mkdtempSync('/tmp/todo-live-');
    const svc = new WorkService({
        dataDir: dir, host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 8, reconnectMs: 4000, coolMs: 1000,
        rcon: { command: (c) => shared.command(c) },
    });
    svc.settings.autoKit = false;
    const names = ['DemoA', 'DemoB', 'DemoC'];
    for (const n of names) svc.addBot(n);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bots online');
    await sleep(2500);
    const bot = (n) => svc.bots.get(n).bot;
    const entities = async () => { const o = await S.cmd('execute if entity @e[type=minecraft:item]'); const m = /count: (\d+)/.exec(o); return m ? Number(m[1]) : 0; };
    const count = (n, item) => bot(n).inventory.items().filter((i) => i.name === item).reduce((a, i) => a + i.count, 0);
    for (const n of names) { await S.must(`gamemode survival ${n}`); await S.must(`clear ${n}`); }
    await S.must('gamerule doMobSpawning false'); await S.must('gamerule doDaylightCycle false'); await S.must('time set day'); await S.must('kill @e[type=minecraft:item]');
    await S.must(`forceload add ${BX - 32} ${BZ - 32} ${BX + 48} ${BZ + 48}`);
    // arena: a stone slab 40 x 40, 10 high, on the grass; air above
    const top = FLOOR + 10;
    await S.must(`fill ${BX - 2} ${FLOOR + 1} ${BZ - 2} ${BX + 40} ${top} ${BZ + 40} minecraft:stone`);
    await S.must(`fill ${BX - 2} ${top + 1} ${BZ - 2} ${BX + 40} ${top + 8} ${BZ + 40} minecraft:air`);
    await sleep(1500);
    const tp = async (n, x, y, z) => { await S.must(`tp ${n} ${x + 0.5} ${y} ${z + 0.5}`); await sleep(1200); };
    const cmd = async (n, command, args, ms = 60000) => {
        const r = await svc.runCommand({ bots: [n], command, args });
        if (r.refused.length) return { status: 'refused', reason: r.refused[0].why };
        await sleep(300);
        await until(() => svc.bots.get(n).cmd.status !== 'running', ms, `${command} on ${n}`);
        return svc.bots.get(n).cmd;
    };

    if (only.includes('direct')) {
        await S.must(`give DemoA minecraft:iron_pickaxe 1`);
        await tp('DemoA', BX + 5, top + 1, BZ + 5);
        const tagged = (await S.cmd('data get entity DemoA Tags')).includes('aip_direct');
        check('direct: the bot was tagged by the service when it came online', tagged);
        const before = count('DemoA', 'cobblestone'), e0 = await entities();
        for (let i = 0; i < 6; i++) await cmd('DemoA', 'mine', { x: BX + 6 + i, y: top, z: BZ + 5, collect: false });
        await sleep(1000);
        const got = count('DemoA', 'cobblestone') - before, e1 = await entities();
        check('direct: 6 blocks mined with collect:false end up in the inventory, no item entity exists', got === 6 && e1 === e0, { got, entities: [e0, e1] });
        svc.setSettings({ directPickup: false }); await sleep(800);
        await S.must('clear DemoA minecraft:cobblestone'); await S.must('give DemoA minecraft:dirt 2240'); await sleep(800);      // a full inventory: the bot cannot pick the drops up by walking over them, so the control shows where they went
        const b2 = count('DemoA', 'cobblestone');
        const ctl = [];
        for (let i = 0; i < 3; i++) { const c = await cmd('DemoA', 'mine', { x: BX + 6 + i, y: top, z: BZ + 6, collect: false }); ctl.push([c.status, c.result && c.result.reason]); }
        console.log('[live] control mine results', JSON.stringify(ctl), 'tags', (await S.cmd('data get entity DemoA Tags')).slice(0, 80));
        await sleep(600);
        const e2 = await entities();
        check('direct: control (switch off, inventory full): the drops lie on the ground (equal items merge into fewer entities)', e2 - e1 >= 1 && count('DemoA', 'cobblestone') === b2, { entities: [e1, e2] });
        svc.setSettings({ directPickup: true }); await sleep(500);
        await S.must('kill @e[type=minecraft:item]');
    }

    if (only.includes('discard')) {
        await S.must('kill @e[type=minecraft:item]');
        await tp('DemoB', BX + 20, top + 1, BZ + 20); await tp('DemoC', BX + 21, top + 1, BZ + 20);
        for (let i = 0; i < 30; i++) await S.must(`give DemoB minecraft:${['dirt', 'gravel', 'cobblestone', 'granite', 'diorite', 'andesite'][i % 6]} 64`);
        await sleep(1200);
        const free0 = bot('DemoB').inventory.emptySlotCount(), cBefore = bot('DemoC').inventory.items().length;
        const env = svc.envFactory(bot('DemoB'), { cancelled: false }, { worker: true });
        const janitor = require('../../src/work/bot/janitor');
        const m = await janitor.maintain(env, janitor.pitPolicy({ freeTarget: 20 }));
        await sleep(1500);
        const free1 = bot('DemoB').inventory.emptySlotCount(), ent = await entities();
        check('discard: a full inventory is emptied through the server (clear): slots freed, zero item entities', m.ok && free1 >= 20 && ent === 0, { ok: m.ok, reason: m.reason, free: [free0, free1], entities: ent, ops: m.done && m.done.length });
        check('discard: the neighbouring bot, one block away, received nothing', bot('DemoC').inventory.items().length === cBefore);
        env.dispose();
    }

    if (only.includes('audit')) {
        const box = { x0: BX + 2, z0: BZ + 2, x1: BX + 17, z1: BZ + 9, top, bottom: top - 2 };
        for (const n of ['DemoA', 'DemoB']) { await S.must(`clear ${n}`); await S.must(`give ${n} minecraft:iron_pickaxe 4`); await S.must(`give ${n} minecraft:cobblestone 32`); await tp(n, box.x0 + (n === 'DemoA' ? 2 : 8), top + 1, box.z0 - 1); }
        const j = svc.createPit({ name: 'audit', box, bots: ['DemoA', 'DemoB'], method: 'sweep', road: false, start: true });
        const job = svc.jobs.get(j.id);
        await until(() => job.impl.ledger.progress().done >= 4, 180000, 'first units done');
        // sabotage in a finished layer-0 cell (a block "placed for water control") and a leftover one layer further up the volume
        const L = job.impl.ledger, pit = require('../../src/work/jobs/pit');
        let sab = null;
        // a cell of a unit that is DONE now (any region, any layer): the repair can only come from the audit
        for (const region of job.impl.plan.regions) {
            const reg = L.regions.get(region.id);
            for (let u = 0; u < reg.n && !sab; u++) if (reg.state[u] === 2) { const cells = pit.unitCells(job.impl.plan, region, u); if (cells.length) sab = { ...cells[cells.length - 1], unit: `${region.id}:${u}` }; }
        }
        if (!sab) throw new Error('no finished unit to sabotage');
        await S.must(`setblock ${sab.x} ${sab.y} ${sab.z} minecraft:cobblestone`);
        console.log('[live] sabotage at', JSON.stringify(sab));
        await until(() => job.state === 'finished', 420000, 'pit finished');
        let left = 0;
        for (let l = 0; l < 3; l++) for (const blk of ['stone', 'cobblestone', 'water', 'dirt', 'grass_block']) { const o = await S.cmd(`fill ${box.x0} ${top - l} ${box.z0} ${box.x1} ${top - l} ${box.z1} minecraft:air replace minecraft:${blk}`); const m = /filled (\d+) block/.exec(o); if (m) left += Number(m[1]); }
        const notes = svc.log.filter((e) => /range check/.test(e.msg)).map((e) => e.msg);
        check('audit: the stray block put into a finished layer was dug again; the volume is empty on the server', left === 0 && job.impl.ledger.finished(), { left, progress: job.impl.ledger.progress(), notes });
        check('audit: the range check reported it', notes.length > 0, notes);
    }

    if (only.includes('climb')) {
        await S.must(`clear DemoA`);
        // a wall: plateau 6 high at x BX+30.., the bot stands on the slab 8 blocks from its foot
        await S.must(`fill ${BX + 30} ${top + 1} ${BZ + 20} ${BX + 38} ${top + 6} ${BZ + 28} minecraft:stone`);
        await S.must(`give DemoA minecraft:cobblestone 16`); await S.must(`give DemoA minecraft:iron_pickaxe 1`);
        await tp('DemoA', BX + 22, top + 1, BZ + 24);
        const target = { x: BX + 33, y: top + 7, z: BZ + 24 };
        const r = await cmd('DemoA', 'move_to', target, 120000);
        await sleep(1500);
        const p = bot('DemoA').entity.position;
        const reached = Math.abs(p.x - (target.x + 0.5)) < 1 && Math.abs(p.z - (target.z + 0.5)) < 1 && p.y >= top + 6.9;
        let temp = 0; for (const blk of ['cobblestone']) { const o = await S.cmd(`fill ${BX + 20} ${top + 1} ${BZ + 18} ${BX + 29} ${top + 8} ${BZ + 30} minecraft:air replace minecraft:${blk}`); const m = /filled (\d+) block/.exec(o); if (m) temp += Number(m[1]); }
        check('climb: move_to up the 6-high wall (no way on foot) arrived on top', r.status === 'ok' && reached, { status: r.status, result: r.result, pos: [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10) });
        check('climb: no temporary block is left at the foot of the wall', temp === 0, { temp });
    }

    if (only.includes('defend')) {
        await S.must('gamerule doMobSpawning false'); await S.must('difficulty easy');
        await S.must('kill @e[type=minecraft:zombie]');
        const box = { x0: BX + 2, z0: BZ + 14, x1: BX + 13, z1: BZ + 25, top, bottom: top - 1 };
        await S.must(`fill ${box.x0} ${top - 1} ${box.z0} ${box.x1} ${top} ${box.z1} minecraft:stone`);
        await S.must(`clear DemoB`); await S.must(`give DemoB minecraft:iron_pickaxe 3`); await S.must(`give DemoB minecraft:iron_sword 1`); await S.must('effect give DemoB minecraft:resistance 300 2 true');
        await tp('DemoB', box.x0 + 3, top + 1, box.z0 - 1);
        const j = svc.createPit({ name: 'defend', box, bots: ['DemoB'], method: 'sweep', road: false, start: true });
        const job = svc.jobs.get(j.id);
        await until(() => job.impl.ledger.progress().done >= 1, 120000, 'the bot is digging');
        const p = bot('DemoB').entity.position;
        await S.must(`summon minecraft:zombie ${p.x.toFixed(1)} ${(p.y + 1.2).toFixed(1)} ${(p.z + 1.2).toFixed(1)} {PersistenceRequired:1b}`);
        await S.must(`effect clear DemoB minecraft:resistance`);                 // so that the zombie's hit is real damage
        const dead = async () => !(await S.test('entity @e[type=minecraft:zombie]'));
        await until(dead, 90000, 'the zombie is dead');
        const notes = svc.log.filter((e) => /defended itself/.test(e.msg)).map((e) => e.msg);
        await until(() => job.state === 'finished', 300000, 'the job went on to the end');
        check('defend: the bot killed the zombie that attacked it and finished the job', (await dead()) && job.impl.ledger.finished(), { notes, progress: job.impl.ledger.progress() });
        check('defend: no unit was charged for the interruption', job.impl.ledger.stuck.length === 0, { stuck: job.impl.ledger.stuck.length });
    }

    if (only.includes('glow')) {
        const rec = svc.bots.get('DemoC');
        await tp('DemoC', BX + 10, top + 1, BZ + 35);
        svc._problem(rec, 'unit_failed', { reason: 'stuck', stage: 'mine', cell: [BX + 10, top, BZ + 36], job: 'live' });
        await sleep(1500);
        const eff = await S.cmd('data get entity DemoC ActiveEffects');
        check('glow: the problem bot has the glowing effect on the server', /glowing/.test(eff), eff.slice(0, 120));
        const pv = svc.problemsView();
        check('glow: the problem is on record with position, facing and what the bot stood on', pv.recent.length >= 1 && pv.recent[pv.recent.length - 1].heading && pv.recent[pv.recent.length - 1].below, pv.recent[pv.recent.length - 1]);
        svc._clearGlow(rec); await sleep(1200);
        check('glow: cleared after a good unit', !/glowing/.test(await S.cmd('data get entity DemoC ActiveEffects')));
    }

    const ok = results.every((r) => r.ok);
    fs.writeFileSync(process.env.LIVE_OUT || '/tmp/todo-live-result.json', JSON.stringify({ ok, results }, null, 1));
    console.log(`[live] ${ok ? 'ALL PASS' : 'FAILURES'} (${results.filter((r) => r.ok).length}/${results.length})`);
    await S.cmd('forceload remove all'); await svc.stop();
    process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('[live] error', e); process.exit(2); });
