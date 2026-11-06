'use strict';
// Live check of the open-pit crew job (src/work/pit.js, docs/proposed/WORKERS-v1.md) on a DISPOSABLE test server
// (scripts/world/test-up.sh): real Forge server, real client physics, real water. Test code.
//
// Arena: a solid stone block high in the sky (so every run is the same, whatever the natural terrain), chunk-aligned. The box
// to dig lies in it. Water is planted where the rule matters: one cell in the ring outside the box (a "river" from a neighbour
// chunk) and one buried cell inside the volume. N bots, one worker each, one ledger. Optional --kill: one bot is killed
// mid-job and the rest must finish its work. Grading is the SERVER's state (RCON fill/replace counts), not the bots' reports.
//
//   scripts/world/test-up.sh latest
//   (cd docker/world-server && docker compose --profile bench run --rm -T -e MC_HOST=world-test -e RCON_HOST=world-test \
//       --entrypoint node bench scripts/work/pit_live.js --run-id p1 --bots 4 --kill 1)
//   scripts/world/test-down.sh
const fs = require('fs');
const path = require('path');
const { createForgeBot, attachForgeHandshake } = require('../../src/transport/forge_bot');
const { Rcon } = require('../../src/rl/rcon');
const { Server, sleep } = require('../skills/bench');
const { createPitJob } = require('../../src/work/jobs/pit');
const { runWorker } = require('../../src/work/bot/worker');
const { botEnv } = require('../../src/work/bot/env');

function args(argv) {
    const o = { runId: null, bots: 4, w: 32, d: 16, depth: 3, kill: 0, root: '/exchange', timeoutMin: 25, baseX: 2000, baseZ: 2000, floorY: 150, method: 'sweep', road: 0, leave: 0, worn: 0 };
    const num = new Set(['bots', 'w', 'd', 'depth', 'kill', 'timeoutMin', 'baseX', 'baseZ', 'floorY', 'road', 'leave', 'worn']);
    const key = { '--run-id': 'runId', '--bots': 'bots', '--w': 'w', '--d': 'd', '--depth': 'depth', '--kill': 'kill', '--root': 'root', '--timeout-min': 'timeoutMin', '--base-x': 'baseX', '--base-z': 'baseZ',
        '--method': 'method', '--road': 'road', '--leave': 'leave', '--worn': 'worn' };       // method sweep|rows; road 0|1; leave 1: bot 1 leaves the finished pit by pillar; worn N: N nearly broken pickaxes first
    for (let i = 0; i < argv.length; i += 2) { const k = key[argv[i]]; if (!k || argv[i + 1] === undefined) throw new Error(`bad argument ${argv[i]}`); o[k] = num.has(k) ? Number(argv[i + 1]) : argv[i + 1]; }
    if (!o.runId) throw new Error('--run-id is required');
    if (o.baseX % 16 || o.baseZ % 16) throw new Error('--base-x/--base-z must be multiples of 16 (chunk aligned)');
    return o;
}

async function main() {
    const o = args(process.argv.slice(2));
    const rc = new Rcon({ host: process.env.RCON_HOST || 'localhost', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const top = o.floorY + 9, box = { x0: o.baseX, z0: o.baseZ, x1: o.baseX + o.w - 1, z1: o.baseZ + o.d - 1, top, bottom: top - o.depth + 1 };

    // ---- arena
    await S.must(`forceload add ${box.x0 - 16} ${box.z0 - 16} ${box.x1 + 16} ${box.z1 + 16}`);
    await S.must(`fill ${box.x0 - 2} ${o.floorY} ${box.z0 - 2} ${box.x1 + 2} ${top} ${box.z1 + 2} minecraft:stone`);
    await S.must(`fill ${box.x0 - 2} ${top + 1} ${box.z0 - 2} ${box.x1 + 2} ${top + 6} ${box.z1 + 2} minecraft:air`);
    const river = { x: box.x1 + 1, y: top, z: box.z0 + Math.floor(o.d / 2) }, river2 = { x: box.x1 + 1, y: top - 1, z: box.z0 + 3 };
    const pocket = { x: box.x0 + 10, y: top - 2, z: box.z0 + Math.floor(o.d / 2) };           // buried inside the volume
    for (const c of [river, river2, pocket]) await S.must(`setblock ${c.x} ${c.y} ${c.z} minecraft:water`);
    console.log(`[pit] arena ${box.x0},${box.z0}..${box.x1},${box.z1}  y ${box.bottom}..${top}; water at ring ${JSON.stringify(river)} ${JSON.stringify(river2)} and inside ${JSON.stringify(pocket)}`);

    // ---- bots
    const names = [...Array(o.bots).keys()].map((i) => `PitBot${i + 1}`);
    const bots = [];
    for (const name of names) {
        const bot = createForgeBot({ host: process.env.MC_HOST || 'localhost', port: Number(process.env.MC_PORT) || 25565, username: name, viewDistance: 4 });
        attachForgeHandshake(bot, { registry: process.env.BOT_REGISTRY || 'auto' });
        bot.on('error', (e) => console.error(`[pit] ${name} error:`, String(e.message || e).slice(0, 200)));
        await new Promise((resolve, reject) => { bot.once('spawn', resolve); setTimeout(() => reject(new Error(`${name}: no spawn`)), 90000); });
        bots.push({ name, bot });
    }
    for (const [i, { name }] of bots.entries()) {
        await S.must(`gamemode survival ${name}`);
        await S.must(`clear ${name}`);
        if (o.worn) for (let k = 0; k < o.worn; k++) await S.must(`give ${name} minecraft:iron_pickaxe{Damage:246} 1`);     // 4 uses left: the worn-tool rule must pass them over
        await S.must(`give ${name} minecraft:iron_pickaxe 6`);      // an iron pickaxe lasts 250 blocks (run p3: all three wore out)
        await S.must(`give ${name} minecraft:cobblestone 32`);
        await S.must(`tp ${name} ${box.x0 + 2 + i * 2}.5 ${top + 1} ${box.z0 - 1}.5`);
    }
    await sleep(3000);

    // ---- the job
    const job = createPitJob(box, { leaseMs: 45000, maxAttempts: 6, maxLead: 1 }, { lanes: o.bots, method: o.method, road: !!o.road });
    const mkEnv = (bot, cancel) => { const e = botEnv(bot, { cancel }); e.configure({ retireWorn: true }); return e; };
    const t0 = Date.now(), cancel = { cancelled: false }, events = [];
    const deadline = setTimeout(() => { console.error('[pit] timeout'); cancel.cancelled = true; }, o.timeoutMin * 60000);
    const results = bots.map(({ name, bot }) => runWorker(job, name, mkEnv(bot, cancel), {
        cancel, pollMs: 1000, policy: require('../../src/work/bot/janitor').pitPolicy(),
        onEvent: (e, d) => { events.push({ t: Math.round((Date.now() - t0) / 1000), e, ...d }); if (e === 'unit') console.log(`[pit] ${d.id} ${d.region} u${d.unit} ${d.role} ${d.ok ? 'ok' : 'FAIL ' + d.reason} ${d.ms} ms ${JSON.stringify(d.detail || {}).slice(0, 160)}`); },
    }));
    if (o.kill) {
        await sleep(40000);
        for (let k = 0; k < o.kill; k++) { console.log(`[pit] killing ${names[k]}`); await S.cmd(`kill ${names[k]}`); }
    }
    let ended = await Promise.all(results);
    // A repair pass: units that went stuck (three failures on three bots) get one more round on the bots that are still alive.
    const alive = bots.filter((b, i) => !ended[i] || ended[i].ended === 'finished');
    if (job.ledger.stuck.length && alive.length && !cancel.cancelled) {
        console.log(`[pit] ${job.ledger.stuck.length} stuck units, repair pass with ${alive.length} bots`);
        job.ledger.requeueStuck(Date.now());
        ended = ended.concat(await Promise.all(alive.map(({ name, bot }) => runWorker(job, name, mkEnv(bot, cancel), { cancel, pollMs: 1000, onEvent: (e, d) => { events.push({ t: Math.round((Date.now() - t0) / 1000), e, ...d }); if (e === 'unit') console.log(`[pit] repair ${d.id} ${d.region} u${d.unit} ${d.ok ? 'ok' : 'FAIL ' + d.reason}`); } }))));
    }
    clearTimeout(deadline);
    const wall = (Date.now() - t0) / 1000;
    console.log('[pit] workers ended:', JSON.stringify(ended), 'wall', wall.toFixed(0), 's');
    console.log('[pit] cobblestone carried:', JSON.stringify(bots.map(({ name, bot }) => [name, bot.inventory.items().filter((i) => i.name === 'cobblestone').reduce((n, i) => n + i.count, 0)])),
        'item entities left near the box:', Object.values(bots[0].bot.entities).filter((e) => e.name === 'item').length);

    // ---- grade from the server: nothing but the road may be left in the volume; the ring cells must be sealed
    const bad = [];
    const left = async (x0, z0, x1, z1, y) => {
        let n = 0;
        for (const blk of ['stone', 'cobblestone', 'water']) {
            const out = await S.cmd(`fill ${x0} ${y} ${z0} ${x1} ${y} ${z1} minecraft:air replace minecraft:${blk}`);
            const m = /filled (\d+) block/.exec(out); if (m) n += Number(m[1]);
        }
        return n;
    };
    for (let l = 0; l < job.plan.layers; l++) {
        const y = top - l;
        const noRoad = !job.plan.road.cells.length;                             // no road: the whole layer must be open
        const rest = await left(box.x0, noRoad ? box.z0 : box.z0 + 1, box.x1, box.z1, y);         // every row except the road row
        const roadRow = noRoad ? 0 : (box.x0 + l + 1 <= box.x1 ? await left(box.x0 + l + 1, box.z0, box.x1, box.z0, y) : 0);
        if (rest || roadRow) bad.push({ layer: l, y, left: rest + roadRow });
    }
    // The way out (owner 2026-11-06): bot 1 leaves the finished pit by pillar; graded by the server: it stands above the rim and no block of its column is left.
    let left_pit = null;
    if (o.leave && alive.length) {
        const { leavePit } = require('../../src/work/bot/exit');
        const { bot, name } = alive[0], env = mkEnv(bot, { cancelled: false });
        const t1 = Date.now(), r = await leavePit(env, box).catch((e) => ({ ok: false, reason: 'internal', detail: { error: String(e.message) } }));
        await sleep(1500);
        const p0 = bot.entity.position;
        const col = {}; for (const blk of ['cobblestone', 'dirt']) { const out = await S.cmd(`fill ${box.x0} ${box.bottom} ${box.z0} ${box.x1} ${top} ${box.z1} minecraft:air replace minecraft:${blk}`); const m = /filled (\d+) block/.exec(out); col[blk] = m ? Number(m[1]) : 0; }
        left_pit = { bot: name, ...r, ms: Date.now() - t1, y: Math.round(p0.y * 10) / 10, above_rim: p0.y >= top + 0.9, stacked_blocks_left_in_box: col };
        console.log('[pit] leave', JSON.stringify(left_pit).slice(0, 400));
        if (!(r.ok && left_pit.above_rim && !col.cobblestone)) bad.push({ leave: left_pit });
    }
    const sealed = []; for (const c of [river, river2]) sealed.push(!(await S.test(`block ${c.x} ${c.y} ${c.z} minecraft:water`)));
    const p = job.ledger.report();
    const ok = !bad.length && p.finished && sealed.every(Boolean);
    const out = { runId: o.runId, ok, wall_s: wall, method: o.method, road: !!o.road, box, bots: o.bots, killed: o.kill, progress: p, left_in_volume: bad, ring_sealed: sealed, left_pit, ended };
    fs.mkdirSync(path.join(o.root, `work-${o.runId}`), { recursive: true });
    fs.writeFileSync(path.join(o.root, `work-${o.runId}`, 'result.json'), JSON.stringify({ ...out, events }, null, 1));
    console.log(`[pit] ${ok ? 'PASS' : 'FAIL'}`, JSON.stringify(out).slice(0, 900));
    for (const { bot } of bots) try { bot.quit(); } catch (_) { /* gone */ }
    await S.cmd(`forceload remove all`);
    process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
