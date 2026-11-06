'use strict';
// Live check of tagged-block links and the in-game display on a REAL Forge server (the demo server of /mnt/data/forgeaip-play/demo,
// the play world's mod set). WorkService with real bots and real RCON; grading is the SERVER's state. Test code.
//
//   (cd /mnt/data/forgeaip-play/demo && ./live.sh --script display_live.js)
//
//   links    withdraw/deposit at the coordinates of a furnace linked to a chest move the chest's items; smelt on it is refused
//   display  every particle command the overlay sends is accepted by the server (reply), a frame fits the budget, a bot's walk gives a path,
//            and a frame does not hold up the bots' own commands
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Overlay } = require('../../src/work/display/overlay');
const { Server, sleep } = require('../skills/bench');

const FLOOR = -61, BX = 2400, BZ = 2400;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/display-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: { command: (c) => shared.command(c) } });
    svc.settings.autoKit = false;
    const A = 'LinkA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    await S.must(`gamemode survival ${A}`); await S.must(`clear ${A}`); await S.must('gamerule doMobSpawning false'); await S.must('time set day');
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 48} ${BZ + 48}`);
    const top = FLOOR + 4;
    await S.must(`fill ${BX - 2} ${FLOOR + 1} ${BZ - 2} ${BX + 40} ${top} ${BZ + 40} minecraft:stone`);
    await S.must(`fill ${BX - 2} ${top + 1} ${BZ - 2} ${BX + 40} ${top + 8} ${BZ + 40} minecraft:air`); await sleep(1500);
    const y = top + 1;
    const cmd = async (command, args, ms = 60000) => {
        const r = await svc.runCommand({ bots: [A], command, args });
        if (r.refused.length) return { status: 'refused', reason: r.refused[0].why };
        await sleep(300); await until(() => svc.bots.get(A).cmd.status !== 'running', ms, command);
        return { ...svc.bots.get(A).cmd, via: r.via };
    };
    const have = (item) => bot.inventory.items().filter((i) => i.name === item).reduce((a, i) => a + i.count, 0);
    const chestCount = async (x, yy, z, item) => { const o = await S.cmd(`data get block ${x} ${yy} ${z} Items`); const m = [...o.matchAll(new RegExp(`Count: (\\d+)b[^}]*id: "minecraft:${item}"|id: "minecraft:${item}"[^}]*Count: (\\d+)b`, 'g'))]; return m.reduce((a, k) => a + Number(k[1] || k[2]), 0); };

    // ---------------------------------------------------------------- links
    // chest at (BX+4, y, BZ+4), furnace beside it at (BX+4, y, BZ+5): the chest is what a hopper would feed it from
    const cx = BX + 4, cz = BZ + 4;
    await S.must(`setblock ${cx} ${y} ${cz} minecraft:chest`); await S.must(`setblock ${cx} ${y} ${cz + 1} minecraft:furnace`);
    await S.must(`item replace block ${cx} ${y} ${cz} container.0 with minecraft:iron_ingot 16`);
    await S.must(`tp ${A} ${cx + 0.5} ${y} ${cz - 1.5}`); await sleep(1500);
    svc.addSite({ name: 'live-chest', x: cx, y, z: cz, tags: ['ore'] });
    svc.addSite({ name: 'live-furnace', x: cx, y, z: cz + 1, tags: ['machine'], label: 'auto furnace', via: 'live-chest' });
    const lst = svc.listSites().sites.find((s) => s.name === 'live-furnace');
    check('listing shows the block the world has there and where the link ends', lst.block === 'furnace' && lst.end && lst.end.z === cz, { block: lst.block, end: lst.end });
    const w = await cmd('withdraw', { item: 'iron_ingot', count: 8, x: cx, y, z: cz + 1 });
    check('withdraw at the furnace takes from the chest', w.status === 'ok' && have('iron_ingot') === 8 && (await chestCount(cx, y, cz, 'iron_ingot')) === 8, { status: w.status, result: w.result, via: w.via, inv: have('iron_ingot'), chest: await chestCount(cx, y, cz, 'iron_ingot') });
    const d = await cmd('deposit', { item: 'iron_ingot', count: 3, x: cx, y, z: cz + 1 });
    check('deposit at the furnace puts into the chest', d.status === 'ok' && have('iron_ingot') === 5 && (await chestCount(cx, y, cz, 'iron_ingot')) === 11, { status: d.status, result: d.result, inv: have('iron_ingot'), chest: await chestCount(cx, y, cz, 'iron_ingot') });
    const byName = await cmd('withdraw', { item: 'iron_ingot', count: 1, site: 'live-furnace' });
    check('the tag name works instead of coordinates', byName.status === 'ok' && have('iron_ingot') === 6, { status: byName.status, result: byName.result });
    const sm = await cmd('smelt', { item: 'iron_ingot', x: cx, y, z: cz + 1 }).catch((e) => ({ status: 'refused', reason: e.message }));
    check('smelt on the linked machine is refused with the way to do it', sm.status === 'refused' && /use deposit/.test(sm.reason || ''), sm.reason);
    const furnaceItems = await S.cmd(`data get block ${cx} ${y} ${cz + 1} Items`);
    check('the furnace itself was never opened or filled', /\[\]|no such|does not have/i.test(furnaceItems) || !/iron_ingot/.test(furnaceItems), furnaceItems.slice(0, 80));

    // ---------------------------------------------------------------- display
    const replies = []; let slow = 0;
    const timed = async (c) => { const t0 = Date.now(); const r = await shared.command(c); if (c.startsWith('particle')) { replies.push(String(r)); slow = Math.max(slow, Date.now() - t0); } return r; };
    // The bot is the viewer here (nobody else is online); the tag and the selector are the real ones.
    svc.createPit({ name: 'show', box: { x0: BX + 10, z0: BZ + 10, x1: BX + 25, z1: BZ + 25, top: y + 1, bottom: y - 2 }, lanes: 4 });
    svc.addSite({ name: 'live-chest2', x: BX + 8, y, z: BZ + 8, tags: ['storage'] });
    const o = new Overlay({ rcon: timed, pending: () => 0, config: () => svc.settings.display, state: () => svc.displayState(), humans: async () => [{ name: A, x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }], budget: 70 });
    // a walk gives the display a path
    const walk = svc.runCommand({ bots: [A], command: 'move_to', args: { x: BX + 30, y, z: BZ + 30 } });
    await until(() => svc.displayState().bots[0].path, 30000, 'a path from the planner').catch(() => {});
    const st = svc.displayState();
    check('a walk gives the display the planner\'s cells', st.bots[0].path && st.bots[0].path.cells.length > 5, st.bots[0].path && st.bots[0].path.cells.length);
    check('pit lanes are in the state, one colour each', st.lanes.length >= 4 && new Set(st.lanes.map((l) => l.color)).size === st.lanes.length, st.lanes.length);
    await walk; await until(() => svc.bots.get(A).cmd.status !== 'running', 90000, 'walk end');
    const t0 = Date.now(); const n = await o.frame(); const dt = Date.now() - t0;
    const bad = replies.filter((r) => !/Displaying particle/i.test(r));
    check('the server accepts every particle command of a frame', n > 20 && !bad.length, { sent: n, bad: bad.slice(0, 2), sample: replies[0] });
    check('a frame of the budget takes well under its interval', dt < 1200, { ms: dt, slowestMs: slow });
    check('the viewer carries the tag the selector uses', /aip_see/.test(await S.cmd(`data get entity ${A} Tags`)), undefined);

    await svc.stop(); await S.must(`forceload remove ${BX - 16} ${BZ - 16} ${BX + 48} ${BZ + 48}`).catch(() => {});
    const failed = results.filter((r) => !r.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
