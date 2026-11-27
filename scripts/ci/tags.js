'use strict';
// CI test TAGS (TASK-20261125-080, owner list 5 Medium 2: "pit, movement, tags"): supply and storage BY TAG, the work console's own code path, graded by the server.
//   - setup (test setup, by commands): a flat stone floor (25 x 25) at the world spawn with five chests tagged as sites: `tools` (one diamond pickaxe), `free` (32 torches, the farthest),
//     `ore` (16 torches as a DECOY, the nearest), `trash`, `any`; one survival bot without a pickaxe; Peaceful;
//   - trial "supply": a stored script (src/work/bot/script.js) `take_tool {pickaxe from tools}` then `take {torch x16 from free}`; passes when the server finds the pickaxe and 16
//     torches in the pack, the tools chest without its pickaxe, the free chest at 16 torches and the decoy untouched at 16 (the asked purpose before the nearest container);
//   - trial "storage": the bot holds raw iron, coal, gravel and ender pearls; the script `put_away` with the pit's upkeep policy over the tagged sites (the same janitor a pit
//     job runs); passes when the server finds raw iron and coal in `ore`, gravel in `trash`, the pearls in `any`, none of them anywhere else and none left in the pack.
//   CONTROL=noop runs no script (both trials must fail).
//   scripts/t26/run.sh N ../ci/tags.js [LIMIT_MIN=6] [CONTROL=noop]
const T = require('../t26/lib');
const scriptLib = require('../../src/work/bot/script');

const LIMIT_MIN = Number(process.env.LIMIT_MIN || 6), name = `Tag${T.WORLD}`;
const strip = T.strip;

/** A container's items as the server has them: { item: count }. */
async function items(S, p) {
    const o = strip(await S.cmd(`data get block ${p.x} ${p.y} ${p.z} Items`)), out = {};
    for (const m of o.matchAll(/\{([^{}]*)\}/g)) {
        const id = /id: "minecraft:([a-z0-9_]+)"/.exec(m[1]), c = /count: (\d+)/.exec(m[1]);
        if (id) out[id[1]] = (out[id[1]] || 0) + (c ? Number(c[1]) : 1);
    }
    return out;
}

async function withTimeout(p, ms) { let t; try { return await Promise.race([p, new Promise((res) => { t = setTimeout(() => res({ ok: false, reason: 'timeout' }), ms); })]); } finally { clearTimeout(t); } }

(async () => {
    const rep = T.reporter('tags');
    const { S, svc, seed } = await T.open([name]);
    const deaths = T.countDeaths(svc, [name], S), moves = T.countMoves(svc), rec = svc.bots.get(name);
    const p0 = await T.posOf(S, name), c = { x: Math.floor(p0.x), z: Math.floor(p0.z) };
    await T.onSurface(S, name, c.x, c.z);
    const g = await T.posOf(S, name), Y = Math.floor(g.y);
    await S.must(`forceload add ${c.x - 13} ${c.z - 13} ${c.x + 13} ${c.z + 13}`);
    await S.must(`fill ${c.x - 12} ${Y - 3} ${c.z - 12} ${c.x + 12} ${Y - 1} ${c.z + 12} minecraft:stone`);
    await S.must(`fill ${c.x - 12} ${Y} ${c.z - 12} ${c.x + 12} ${Y + 6} ${c.z + 12} minecraft:air`);
    const at = (dx, dz) => ({ x: c.x + dx, y: Y, z: c.z + dz });
    const C = { tools: at(8, 0), free: at(-10, 0), ore: at(0, 3), trash: at(0, -9), any: at(8, 8) }      // out of reach of the start: the bot walks to each;
    for (const p of Object.values(C)) await S.must(`setblock ${p.x} ${p.y} ${p.z} minecraft:chest`);
    await S.must(`tp ${name} ${c.x + 0.5} ${Y} ${c.z + 0.5}`); await T.sleep(2500);             // the site check asks the bot's world: it must have seen the chests
    for (const [k, p] of Object.entries(C)) svc.addSite({ name: `ci-${k}`, x: p.x, y: p.y, z: p.z, purpose: k });
    await S.must(`item replace block ${C.tools.x} ${C.tools.y} ${C.tools.z} container.0 with minecraft:diamond_pickaxe 1`);
    await S.must(`item replace block ${C.free.x} ${C.free.y} ${C.free.z} container.0 with minecraft:torch 32`);
    await S.must(`item replace block ${C.ore.x} ${C.ore.y} ${C.ore.z} container.0 with minecraft:torch 16`);
    await S.must(`tp ${name} ${c.x + 0.5} ${Y} ${c.z + 0.5}`);
    await S.cmd(`clear ${name}`);
    await S.must(`give ${name} minecraft:${T.TEMP_BLOCK} 64`); await S.must(`give ${name} minecraft:cooked_beef 16`);
    await T.sleep(2500);
    await T.say(S, `tags: supply and storage by tag at ${c.x} ${Y} ${c.z}`);

    const run = async (sc, policy) => {
        if (T.CONTROL === 'noop') { await T.sleep(3000); return { ok: null, control: true, sec: 3 }; }
        const t0 = Date.now(), cancel = { cancelled: false }, env = svc.envFactory(rec.bot, cancel);
        const senv = Object.assign(Object.create(env), { sites: svc.sites, policy });
        rec.script = { cancel, name: sc.name };
        try { const r = await withTimeout(scriptLib.runScript(scriptLib.validate(sc), senv, { cancel }), LIMIT_MIN * 60000); if (r.reason === 'timeout') cancel.cancelled = true; return { ok: !!r.ok, ended: r.ended || r.reason, log: (r.log || []).slice(-8), sec: Math.round((Date.now() - t0) / 1000) }; }
        catch (e) { return { ok: false, error: String(e.message).slice(0, 200), sec: Math.round((Date.now() - t0) / 1000) }; }
        finally { rec.script = null; }
    };

    // 1. supply by tag
    const sup = await run({ name: 'ci-supply', steps: [{ take_tool: { class: 'pickaxe', from: 'tools' } }, { take: { item: 'torch', count: 16, from: 'free' } }, { return: 'ok' }] });
    await T.sleep(1500);
    const s = { pickaxe: await T.holds(S, name, 'diamond_pickaxe'), torch: await T.holds(S, name, 'torch'), tools: await items(S, C.tools), free: await items(S, C.free), decoy: await items(S, C.ore) };
    const supOk = s.pickaxe >= 1 && s.torch === 16 && !s.tools.diamond_pickaxe && s.free.torch === 16 && s.decoy.torch === 16;
    const out = [[`${name}-supply`, supOk, { run: sup, server: s }]];

    // 2. storage by tag
    const GIVE = { raw_iron: 32, coal: 20, gravel: 64, ender_pearl: 8 }, WANT = { raw_iron: 'ore', coal: 'ore', gravel: 'trash', ender_pearl: 'any' };
    for (const [it, n] of Object.entries(GIVE)) await S.must(`give ${name} minecraft:${it} ${n}`);
    await T.sleep(1500);
    const sto = await run({ name: 'ci-store', steps: [{ put_away: true }, { return: 'ok' }] }, svc._pitPolicy(null));
    await T.sleep(1500);
    const box = {}; for (const k of ['ore', 'trash', 'any']) box[k] = await items(S, C[k]);
    const left = {}; for (const it of Object.keys(GIVE)) left[it] = await T.holds(S, name, it);
    const wrong = [];
    for (const [it, n] of Object.entries(GIVE)) {
        if ((box[WANT[it]][it] || 0) !== n) wrong.push(`${it}: ${box[WANT[it]][it] || 0}/${n} in ${WANT[it]}`);
        for (const k of ['ore', 'trash', 'any']) if (k !== WANT[it] && box[k][it]) wrong.push(`${it}: ${box[k][it]} in ${k}`);
        if (left[it]) wrong.push(`${it}: ${left[it]} left in the pack`);
    }
    out.push([`${name}-storage`, !wrong.length, { run: sto, wrong, server: { box, left } }]);

    await deaths.read();
    const safe = !deaths[name] && !moves[name];                                         // a death or a server move fails every trial
    for (const [b, ok, d] of out) rep.trial(b, ok && safe, { ...d, deaths: deaths[name], moves: moves[name] || 0 });
    await S.cmd(`forceload remove ${c.x - 13} ${c.z - 13} ${c.x + 13} ${c.z + 13}`);
    rep.write({ seed, site: { x: c.x, y: Y, z: c.z } });
    process.exit(0);
})().catch((e) => { console.error('[tags] crashed:', e && e.stack || e); process.exit(1); });
