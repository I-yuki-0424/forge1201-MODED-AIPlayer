'use strict';
// ACCEPTANCE test 1 (docs/proposed/ACCEPTANCE-v1.md): strip-mine the starting chunk with ONLY a tools chest and a cobblestone chest placed (tagged), check on the server that nothing is left,
// backfill the whole box with cobblestone, and check that `/fill ... air replace cobblestone` reports 16 x 16 x height blocks. Graded by the SERVER:
//   excavation: `execute if blocks <box slab> <air slab in the sky> masked` passes only when the slab holds no non-air block (it does not change the world); it must FAIL on the untouched chunk (control)
//   backfill: `fill <slab> minecraft:air replace minecraft:cobblestone`, the sum of "Successfully filled N" over the slabs (the last step: it empties the cobblestone again)
// The tools are command-generated (efficiency 255, unbreaking 255). A chest holds 1,728 blocks and the box needs about 36,000: the cobblestone chest is topped up by command whenever it runs low,
// i.e. it is a supply chest that does not run dry. Env: BOTS (default 4), LIMIT_MIN per job (default 120), LIVE_OUT; for a rehearsal W (side, default 16 = the chunk) and DEPTH (layers from the top, default down to y -59).
const fs = require('fs');
const Vec3 = require('vec3');
const L = require('../real/lib');

const W = Number(process.env.W || 16), DEPTH = Number(process.env.DEPTH || 0), BOTS = Number(process.env.BOTS || 4), LIMIT_MIN = Number(process.env.LIMIT_MIN || 120), names = Array.from({ length: BOTS }, (_, i) => `Acc${i + 1}`);
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[accept-t1] ${ok ? 'PASS' : 'FAIL'} ${name} ${detail !== undefined ? JSON.stringify(detail).slice(0, 600) : ''}`); };
const ENCH = '{Enchantments:[{id:"minecraft:efficiency",lvl:255},{id:"minecraft:unbreaking",lvl:255}]}';

async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, names, { teleport: 'off' });
    const bot = svc.bots.get(names[0]).bot; S.name = names[0];
    await L.sleep(4000);
    const p0 = await L.posOf(S, names[0]), init = { x: Math.floor(p0.x), y: Math.floor(p0.y), z: Math.floor(p0.z) };
    const cx = Math.floor(init.x / 16), cz = Math.floor(init.z / 16), x0 = cx * 16, x1 = x0 + W - 1, z0 = cz * 16, z1 = z0 + W - 1;
    const seed = (await S.cmd('seed')).replace(/\x1b\[[0-9;]*m/g, '');
    // the highest non-air block of the chunk, read through the bot's loaded chunks
    const colTop = (x, z) => { for (let y = 319; y >= -64; y--) { const b = bot.blockAt(new Vec3(x, y, z)); if (b && b.name !== 'air' && b.name !== 'cave_air') return y; } return null; };
    let top = -64; for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) top = Math.max(top, colTop(x, z) ?? -64);
    const bottom = DEPTH ? top - DEPTH + 1 : -59, H = top - bottom + 1, box = { x0, z0, x1, z1, top, bottom };
    console.log(`[accept-t1] ${seed} initial point ${JSON.stringify(init)} chunk ${cx},${cz} box ${JSON.stringify(box)} height ${H}`);
    // ---- grading on the server
    const slabs = []; for (let y = bottom; y <= top; y += 100) slabs.push([y, Math.min(y + 99, top)]);
    const refY = Math.max(top + 20, 200), sky = (n) => refY + n;
    const nonAirLeft = async () => {                                     // true when some slab still holds a non-air block
        let left = false;
        for (const [a, b] of slabs) { const o = await S.cmd(`execute if blocks ${x0} ${a} ${z0} ${x1} ${b} ${z1} ${x0} ${sky(0)} ${z0} masked`); if (!/^Test passed/.test(o)) left = true; }
        return left;
    };
    const fillCobble = async () => { let n = 0; for (const [a, b] of slabs) { const o = await S.cmd(`fill ${x0} ${a} ${z0} ${x1} ${b} ${z1} minecraft:air replace minecraft:cobblestone`); const m = /Successfully filled (\d+) block/.exec(o); n += m ? Number(m[1]) : 0; } return n; };
    await S.must(`forceload add ${x0} ${z0} ${x1} ${z1}`);
    check('control: the untouched chunk is NOT clean (the check can fail)', await nonAirLeft() === true);
    // ---- the two chests, outside the box, on the ground; tagged; the tools command-generated
    const ground = (x, z) => { const t = colTop(x, z); return t === null ? init.y : t; };
    const put = async (x, z, f) => { const y = ground(x, z) + 1; await S.must(`setblock ${x} ${y} ${z} minecraft:chest`); await f(x, y, z); return { x, y, z }; };
    const tools = await put(x1 + 2, z0 + 3, async (x, y, z) => {
        const kinds = [['netherite_pickaxe', 12], ['netherite_shovel', 6], ['netherite_axe', 6], ['netherite_sword', 3]]; let slot = 0;
        for (const [k, n] of kinds) for (let i = 0; i < n && slot < 27; i++) await S.must(`item replace block ${x} ${y} ${z} container.${slot++} with minecraft:${k}${ENCH} 1`);
    });
    const cobble = await put(x1 + 2, z0 + 6, async (x, y, z) => { for (let s = 0; s < 27; s++) await S.must(`item replace block ${x} ${y} ${z} container.${s} with minecraft:cobblestone 64`); });
    svc.addSite({ name: 'tools1', ...tools, purpose: 'tools' }); svc.addSite({ name: 'cobble1', ...cobble, purpose: 'free' });
    const refill = async () => {                                         // a supply chest that does not run dry
        const o = await S.cmd(`data get block ${cobble.x} ${cobble.y} ${cobble.z} Items`), slots = (o.match(/Slot: \d+b/g) || []).length;
        if (slots < 12) for (let s = 0; s < 27; s++) await S.cmd(`item replace block ${cobble.x} ${cobble.y} ${cobble.z} container.${s} with minecraft:cobblestone 64`);
    };
    const timer = setInterval(() => refill().catch(() => {}), 20000);
    // ---- strip-mine
    let deaths = 0; for (const n of names) svc.bots.get(n).bot.on('death', () => { deaths++; });
    const waitJob = async (id, what) => {
        const t0 = Date.now(); let last = 0;
        while (Date.now() - t0 < LIMIT_MIN * 60000) {
            const j = svc.jobs.get(id); if (!j || j.state === 'finished' || j.state === 'cancelled') return { state: j && j.state, sec: Math.round((Date.now() - t0) / 1000) };
            if (Date.now() - last > 60000) { last = Date.now(); const v = svc._jobView(j); console.log(`[accept-t1] ${what} ${j.state} ${Math.round((Date.now() - t0) / 60000)} min ${JSON.stringify(v.progress || v.summary || {}).slice(0, 200)}`); }
            await L.sleep(2000);
        }
        return { state: 'timeout', sec: LIMIT_MIN * 60 };
    };
    const pit = svc.createPit({ box, bots: names, start: true });
    const pr = await waitJob(pit.id, 'pit');
    check('the pit job finished', pr.state === 'finished', pr);
    await L.sleep(3000);
    const left = await nonAirLeft();
    check('/fill-style check: nothing but air is left in the box (server, masked compare)', left === false);
    // ---- backfill
    const lay = await svc.createLayout({ kind: 'fill', block: 'cobblestone', x0, z0, x1, z1, y: bottom, height: H, bots: names, start: true });
    const br = await waitJob(lay.id, 'fill');
    check('the backfill job finished', br.state === 'finished', br);
    await L.sleep(3000);
    const n = await fillCobble();
    check(`/fill air replace cobblestone reports ${W} x ${W} x ${H} = ${W * W * H} blocks`, n === W * W * H, { reported: n, expected: W * W * H });
    check('no bot died', deaths === 0, { deaths });
    clearInterval(timer);
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`[accept-t1] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify({ seed, init, box, H, results }, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
