'use strict';
// CONTAINER A (TASK-20261125-076, owner Large 3.4): a survival bot sets the contents of the containers of a blueprint from a real supply chest, and the SERVER
// grades it. Blueprint tests/fixtures/sorter-cell.litematic (scripts/native/make_sorter_cell.js): a sorter's filter hopper (18 cobblestone + 1 stick in each
// other slot, locked by a redstone block) over its chest, a comparator reading it (strength 1); a barrel a comparator reads at strength 3 (247 cobblestone).
//   - setup (test setup, by commands): the blueprint's blocks WITHOUT their contents, a stone floor, a supply chest with exactly the items the containers need;
//     the bot gets tools and food only (kit), peaceful;
//   - the bot's work: `withdraw` the items from the supply chest, then for each container the build job's hook gives (blueprintContainers) one `set_contents`
//     through the console (the router);
//   - judge (server): `data get block` of every container equals the blueprint's Items, the filter hopper's chest is still empty (nothing leaked), the
//     comparators' OutputSignal are 1 and 3. Required: 100 %. CONTROL=noop sends no command (every trial must fail).
//   scripts/t26/run.sh 7 ../native/container_a.js [LIMIT_MIN=4] [CONTROL=noop]       (world slot 7 is this task's; suite: scripts/t26/suite.sh ../native/container_a.js 3 FIRST=7)
const fs = require('fs');
const path = require('path');
const T = require('../t26/lib');
const lit = require('../../src/work/jobs/litematic');
const N = require('../../src/native/inventory');

const LIMIT_MIN = Number(process.env.LIMIT_MIN || 4);
const FILE = process.env.LITEMATIC || path.join(__dirname, '../../tests/fixtures/sorter-cell.litematic');
const name = `Ct${T.WORLD}`;
const strip = T.strip;
const stateStr = (p) => `${p.name.includes(':') ? p.name : 'minecraft:' + p.name}${Object.keys(p.props || {}).length ? `[${Object.entries(p.props).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`;

/** The Items of a block entity as the server reports them: [{slot, item, count}] (SNBT of `data get block`, keys in any order). */
async function itemsAt(S, x, y, z) {
    const o = strip(await S.cmd(`data get block ${x} ${y} ${z} Items`));
    if (/^Found no elements|has the following block data: \[\]/.test(o)) return [];
    const list = [];
    for (const m of o.matchAll(/\{([^{}]*)\}/g)) {
        const s = m[1], slot = /Slot: ?(\d+)b/.exec(s), id = /id: ?"(?:minecraft:)?([^"]+)"/.exec(s), c = /count: ?(\d+)/.exec(s);
        if (slot && id) list.push({ slot: Number(slot[1]), item: id[1], count: c ? Number(c[1]) : 1 });
    }
    return list.sort((a, b) => a.slot - b.slot);
}
async function signalAt(S, x, y, z) { const m = /block data: (\d+)/.exec(strip(await S.cmd(`data get block ${x} ${y} ${z} OutputSignal`))); return m ? Number(m[1]) : null; }

(async () => {
    const rep = T.reporter('container_a');
    const { S, svc, seed } = await T.open([name]);
    const bp = lit.toBlueprint(lit.parse(fs.readFileSync(FILE)));
    const p0 = await T.posOf(S, name);
    await T.onSurface(S, name, Math.floor(p0.x) + 8, Math.floor(p0.z));
    const g = await T.posOf(S, name);
    const O = { x: Math.floor(g.x) + 2, y: Math.floor(g.y) + 1, z: Math.floor(g.z) - 2 };          // the blueprint's 0,0,0: one above the ground, so the floor is ours
    const [sx, sy, sz] = bp.size;
    // site: air above, a stone floor under the whole area (blueprint + supply + standing room)
    await S.must(`fill ${O.x - 2} ${O.y} ${O.z - 2} ${O.x + sx + 2} ${O.y + sy + 2} ${O.z + sz + 2} minecraft:air`);
    await S.must(`fill ${O.x - 2} ${O.y - 1} ${O.z - 2} ${O.x + sx + 2} ${O.y - 1} ${O.z + sz + 2} minecraft:stone`);
    // the blueprint's blocks, empty (solid ones first, then what needs a support or reads a neighbour)
    const late = /comparator|redstone_wire|hopper/;
    for (const pass of [0, 1]) for (const b of bp.blocks) {
        const p = bp.palette[b.s];
        if (/(^|:)air$/.test(p.name) || late.test(p.name) !== (pass === 1)) continue;
        await S.must(`setblock ${O.x + b.x} ${O.y + b.y} ${O.z + b.z} ${stateStr(p)} replace`);
    }
    // the supply: exactly what the containers need, in a chest beside the cell
    const need = N.containerMaterials(bp), sup = { x: O.x + sx + 1, y: O.y, z: O.z + 1 };
    await S.must(`setblock ${sup.x} ${sup.y} ${sup.z} minecraft:chest[facing=west]`);
    let slot = 0;
    for (const { item, n } of need) for (let left = n; left > 0; left -= 64) await S.must(`item replace block ${sup.x} ${sup.y} ${sup.z} container.${slot++} with minecraft:${item} ${Math.min(64, left)}`);
    await T.kit(S, name, { blocks: 0 });
    await S.must(`tp ${name} ${O.x + 1.5} ${O.y} ${O.z + 2.5}`);
    await T.sleep(3000);
    await T.say(S, `container_a: ${name} sets the sorter cell's containers at ${O.x} ${O.y} ${O.z} from the chest at ${sup.x} ${sup.y} ${sup.z}`);

    const goals = N.blueprintContainers(bp, O), steps = [];
    for (const { item, n } of need) steps.push({ cmd: 'withdraw', args: { item, count: n, x: sup.x, y: sup.y, z: sup.z }, r: await T.command(svc, name, 'withdraw', { item, count: n, x: sup.x, y: sup.y, z: sup.z }, LIMIT_MIN) });
    for (const gl of goals) steps.push({ cmd: 'set_contents', at: [gl.x, gl.y, gl.z], r: await T.command(svc, name, 'set_contents', gl.args, LIMIT_MIN) });
    await T.sleep(2000);

    // judge, from the server
    const found = [], wrong = [];
    for (const gl of goals) {
        const have = await itemsAt(S, gl.x, gl.y, gl.z), want = gl.args.contents;
        found.push({ block: gl.block, at: [gl.x, gl.y, gl.z], have });
        if (JSON.stringify(have) !== JSON.stringify(want)) wrong.push({ block: gl.block, want, have });
    }
    const chestBelow = bp.blocks.find((b) => /chest$/.test(bp.palette[b.s].name));
    const leaked = chestBelow ? await itemsAt(S, O.x + chestBelow.x, O.y + chestBelow.y, O.z + chestBelow.z) : [];
    const comps = [];
    for (const b of bp.blocks) {
        if (!/comparator$/.test(bp.palette[b.s].name)) continue;
        const want = require('prismarine-nbt').simplify(b.nbt).OutputSignal, have = await signalAt(S, O.x + b.x, O.y + b.y, O.z + b.z);
        comps.push({ at: [O.x + b.x, O.y + b.y, O.z + b.z], want, have });
    }
    const ok = !wrong.length && !leaked.length && comps.every((c) => c.want === c.have);
    rep.trial(name, ok, { seed, origin: O, wrong, leaked, comparators: comps, steps: steps.map((s) => ({ cmd: s.cmd, at: s.at || null, ok: !!(s.r.result && s.r.result.ok), reason: s.r.result && s.r.result.reason, sec: s.r.sec, timeout: !!s.r.timeout, corrections: s.r.result && s.r.result.detail ? s.r.result.detail.corrections : undefined })), found });
    rep.write({ seed, origin: O });
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
