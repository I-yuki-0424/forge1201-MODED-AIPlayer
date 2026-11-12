'use strict';
// Live check of the command stack (src/stack, docs/implemented/COMMAND-STACK-v1.md) on a REAL Forge server (the demo server, flat world), through the console's own WorkService, the way the
// owner sends commands from the Commands page (`runCommand`): mine, place, attack and activate at 6-45 blocks, with the pickaxe in the pack but not in the hand, and a bot sealed in a pocket.
// Grading is the SERVER's (block states, the pig's death, the bot's position), never the bot's report. Each case runs with the router and, as the control, with `rawCommands` on (the
// instruction layer called directly, as before). This is a smoke test on a flat arena in the sky, not the real-world verification of REAL-WORLD-VERIFICATION-v1. Test code.
//   scripts/work/live-demo.sh stack_live.js LIVE_OUT=/out/stack.json
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const argv = process.argv.slice(2), arg = (k) => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] || true); };       // --only <part of a case name>, --raw-only
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 700) : ''}`); };
const X0 = 4000, Z0 = 4000, Y0 = 100, TOP = 139, W = 48, SURF = TOP + 1;        // arena: stone from Y0 to TOP, W x W; the surface to stand on is TOP + 1

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/stack-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 2, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'StkA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const rec = svc.bots.get(A);
    let lastRes = null; const origCmd = svc._command.bind(svc); svc._command = async (...a) => { lastRes = await origCmd(...a); return lastRes; };
    S.name = A;
    await S.must(`gamemode survival ${A}`); await S.must('time set day'); await S.must('gamerule doMobSpawning false'); await S.must(`effect give ${A} minecraft:resistance 99999 4 true`);
    await S.must(`tp ${A} ${X0 + 5} ${TOP + 3} ${Z0 + 5}`); await sleep(1500);
    await S.must(`forceload add ${X0} ${Z0} ${X0 + W} ${Z0 + W}`);
    const arena = async () => {
        await S.must(`kill @e[type=minecraft:pig,x=${X0},y=${SURF},z=${Z0},distance=..80]`).catch(() => {});
        // /fill refuses more than 32,768 blocks and says so in its reply, which Server.must does not catch (docs/LESSONS, the 2026-11-10 hazard note): the air above the plateau in slices of 48 x 48 x 10
        for (let y = SURF; y <= TOP + 40; y += 10) await S.must(`fill ${X0} ${y} ${Z0} ${X0 + W - 1} ${Math.min(y + 9, TOP + 40)} ${Z0 + W - 1} minecraft:air`);
        for (const [a, b] of [[Y0, Y0 + 13], [Y0 + 14, Y0 + 27], [Y0 + 28, TOP]]) await S.must(`fill ${X0} ${a} ${Z0} ${X0 + W - 1} ${b} ${Z0 + W - 1} minecraft:stone`);
    };
    // dirt first (hotbar 1), then the pickaxe (hotbar 2): the pickaxe is in the pack and NOT in the hand
    const give = async () => { await S.must(`clear ${A}`); await S.must(`give ${A} minecraft:dirt 4`); await S.must(`give ${A} minecraft:stone_pickaxe 1`); await S.must(`give ${A} minecraft:iron_sword 1`); await S.must(`give ${A} minecraft:cobblestone 16`); await sleep(600); };
    const pos = async () => { const n = await S.nums('Pos'); return { x: n[0], y: n[1], z: n[2] }; };
    const putAt = async (c) => { await S.must(`tp ${A} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); await sleep(1500); };
    const send = async (command, args, { ms = 240000 } = {}) => {
        lastRes = null;
        const r = await svc.runCommand({ bots: [A], command, args });
        if (!r.started || !r.started.length) return { ok: false, reason: 'refused', detail: r };
        const t0 = Date.now();
        while (Date.now() - t0 < ms) { await sleep(300); if (rec.cmd && rec.cmd.status !== 'running') break; }
        const res = lastRes || (rec.cmd && rec.cmd.result) || { ok: false, reason: 'no result' };
        return { ok: !!res.ok, reason: res.reason || (rec.cmd && rec.cmd.result && rec.cmd.result.reason) || null, router: res.detail && res.detail.router ? res.detail.router.map((c) => c.do + (c.ok === false ? `(${c.reason})` : '')) : [], sec: Math.round((Date.now() - t0) / 1000), cmd: rec.cmd && rec.cmd.status, detail: res.detail && !res.detail.router ? res.detail : undefined };
    };
    const cases = [];
    const add = (name, setup, command, args, grade, opt = {}) => cases.push({ name, setup, command, args, grade, opt });
    const stoneAt = async (c) => { const o = await S.cmd(`setblock ${c.x} ${c.y} ${c.z} minecraft:stone`); if (!/Changed/.test(o)) throw new Error(`setblock stone: ${o}`); };
    const sf = (dx, dz) => ({ x: X0 + dx, y: SURF, z: Z0 + dz });

    for (const d of [6, 20, 40]) {
        const t = sf(3 + d, 8);
        add(`mine a block ${d} blocks away, pickaxe in the pack but not in hand`, async () => { await putAt(sf(3, 8)); await stoneAt(t); }, 'mine', { x: t.x, y: t.y, z: t.z },
            async () => ({ ok: await S.blockIs(t, 'air') }));
    }
    {   // a block with a wall between: reached from another side
        const t = sf(30, 24);
        add('mine a block 27 blocks away behind a 9-wide wall', async () => { await putAt(sf(3, 24)); await stoneAt(t); await S.must(`fill ${X0 + 20} ${SURF} ${Z0 + 19} ${X0 + 20} ${SURF + 3} ${Z0 + 29} minecraft:stone`); }, 'mine', { x: t.x, y: t.y, z: t.z },
            async () => ({ ok: await S.blockIs(t, 'air') }));
    }
    {
        const t = sf(24, 10);
        add('place cobblestone 21 blocks away', async () => { await putAt(sf(3, 10)); }, 'place', { x: t.x, y: t.y, z: t.z, item: 'cobblestone' }, async () => ({ ok: await S.blockIs(t, 'cobblestone') }));
    }
    {
        const t = sf(14, 30);
        add('activate a lever 11 blocks away', async () => { await putAt(sf(3, 30)); await S.must(`setblock ${t.x} ${t.y} ${t.z} minecraft:lever[face=floor,facing=north,powered=false]`); }, 'activate', { x: t.x, y: t.y, z: t.z },
            async () => ({ ok: await S.test(`block ${t.x} ${t.y} ${t.z} minecraft:lever[powered=true]`) }));
    }
    {
        const t = sf(18, 36);
        add('attack a pig 15 blocks away (iron sword in the pack, not in hand)', async () => { await putAt(sf(3, 36)); await S.must(`summon minecraft:pig ${t.x + 0.5} ${t.y} ${t.z + 0.5} {NoAI:1b}`); await sleep(500); }, 'attack', { entity: -1 },
            async () => ({ ok: !(await S.test(`entity @e[type=minecraft:pig,x=${t.x},y=${t.y},z=${t.z},distance=..6]`)) }), { entity: t });
    }
    {   // sealed in a two-cell pocket 6 under the surface, the block 12 away on the surface: unstick, move, equip, mine
        const sx = X0 + 24, sz = Z0 + 24, t = sf(36, 24);
        add('mine a block 12 blocks away while sealed in a pocket 6 under the surface', async () => { await S.must(`fill ${sx} ${TOP - 6} ${sz} ${sx} ${TOP - 5} ${sz} minecraft:air`); await putAt({ x: sx, y: TOP - 6, z: sz }); await stoneAt(t); }, 'mine', { x: t.x, y: t.y, z: t.z },
            async () => ({ ok: await S.blockIs(t, 'air') }));
    }

    const only = arg('--only');
    for (const mode of arg('--raw-only') ? ['raw'] : ['router', 'raw']) {
        svc.setSettings({ rawCommands: mode === 'raw' });
        for (const c of cases) {
            if (only && !c.name.includes(only)) continue;
            await arena(); await give();
            await c.setup(); await sleep(2500);                         // the bot's own view of the world catches up with what the server just changed (setblock, fill)
            let args = c.args;
            if (c.command === 'attack') { const n = await S.cmd(`data get entity @e[type=minecraft:pig,limit=1,sort=nearest,x=${c.opt.entity.x},y=${c.opt.entity.y},z=${c.opt.entity.z}] UUID`); void n; const id = Object.values(rec.bot.entities).find((e) => e && e.name === 'pig'); args = { entity: id ? id.id : -1 }; }
            const r = await send(c.command, args);
            await sleep(800);
            const g = await c.grade(), p = await pos();
            check(`[${mode}] ${c.name}`, g.ok, { ...r, serverGraded: g.ok, botAt: [p.x, p.y, p.z].map((v) => Math.round(v)) });
        }
    }
    svc.setSettings({ rawCommands: false });
    await S.must('forceload remove all');
    await svc.stop();
    const by = (m) => results.filter((x) => x.name.startsWith(`[${m}]`));
    for (const m of ['router', 'raw']) console.log(`[live] ${m}: ${by(m).filter((x) => x.ok).length}/${by(m).length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(by('router').some((x) => !x.ok) ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
