'use strict';
// Flicker probe (TASK-20261125-077, owner list 5 Small 2: "glass and redstone flicker: the blocks exist, their picture turns on and off"). Test code, a live test world only.
// An arena of the blocks the owner named, each with a free cell beside it: glass pane, glass block, redstone wire (on a floor), and a wire with a block placed ABOVE it.
// A survival bot puts a temporary block (a pumpkin) into each free cell and digs it out again, as the builders do with their temporary blocks; the in-game display draws a walking
// path along the row (the old overlay of before 6fe98967 and the current one). An OBSERVER client counts what the server sends for the arena: block changes per cell (with the
// state they carry), light updates of the arena's chunk, and display-entity spawns, removals and metadata. Phases (30 s each): quiet, churn, display old, display new,
// display new + churn. Run: docker run ... node scripts/work/flicker_live.js (see WORK-CONSOLE-v1 v24); OLD=/old (the old display/ folder) for the old overlay.
const fs = require('fs');
const path = require('path');
const { Vec3 } = require('vec3');
const T = require('../t26/lib');
const { createBot, attachHandshake } = require('../../src/transport');
const paths = require('../../src/work/display/paths');
const sleep = T.sleep;
const PHASE_S = Number(process.env.PHASE_S || 30);
const TEMP = /^[a-z_]{1,40}$/.test(process.env.TEMP_ITEM || '') ? process.env.TEMP_ITEM : 'pumpkin';       // the temporary block (pumpkin on the test worlds; cobblestone / dirt where no TEMP_BLOCK is set)
const ONLY_CHURN = process.env.ONLY_CHURN === '1';

function bot(name) {
    const b = createBot({ host: process.env.MC_HOST || 'mc', port: 25565, username: name, viewDistance: 4 });
    attachHandshake(b, { registry: 'vanilla' });
    return new Promise((res, rej) => { b.once('spawn', () => res(b)); b.once('error', rej); setTimeout(() => rej(new Error(`${name}: no spawn`)), 60000); });
}

(async () => {
    const { shared, S } = await T.connectRcon();
    await S.cmd('difficulty peaceful'); await S.cmd('gamerule doDaylightCycle false'); await S.cmd('time set noon');
    const obs = await bot(`Obs${T.WORLD}`), tb = await bot(`Tmp${T.WORLD}`);
    const p0 = await T.posOf(S, tb.username), X = Math.floor(p0.x) + 4, Y = 200, Z = Math.floor(p0.z) + 4;
    // the arena: a stone floor at Y-1, air above; the cases along z, each with the temporary cell at x+1
    await S.cmd(`fill ${X - 6} ${Y - 1} ${Z - 4} ${X + 6} ${Y - 1} ${Z + 12} minecraft:stone`);
    await S.cmd(`fill ${X - 6} ${Y} ${Z - 4} ${X + 6} ${Y + 5} ${Z + 12} minecraft:air`);
    const cases = [
        { name: 'glass_pane', at: [X, Y, Z], set: 'minecraft:glass_pane', temp: [X + 1, Y, Z] },
        { name: 'glass_pane_b', at: [X, Y, Z + 1], set: 'minecraft:glass_pane', temp: null },                 // a pane beside the first one: a pane row like a window
        { name: 'glass', at: [X, Y, Z + 3], set: 'minecraft:glass', temp: [X + 1, Y, Z + 3] },
        { name: 'redstone_wire', at: [X, Y, Z + 5], set: 'minecraft:redstone_wire', temp: [X + 1, Y, Z + 5] },
        { name: 'redstone_wire_b', at: [X - 1, Y, Z + 5], set: 'minecraft:redstone_wire', temp: null },       // a second wire: the first one is a line, not a dot
        { name: 'redstone_wire_up', at: [X, Y, Z + 8], set: 'minecraft:redstone_wire', temp: [X, Y + 1, Z + 8] },  // a block put ABOVE a wire (pillars, posts)
        { name: 'redstone_wire_up_b', at: [X + 1, Y + 1, Z + 8], set: 'minecraft:redstone_wire', temp: null, under: [X + 1, Y, Z + 8] },   // a wire one up, beside: it climbs to it
    ];
    for (const c of cases) { if (c.under) await S.cmd(`setblock ${c.under.join(' ')} minecraft:stone`); await S.cmd(`setblock ${c.at.join(' ')} ${c.set}`); }
    // the observer: spectator, 6 blocks away, looking at it; the temp bot: survival, pumpkins and an axe, standing at x+3 by the row
    await S.cmd(`gamemode spectator ${obs.username}`); await S.cmd(`tp ${obs.username} ${X + 0.5} ${Y + 4} ${Z - 4} 0 30`);
    await S.cmd(`gamemode survival ${tb.username}`); await S.cmd(`clear ${tb.username}`); await S.cmd(`give ${tb.username} minecraft:${TEMP} 64`); await S.cmd(`give ${tb.username} minecraft:netherite_axe[enchantments={efficiency:5}] 1`); await S.cmd(`give ${tb.username} minecraft:netherite_pickaxe[enchantments={efficiency:5}] 1`); await S.cmd(`give ${tb.username} minecraft:netherite_shovel[enchantments={efficiency:5}] 1`);
    await S.cmd(`tp ${tb.username} ${X + 3.5} ${Y} ${Z + 4.5}`);
    await sleep(3000);

    // ---- the observer's counts, per phase
    const key = (x, y, z) => `${x},${y},${z}`, arena = new Map(cases.flatMap((c) => [[key(...c.at), c.name], ...(c.temp ? [[key(...c.temp), `temp beside ${c.name}`]] : [])]));
    const chunkOfArena = new Set(cases.map((c) => `${Math.floor(c.at[0] / 16)},${Math.floor(c.at[2] / 16)}`));
    let phase = 'setup'; const counts = {};
    const bump = (k, n = 1) => { const p = counts[phase] || (counts[phase] = {}); p[k] = (p[k] || 0) + n; };
    const stateName = (id) => { const b = obs.registry.blocksByStateId[id]; if (!b) return `#${id}`; const bl = require('prismarine-block')(obs.registry).fromStateId(id, 0); const pr = bl.getProperties(); return `${b.name}${Object.keys(pr).length ? '[' + Object.entries(pr).map(([k, v]) => `${k}=${v}`).join(',') + ']' : ''}`; };
    const cellChange = (x, y, z, id) => { const n = arena.get(key(x, y, z)); if (n) { bump(`block_change ${n}`); const p = counts[phase]; (p.states || (p.states = {}))[n] = [...new Set([...((p.states || {})[n] || []), stateName(id)])]; } };
    const displayIds = new Set();
    obs._client.on('packet', (d, meta) => {
        const n = meta.name;
        if (n === 'block_change') { const l = d.location; cellChange(l.x, l.y, l.z, d.type); }
        else if (n === 'multi_block_change') {
            const cc = d.chunkCoordinates || {}; bump('multi_block_change (any)');
            for (const r of d.records || []) { const v = typeof r === 'number' ? r : Number(r); const id = Math.floor(v / 4096), lx = (v >> 8) & 15, lz = (v >> 4) & 15, ly = v & 15; cellChange(cc.x * 16 + lx, cc.y * 16 + ly, cc.z * 16 + lz, id); }
        } else if (n === 'update_light') { if (chunkOfArena.has(`${d.chunkX},${d.chunkZ}`)) bump('update_light (arena chunk)'); }
        else if (n === 'block_break_animation') { bump('block_break_animation'); }
        else if (n === 'spawn_entity') { const t = obs.registry.entities[d.type]; if (t && t.name === 'block_display') { displayIds.add(d.entityId); bump('display spawn'); } }
        else if (n === 'entity_destroy') { for (const id of d.entityIds || []) if (displayIds.delete(id)) bump('display remove'); }
        else if (n === 'entity_metadata') { if (displayIds.has(d.entityId)) bump('display metadata'); }
        else if (n === 'entity_teleport') { if (displayIds.has(d.entityId)) bump('display teleport'); }
        else if (n === 'map_chunk') { if (chunkOfArena.has(`${d.x},${d.z}`)) bump('map_chunk (arena chunk)'); }
    });

    // ---- the temporary blocks: put a pumpkin into each temp cell and dig it out again, as long as `on`
    let churn = false, placed = 0, dug = 0;
    (async () => {
        const pump = () => tb.inventory.items().find((i) => i.name === TEMP);
        const tool = (b) => tb.inventory.items().find((i) => i.name === (/pumpkin|log|planks/.test(b.name) ? 'netherite_axe' : /dirt|sand|gravel/.test(b.name) ? 'netherite_shovel' : 'netherite_pickaxe'));
        for (;;) {
            if (!churn) { await sleep(200); continue; }
            for (const c of cases) {
                if (!churn || !c.temp) continue;
                const [x, y, z] = c.temp;
                try {
                    const under = tb.blockAt(new Vec3(x, y - 1, z)); if (!under || under.name === 'air') continue;
                    await tb.equip(pump(), 'hand'); await tb.placeBlock(under, new Vec3(0, 1, 0)); placed++;
                    await sleep(400);
                    const b = tb.blockAt(new Vec3(x, y, z)); if (b && b.name === TEMP) { await tb.equip(tool(b), 'hand'); await tb.dig(b, true); dug++; }
                    await sleep(400);
                } catch (e) { bump(`churn error ${String(e.message).slice(0, 40)}`); await sleep(500); }
            }
        }
    })();

    // ---- the display: a path walking along the row at x-2 (beside the panes and wires), one cell a second, drawn by the old or the new overlay
    const row = []; for (let i = -10; i <= 22; i++) row.push([X - 2, Y, Z + i]);
    let walkAt = 0; const pathRec = { cells: row, at: Date.now(), serial: 1 };
    const viewer = async () => [{ name: obs.username, x: X, y: Y + 4, z: Z - 4, dim: 'minecraft:overworld' }];
    const stateOf = () => { const p = row[Math.min(row.length - 1, walkAt)], pos = { x: p[0] + 0.5, y: p[1], z: p[2] + 0.5 }; paths.advance(pathRec, pos); return { bots: [{ name: tb.username, color: 0, dim: 'overworld', pos, path: pathRec }], lanes: [], tags: [] }; };
    const overlayOf = (dir) => { const { Overlay } = require(path.join(dir, 'overlay')); return new Overlay({ rcon: (c) => shared.command(c), pending: () => 0, config: () => ({ on: true }), state: stateOf, humans: viewer, frameMs: 1000 }); };
    const run = async (name, { display = null, temp = false }) => {
        phase = name; churn = temp; walkAt = 0; Object.assign(pathRec, { at: Date.now(), idx: undefined, gainAt: undefined, offAt: undefined });
        const o = display ? overlayOf(display) : null;
        const t0 = Date.now();
        while (Date.now() - t0 < PHASE_S * 1000) { if (o) { await o.frame(); } await sleep(1000); walkAt = (walkAt + 1) % row.length; if (walkAt === 0) { pathRec.at = Date.now(); pathRec.idx = undefined; } }
        churn = false; if (o) { await o.clear(); }
        await sleep(2500);
        bump('seconds', PHASE_S);
    };
    await run('quiet', {});
    await run(`churn of ${TEMP} (display off)`, { temp: true });
    if (!ONLY_CHURN) {
        if (process.env.OLD) await run('display OLD (no churn)', { display: process.env.OLD });
        await run('display NEW (no churn)', { display: path.join(__dirname, '../../src/work/display') });
        await run(`display NEW + churn of ${TEMP}`, { display: path.join(__dirname, '../../src/work/display'), temp: true });
    }
    const out = { world: T.WORLD, profile: T.PROFILE, temp: TEMP, arena: { X, Y, Z }, phaseSeconds: PHASE_S, placed, dug, counts };
    fs.writeFileSync(`/out/flicker-${T.RUN}.json`, JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
    obs.quit(); tb.quit(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
