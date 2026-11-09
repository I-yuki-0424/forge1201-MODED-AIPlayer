'use strict';
// Live check of the RL skill experts (src/experts, docs/implemented/EXPERTS-v1.md) on a REAL Forge server (the demo server, flat world): a stone arena high in the sky,
// a bot with a stone pickaxe, and the cases the experts were trained for: walking across open ground and round a wall, climbing out of a shaft and out of a sealed pocket.
// Grading is the SERVER's position of the bot (data get entity), not the bot's report; the plain pathfinder (move_to) is run on the same walls for comparison. Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=expert_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const experts = require('../../src/experts');
const { Server, sleep } = require('../skills/bench');

const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] || true); };       // --only <part of a case name>, --trace
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 400) : ''}`); };
const X0 = 4000, Z0 = 4000, Y0 = 100, TOP = 139, W = 48;          // arena: stone from Y0 to TOP, W x W; the surface to stand on is TOP + 1

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/expert-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 2, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'ExpA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const origMoved = svc._moved.bind(svc); let movesSeen = 0; svc._moved = (n, m) => { movesSeen++; return origMoved(n, m); };
    const bot = svc.bots.get(A).bot, env = svc.envFactory(bot, { cancelled: false });
    S.name = A;
    await S.must(`gamemode survival ${A}`); await S.must('time set day'); await S.must('gamerule doMobSpawning false'); await S.must(`effect give ${A} minecraft:resistance 99999 4 true`);
    await S.must(`tp ${A} ${X0 + 5} ${TOP + 3} ${Z0 + 5}`); await sleep(1500);
    await S.must(`forceload add ${X0} ${Z0} ${X0 + W} ${Z0 + W}`);
    const build = async () => {
        await S.must(`fill ${X0} ${TOP + 1} ${Z0} ${X0 + W - 1} ${TOP + 40} ${Z0 + W - 1} minecraft:air`);
        for (const [a, b] of [[Y0, Y0 + 13], [Y0 + 14, Y0 + 27], [Y0 + 28, TOP]]) await S.must(`fill ${X0} ${a} ${Z0} ${X0 + W - 1} ${b} ${Z0 + W - 1} minecraft:stone`);
    };
    await build();
    const give = async () => { await S.must(`clear ${A}`); await S.must(`give ${A} minecraft:stone_pickaxe 1`); await S.must(`give ${A} minecraft:cobblestone 8`); await sleep(500); };
    const pos = async () => { const n = await S.nums('Pos'); return { x: n[0], y: n[1], z: n[2] }; };
    const putAt = async (c) => { await S.must(`tp ${A} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); await sleep(1500); };
    const dist = (p, t) => Math.hypot(p.x - t.x - 0.5, p.y - t.y, p.z - t.z - 0.5);
    const run = async (name, expert, from, target, { reach = 3.5, maxMs = 150000, fn = null } = {}) => {
        if (arg('--only') && !name.includes(arg('--only'))) return { r: {}, d: 0, sec: 0 };
        await give(); await putAt(from);
        if (arg('--debug')) {
            const { ExpertSpace } = require('../../src/experts/space'), sp = new ExpertSpace(bot, experts.vocabOf(bot)); sp.setTarget(target);
            sp.observe(new Array(26).fill(0), { reason: 'ok', ticks: 0 }, new Map(), { frac: 0, step: 0, tod: 0 });
            console.log('   world', typeof bot.world.getBlockStateId, typeof bot.world.getColumnAt, typeof bot.world.getColumn, typeof bot.world.getBlock, 'sid', typeof require('../../src/skills/world').fromBot(bot).sid, Object.getPrototypeOf(bot.world).constructor.name);
            console.log('   feet', JSON.stringify(sp.here()), 'nodes', sp.lastNodes.length, 'ys', [...new Set(sp.lastNodes.map((n) => n[1]))].join(','), 'cands', JSON.stringify(sp.cands.map((c) => [c.cmd, c.args, c.feat[7]])));
        }
        const t0 = Date.now();
        const r = fn ? await fn() : await experts.drive(bot, expert, target, { exec: env.exec, maxMs, onStep: arg('--trace') ? (s) => console.log('   step', JSON.stringify(s)) : undefined });
        await sleep(600);
        const p = await pos(), d = dist(p, target), sec = Math.round((Date.now() - t0) / 1000);
        check(name, d <= reach, { expert, steps: r.steps, ok: r.ok, reason: r.reason, serverDist: Math.round(d * 10) / 10, serverPos: [p.x, p.y, p.z].map((v) => Math.round(v * 10) / 10), sampled: r.sampled, seconds: sec });
        return { r, d, sec };
    };
    const surf = (x, z) => ({ x, y: TOP + 1, z });

    // 1. open ground
    await run('walk 30 blocks across the arena', 'move', surf(X0 + 5, Z0 + 5), surf(X0 + 35, Z0 + 12));
    // 2. a wall across the way, open at one end: the pathfinder's detour against the expert's
    await S.must(`fill ${X0 + 20} ${TOP + 1} ${Z0} ${X0 + 20} ${TOP + 4} ${Z0 + 40} minecraft:stone`);
    const wallFrom = surf(X0 + 8, Z0 + 20), wallTo = surf(X0 + 32, Z0 + 20);
    await run('walk round a 41-block wall: the plain pathfinder (comparison)', 'path', wallFrom, wallTo, { fn: async () => { const r = await env.exec('move_to', wallTo); return { ok: r.ok, reason: r.reason, steps: 1 }; } });
    await run('walk round a 41-block wall: the movement expert', 'move', wallFrom, wallTo);
    await S.must(`fill ${X0 + 20} ${TOP + 1} ${Z0} ${X0 + 20} ${TOP + 4} ${Z0 + 40} minecraft:air`);
    // 3. shafts: 1 x 1, open to the sky
    for (const depth of [4, 8, 14]) {
        const sx = X0 + 10, sz = Z0 + 10;
        await S.must(`fill ${X0} ${TOP - 20} ${Z0} ${X0 + W - 1} ${TOP} ${Z0 + W - 1} minecraft:stone`);
        await S.must(`fill ${sx} ${TOP - depth + 1} ${sz} ${sx} ${TOP} ${sz} minecraft:air`);
        await run(`climb out of a shaft ${depth} deep: the stuck-escape expert`, 'unstick', { x: sx, y: TOP - depth + 1, z: sz }, surf(sx, sz), { reach: 3.5 });
    }
    // 4. a sealed pocket (two cells of air) 6 and 12 blocks under the surface
    for (const depth of [6, 12]) {
        const sx = X0 + 24, sz = Z0 + 24;
        await S.must(`fill ${X0} ${TOP - 20} ${Z0} ${X0 + W - 1} ${TOP} ${Z0 + W - 1} minecraft:stone`);
        await S.must(`fill ${sx} ${TOP - depth} ${sz} ${sx} ${TOP - depth + 1} ${sz} minecraft:air`);
        await run(`dig out of a sealed pocket ${depth} under the surface: the stuck-escape expert`, 'unstick', { x: sx, y: TOP - depth, z: sz }, surf(sx, sz), { reach: 3.5 });
    }
    // 5. through the work layer: the operator command, the recovery ladder, the long walk. Every server move would be reported to `moved`: none may happen here.
    const env2 = svc.envFactory(bot, { cancelled: false });
    svc.settings.teleport = 'off';
    for (const depth of [6, 10]) {
        const sx = X0 + 10, sz = Z0 + 10;
        await S.must(`fill ${X0} ${TOP - 20} ${Z0} ${X0 + W - 1} ${TOP} ${Z0 + W - 1} minecraft:stone`);
        await S.must(`fill ${sx} ${TOP - depth + 1} ${sz} ${sx} ${TOP} ${sz} minecraft:air`);
        await run(`operator command expert_escape in a shaft ${depth} deep (no target given: the ground is found from the chunks)`, 'unstick', { x: sx, y: TOP - depth + 1, z: sz }, surf(sx, sz), {
            reach: 4, fn: async () => { const r = await svc.runCommand({ bots: [A], command: 'expert_escape', args: {} }); const t0 = Date.now(); while (Date.now() - t0 < 120000) { const c = svc.bots.get(A).cmd; if (c && c.status !== 'running') break; await sleep(300); } return { ok: svc.bots.get(A).cmd.status === 'ok', reason: svc.bots.get(A).cmd.result && svc.bots.get(A).cmd.result.reason, started: r.started }; } });
    }
    {   // the recovery ladder: the last good place is on the surface, the bot is 9 levels down in a shaft; the 'return' fix is the first at level 4
        const sx = X0 + 10, sz = Z0 + 10, depth = 9;
        await S.must(`fill ${X0} ${TOP - 20} ${Z0} ${X0 + W - 1} ${TOP} ${Z0 + W - 1} minecraft:stone`);
        await S.must(`fill ${sx} ${TOP - depth + 1} ${sz} ${sx} ${TOP} ${sz} minecraft:air`);
        await give(); await putAt(surf(sx + 3, sz)); env2.rememberGood();
        await run('recovery ladder: back to the last good place from 9 levels down, with the server moves off', 'unstick', { x: sx, y: TOP - depth + 1, z: sz }, surf(sx + 3, sz), { reach: 4, fn: async () => { await env2.recover(4, { reason: 'stuck' }); return { ok: true, steps: 0 }; } });
    }
    {   // a long walk where no leg can be walked: the bot stands in a walled courtyard (walls 4 high, 14 x 14), the target is outside
        const cx = X0 + 24, cz = Z0 + 24;
        await S.must(`fill ${X0} ${TOP - 20} ${Z0} ${X0 + W - 1} ${TOP} ${Z0 + W - 1} minecraft:stone`);
        await S.must(`fill ${cx - 7} ${TOP + 1} ${cz - 7} ${cx + 7} ${TOP + 4} ${cz + 7} minecraft:stone`);
        await S.must(`fill ${cx - 6} ${TOP + 1} ${cz - 6} ${cx + 6} ${TOP + 4} ${cz + 6} minecraft:air`);
        await run('walk out of a walled courtyard (no way on foot): travel falls back to the movement expert', 'move', surf(cx, cz), surf(cx + 20, cz), { reach: 4, fn: async () => { const r = await env2.travel({ x: cx + 20, y: TOP + 1, z: cz }, { leg: 12 }); return { ok: r.ok, reason: r.reason, steps: r.legs, expert: r.expert }; } });
    }
    svc.settings.teleport = 'near';
    check('no server move happened (the service was never told of one)', movesSeen === 0, { movesSeen });
    await S.must(`forceload remove all`);
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
