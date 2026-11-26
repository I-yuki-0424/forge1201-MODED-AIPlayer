'use strict';
// CONTAINER B (TASK-20261125-076, owner Large 3.4; orchestrator 2026-11-26): the containers of the OWNER'S Nether blueprint filled by a survival bot, graded by the server.
// The blueprint is the owner's own design and is NOT in this repository (public): LITEMATIC=/out/bp-076/<file>.litematic, a copy of
// /mnt/data/forgeaip-play/schematics/owner-20261126/ironfarm-3x-nether-side.litematic (61 of its 486 containers hold items: sorter filters, shulker boxes).
//   - setup (test setup, by commands, not the bot's work: this test is about operating containers, not building): the game is frozen (`tick freeze`: no hopper,
//     dropper or redstone moves an item; a probe hopper over a chest checks it), every container of the blueprint (chest, hopper, dropper, dispenser) is set at its
//     cell EMPTY on a stone floor, supply chests hold exactly the items the 61 need (one item per chest); a double chest with one stack in each half beside them
//     checks the double-screen slot order (right half first); the bot gets tools, pumpkins and food (kit), peaceful;
//   - the bot's work, through the console (router: it walks, pillars and comes down itself): batches that fit its free slots: `withdraw` what the batch lacks from
//     the supply chests, then one `set_contents` per container of the batch (the build job's hook blueprintContainers, exact); what failed is tried again
//     (up to ROUNDS rounds);
//   - judge (server): `data get block` Items of EVERY placed container: each of the 61 exactly the blueprint's slots and counts, every other one empty (nothing
//     leaked or misplaced), the double chest's halves as planned. Required 100 %. CONTROL=noop sends no command (must fail).
//   cp /mnt/data/forgeaip-play/schematics/owner-20261126/ironfarm-3x-nether-side.litematic /mnt/data/forgeaip-play/t26/out/bp-076/
//   scripts/t26/run.sh 7 ../native/container_b.js RUN=x [LITEMATIC=/out/bp-076/...] [LIMIT_MIN=4] [TOTAL_MIN=150] [ROUNDS=3] [CONTROL=noop]
const fs = require('fs');
const nbt = require('prismarine-nbt');
const T = require('../t26/lib');
const lit = require('../../src/work/jobs/litematic');
const N = require('../../src/native/inventory');

const FILE = process.env.LITEMATIC || '/out/bp-076/ironfarm-3x-nether-side.litematic';
const LIMIT_MIN = Number(process.env.LIMIT_MIN || 4), TOTAL_MIN = Number(process.env.TOTAL_MIN || 150), ROUNDS = Number(process.env.ROUNDS || 3);
const name = `Cb${T.WORLD}`;
const strip = T.strip;
const bare = (n) => String(n).replace(/^minecraft:/, '');
const stateStr = (p) => `${p.name.includes(':') ? p.name : 'minecraft:' + p.name}${Object.keys(p.props || {}).length ? `[${Object.entries(p.props).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`;
const sumUp = (l) => l.map((c) => `${c.slot}:${c.item}x${c.count}`).join(' ');

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
/** The bot's used pack slots (0..35) as the server reports them. */
async function usedSlots(S) {
    const o = strip(await S.cmd(`data get entity ${name} Inventory`));
    return [...o.matchAll(/Slot: ?(\d+)b/g)].map((m) => Number(m[1])).filter((s) => s < 36).length;
}
/** `fill` in y slices that stay under the server's 32768-block limit. */
async function fillBox(S, a, b, block) {
    const per = Math.max(1, Math.floor(32000 / ((b.x - a.x + 1) * (b.z - a.z + 1))));
    for (let y = a.y; y <= b.y; y += per) await S.must(`fill ${a.x} ${y} ${a.z} ${b.x} ${Math.min(b.y, y + per - 1)} ${b.z} ${block}`);
}

(async () => {
    const rep = T.reporter('container_b');
    const { S, svc, seed } = await T.open([name]);
    const bp = lit.toBlueprint(lit.parse(fs.readFileSync(FILE)));
    const reg = svc.bots.get(name).bot.registry, stack = (it) => (reg.itemsByName[it] ? reg.itemsByName[it].stackSize : 64);
    const conts = bp.blocks.filter((b) => b.nbt && N.CONTAINER.test(bare(bp.palette[b.s].name)));
    const lo = { x: Math.min(...conts.map((b) => b.x)), y: Math.min(...conts.map((b) => b.y)), z: Math.min(...conts.map((b) => b.z)) };
    const hi = { x: Math.max(...conts.map((b) => b.x)), y: Math.max(...conts.map((b) => b.y)), z: Math.max(...conts.map((b) => b.z)) };
    const p0 = await T.posOf(S, name);
    await T.onSurface(S, name, Math.floor(p0.x) + 8, Math.floor(p0.z));
    const g = await T.posOf(S, name);
    const F = Math.floor(g.y);                                                         // the floor's top: the lowest containers stand on it
    const O = { x: Math.floor(g.x) + 4 - lo.x, y: F - lo.y, z: Math.floor(g.z) + 4 - lo.z };   // the blueprint's 0,0,0 in the world
    const W = (b) => ({ x: O.x + b.x, y: O.y + b.y, z: O.z + b.z });
    const A = { x: O.x + lo.x - 5, y: F - 1, z: O.z + lo.z - 5 }, B = { x: O.x + hi.x + 5, y: O.y + hi.y + 4, z: O.z + hi.z + 12 };
    await T.say(S, `container_b: ${name} fills the ${conts.length} containers of ${FILE.split('/').pop()} at ${O.x} ${O.y} ${O.z}`);
    await S.cmd(`forceload add ${A.x} ${A.z} ${B.x} ${B.z}`);
    await fillBox(S, { ...A, y: F }, B, 'minecraft:air');
    await fillBox(S, A, { ...B, y: F - 1 }, 'minecraft:stone');

    // freeze, and prove it: a probe hopper with a stick over a chest must keep the stick
    await S.must('tick freeze');
    const pr = { x: A.x + 1, y: F + 1, z: B.z - 1 };
    await S.must(`setblock ${pr.x} ${pr.y - 1} ${pr.z} minecraft:chest`); await S.must(`setblock ${pr.x} ${pr.y} ${pr.z} minecraft:hopper[facing=down]`);
    await S.must(`item replace block ${pr.x} ${pr.y} ${pr.z} container.0 with minecraft:stick 1`);
    await T.sleep(3000);
    const probe = { hopper: await itemsAt(S, pr.x, pr.y, pr.z), chest: await itemsAt(S, pr.x, pr.y - 1, pr.z) };
    await S.must(`setblock ${pr.x} ${pr.y} ${pr.z} minecraft:air`); await S.must(`setblock ${pr.x} ${pr.y - 1} ${pr.z} minecraft:air`);
    const frozen = probe.hopper.length === 1 && !probe.chest.length;

    // the containers, empty, bottom up (a chest pairs with its half when the second is set)
    for (const b of [...conts].sort((a, c) => a.y - c.y || a.x - c.x || a.z - c.z)) { const w = W(b); await S.must(`setblock ${w.x} ${w.y} ${w.z} ${stateStr(bp.palette[b.s])} replace`); }
    // the double-chest check: facing north, left half west, right half east; one stack in each half
    const dc = { y: F, z: O.z + hi.z + 7, x: O.x + lo.x + 2 };
    const dcBp = { palette: [{ name: 'minecraft:chest', props: { facing: 'north', type: 'left' } }, { name: 'minecraft:chest', props: { facing: 'north', type: 'right' } }], blocks: [
        { x: 0, y: 0, z: 0, s: 0, nbt: nbt.comp({ Items: nbt.list(nbt.comp([{ Slot: nbt.byte(5), id: nbt.string('minecraft:poppy'), count: nbt.int(3) }])) }) },
        { x: 1, y: 0, z: 0, s: 1, nbt: nbt.comp({ Items: nbt.list(nbt.comp([{ Slot: nbt.byte(0), id: nbt.string('minecraft:stick'), count: nbt.int(2) }])) }) }] };
    for (const b of dcBp.blocks) await S.must(`setblock ${dc.x + b.x} ${dc.y} ${dc.z} ${stateStr(dcBp.palette[b.s])} replace`);
    const goals = [...N.blueprintContainers(bp, O), ...N.blueprintContainers(dcBp, dc).map((q) => ({ ...q, check: 'double_chest' }))];
    goals.sort((a, c) => (a.check ? 1 : 0) - (c.check ? 1 : 0) || a.y - c.y || a.x - c.x || a.z - c.z);

    // the supply: one item per chest, single chests one cell apart, south of the containers
    const need = new Map();
    for (const q of goals) for (const c of q.args.contents) need.set(c.item, (need.get(c.item) || 0) + c.count);
    const supply = []; let sx = A.x + 2;
    for (const [item, n] of [...need].sort((a, c) => c[1] - a[1])) {
        for (let left = n; left > 0;) {
            const at = { x: sx, y: F, z: O.z + hi.z + 4 }; sx += 2;
            await S.must(`setblock ${at.x} ${at.y} ${at.z} minecraft:chest[facing=north]`);
            let put = 0;
            for (let s = 0; s < 27 && left > 0; s++) { const k = Math.min(stack(item), left); await S.must(`item replace block ${at.x} ${at.y} ${at.z} container.${s} with minecraft:${item} ${k}`); left -= k; put += k; }
            supply.push({ ...at, item, left: put });
        }
    }
    await T.kit(S, name, { blocks: 64 });
    await S.must(`tp ${name} ${A.x + 2.5} ${F} ${O.z + hi.z + 6.5}`);
    await T.sleep(3000);

    // the bot's work
    const t0 = Date.now(), steps = [], res = new Map();
    let pending = goals.slice();
    for (let round = 0; round < ROUNDS && pending.length && Date.now() - t0 < TOTAL_MIN * 60000; round++) {
        const failed = [];
        while (pending.length && Date.now() - t0 < TOTAL_MIN * 60000) {
            const free = 36 - (await usedSlots(S));
            const have = new Map();
            for (const it of need.keys()) have.set(it, await T.holds(S, it));
            const tot = new Map(), batch = [];
            const slotsFor = (m) => [...m].reduce((a, [it, n]) => a + Math.ceil(Math.max(n, have.get(it)) / stack(it)) - Math.ceil(have.get(it) / stack(it)), 0);
            for (const q of pending) {
                const t2 = new Map(tot);
                for (const c of q.args.contents) t2.set(c.item, (t2.get(c.item) || 0) + c.count);
                if (batch.length && slotsFor(t2) > free) break;
                batch.push(q); for (const [k, v] of t2) tot.set(k, v);
            }
            pending = pending.slice(batch.length);
            for (const [item, n] of tot) {
                let lack = n - have.get(item);
                for (const ch of supply) {
                    if (lack <= 0) break;
                    if (ch.item !== item || ch.left <= 0) continue;
                    const take = Math.min(lack, ch.left), before = await T.holds(S, item);
                    const r = await T.command(svc, name, 'withdraw', { item, count: take, x: ch.x, y: ch.y, z: ch.z }, LIMIT_MIN);
                    const got = (await T.holds(S, item)) - before;
                    ch.left -= Math.max(0, got); lack -= Math.max(0, got);
                    steps.push({ cmd: 'withdraw', item, count: take, got, ok: !!(r.result && r.result.ok), reason: r.result && r.result.reason, sec: r.sec });
                }
            }
            for (const q of batch) {
                const r = await T.command(svc, name, 'set_contents', q.args, LIMIT_MIN), ok = !!(r.result && r.result.ok);
                const key = `${q.x},${q.y},${q.z}`;
                res.set(key, { round, ok, reason: r.result && r.result.reason, why: r.result && r.result.detail ? JSON.stringify(r.result.detail).slice(0, 200) : undefined, sec: r.sec, timeout: !!r.timeout });
                steps.push({ cmd: 'set_contents', at: [q.x, q.y, q.z], round, ok, reason: r.result && r.result.reason, sec: r.sec });
                if (!ok) failed.push(q);
            }
        }
        pending = [...failed, ...pending];
    }
    await T.sleep(2000);

    // judge, from the server: every container of the blueprint and the double chest's halves
    const containers = [], leaks = [];
    for (const b of conts) {
        const w = W(b), want = N.fromBlockEntity(b.nbt).filter((c) => !c.comp).map(({ slot, item, count }) => ({ slot, item, count })), have = await itemsAt(S, w.x, w.y, w.z);
        const ok = JSON.stringify(have) === JSON.stringify(want);
        if (want.length) containers.push({ block: bare(bp.palette[b.s].name), rel: [b.x, b.y, b.z], at: [w.x, w.y, w.z], ok, want: sumUp(want), ...(ok ? {} : { have: sumUp(have) }), bot: res.get(`${w.x},${w.y},${w.z}`) || null });
        else if (have.length) leaks.push({ block: bare(bp.palette[b.s].name), rel: [b.x, b.y, b.z], have: sumUp(have) });
    }
    const halves = [];
    for (const b of dcBp.blocks) {
        const want = N.fromBlockEntity(b.nbt).map(({ slot, item, count }) => ({ slot, item, count })), have = await itemsAt(S, dc.x + b.x, dc.y, dc.z);
        halves.push({ half: dcBp.palette[b.s].props.type, ok: JSON.stringify(have) === JSON.stringify(want), want: sumUp(want), have: sumUp(have) });
    }
    const filled = containers.filter((c) => c.ok).length;
    await S.cmd('tick unfreeze');
    const ok = frozen && filled === containers.length && !leaks.length && halves.every((h) => h.ok);
    const cmds = steps.filter((s) => s.cmd === 'set_contents');
    rep.trial(name, ok, { seed, origin: O, frozen, probe, filled: `${filled}/${containers.length}`, leaks, doubleChest: halves, sec: Math.round((Date.now() - t0) / 1000),
        setContents: { sent: cmds.length, ok: cmds.filter((s) => s.ok).length, reasons: cmds.filter((s) => !s.ok).reduce((m, s) => ((m[s.reason || 'none'] = (m[s.reason || 'none'] || 0) + 1), m), {}) },
        withdraws: steps.filter((s) => s.cmd === 'withdraw').length, wrong: containers.filter((c) => !c.ok).slice(0, 20), supplyLeft: supply.filter((c) => c.left > 0).map((c) => `${c.item}x${c.left}`) });
    rep.write({ seed, origin: O, file: FILE.split('/').pop(), containers, leaks, steps });
    await S.cmd(`forceload remove ${A.x} ${A.z} ${B.x} ${B.z}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
