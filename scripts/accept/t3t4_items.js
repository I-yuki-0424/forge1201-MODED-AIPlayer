'use strict';
// ACCEPTANCE tests 3 and 4 (docs/proposed/ACCEPTANCE-v1.md), through the console's own commands (`runCommand`), graded by the SERVER (`clear <bot> <item> 0` counts what the bot carries):
//   3. from the initial point: 64 logs, 64 cobblestone, 64 stone (smelted), 64 iron ingots   (`obtain`; order: iron, stone, cobblestone, wood: smelting burns fuel, wood last so that what was
//      burnt is gathered again)
//   4. the iron into iron blocks, placed 500 blocks south of the initial point: seven `place iron_block` instructions at seven cells; the router sees no iron block, crafts one first, walks there
//      and places it (the 63 ingots make 7 blocks). Graded: seven iron blocks stand at z = initial z + 500.
// Allowed changes from the initial state: none here (the tools are given by command into the pack as the tools chest would: TOOLS=chest is test 1's way). Env: BOTNAME, SKIP4=1, SOUTH (default 500), LIMIT_MIN per command.
const fs = require('fs');
const L = require('../real/lib');

const A = process.env.BOTNAME || 'AccA', SOUTH = Number(process.env.SOUTH || 500), LIMIT_MIN = Number(process.env.LIMIT_MIN || 90), N3 = Number(process.env.N || 64);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[accept-t3t4] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail !== undefined ? JSON.stringify(detail).slice(0, 700) : ''}`); };
const ENCH = '{Enchantments:[{id:"minecraft:efficiency",lvl:255},{id:"minecraft:unbreaking",lvl:255}]}';

async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A], { teleport: 'off' });
    const rec = svc.bots.get(A), bot = rec.bot; S.name = A;
    await L.sleep(4000);
    const p0 = await L.posOf(S, A), init = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) };
    console.log(`[accept-t3t4] initial point ${JSON.stringify(init)} ${(await S.cmd('seed')).replace(/\x1b\[[0-9;]*m/g, '')}`);
    for (const k of ['pickaxe', 'axe', 'shovel', 'sword']) await S.must(`give ${A} minecraft:netherite_${k}${ENCH} 1`);
    const have = async (item) => S.count(item);
    const send = async (command, args, label) => {
        const t0 = Date.now();
        const r = await svc.runCommand({ bots: [A], command, args });
        if (!r.started || !r.started.length) return { ok: false, reason: 'refused', detail: r };
        while (Date.now() - t0 < LIMIT_MIN * 60000 && rec.cmd && rec.cmd.status === 'running') await L.sleep(2000);
        if (rec.cmd && rec.cmd.status === 'running') rec.cmd.cancel.cancelled = true;
        await L.sleep(1000);
        const res = rec.cmd && rec.cmd.result || {};
        console.log(`[accept-t3t4] ${label}: ${res.ok ? 'ok' : res.reason} in ${Math.round((Date.now() - t0) / 1000)} s ${res.detail ? String(res.detail).slice(0, 300) : ''}`);
        return { ok: !!res.ok, reason: res.reason, sec: Math.round((Date.now() - t0) / 1000) };
    };
    const beat = setInterval(async () => {                              // a heartbeat: where the bot is and what it carries (the steps are printed by obtain itself)
        try { const p = await L.posOf(S, A); const n = {}; for (const k of ['raw_iron', 'iron_ingot', 'coal', 'cobblestone', 'stone', 'furnace', 'crafting_table', 'oak_log', 'birch_log', 'spruce_log']) n[k] = await have(k); console.log(`[accept-t3t4] beat at ${p && [p.x, p.y, p.z].map(Math.round)} cmd ${rec.cmd && rec.cmd.name}/${rec.cmd && rec.cmd.status} ${JSON.stringify(n)}`); } catch (_) { /* the harness never fails on a heartbeat */ }
    }, 120000);
    // ---- test 3
    for (const [item, what] of [['iron_ingot', 'iron'], ['stone', 'smelted stone'], ['cobblestone', 'cobblestone'], ['wood', 'wood']]) await send('obtain', { item, count: N3 }, `obtain ${N3} ${what}`);
    const logs = (await Promise.all(['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry'].map((w) => have(`${w}_log`)))).reduce((a, b) => a + b, 0);
    const got = { logs, cobblestone: await have('cobblestone'), stone: await have('stone'), iron_ingot: await have('iron_ingot') };
    check(`test 3: ${N3} wood, ${N3} cobblestone, ${N3} smelted stone, ${N3} iron (by the server's count of the pack)`, got.logs >= N3 && got.cobblestone >= N3 && got.stone >= N3 && got.iron_ingot >= N3, got);
    // ---- test 4
    if (!process.env.SKIP4) {
        const blocks = Math.floor(got.iron_ingot / 9), tz = init.z + SOUTH, cells = [];
        for (let i = 0; i < Math.min(7, blocks); i++) {
            const st = await L.standCell(S, bot, A, 'overworld', init.x + i, tz);                    // the surface cell of that column, read the way the real-world checks read it
            if (st) cells.push({ x: st.x, y: st.y, z: st.z });
        }
        await S.must(`gamemode survival ${A}`); await L.tpIn(S, A, 'overworld', init.x + 0.5, init.y, init.z + 0.5); await L.sleep(2500);        // back to the initial point (a harness move, before the instruction)
        console.log(`[accept-t3t4] ${cells.length} target cells ${SOUTH} blocks south: ${JSON.stringify(cells).slice(0, 300)}`);
        let placed = 0;
        for (const c of cells) {
            const r = await send('place', { x: c.x, y: c.y, z: c.z, item: 'iron_block' }, `place iron_block at ${c.x},${c.y},${c.z}`);
            if (await S.blockIs(c, 'iron_block')) placed++;
            if (!r.ok && !(await S.blockIs(c, 'iron_block'))) break;
        }
        check(`test 4: ${cells.length} iron blocks stand ${SOUTH} blocks south of the initial point (server)`, cells.length >= 7 && placed >= 7, { placed, wanted: cells.length, ingotsLeft: await have('iron_ingot'), ironBlocksLeft: await have('iron_block') });
    }
    clearInterval(beat); await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`[accept-t3t4] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify({ init, results }, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
