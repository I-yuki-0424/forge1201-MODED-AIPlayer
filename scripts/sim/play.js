'use strict';
// Re-play a recorded run on the real server (TASK-20261125-078, docs/proposed/SIM-PARITY-v1.md section 4: the noise floor). The real server against itself:
// on a NEW world of the same seed, the recorded blocks are put back (every cell of every recorded chunk's first snapshot that differs, by setblock), then
// every recorded `execute` command runs again, in the recorded order, each from the recorded bot state (position and look by tp, the pack by clear + item
// replace, the hotbar slot). Run with the recorder, so the re-play is a trace of its own; `forgeaip-sim compare A B` pairs the two command by command
// (`ref` = the recorded id) and leaves out commands whose surroundings differed at the start.
//   scripts/t26/up.sh N --new --seed <the recorded seed>
//   REPO=$PWD scripts/t26/run.sh N ../sim/play.js TRACE=/out/simrec/<run> SIMREC_DIR=/out/simrec/<run>-play NODE_ARGS=--require=./scripts/sim/record.js [ONLY=bot1,bot2] [MAX=n]
// Work-layer moves (`move:<name>`, moves.js runMove) are re-played too; other runner-level calls and commands that ended `cancelled` (the caller's timing) are not; they are counted.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const Vec3 = require('vec3');
const T = require('../t26/lib');

const TRACE = process.env.TRACE, ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null, MAX = Number(process.env.MAX || 1e9);
if (!TRACE) throw new Error('TRACE=<directory of the recorded run>');

/** One recorded bot: its states, the first snapshot of each chunk, and its commands with their results. */
function load(file) {
    const st = new Map(), chunks = new Map(), cmds = new Map(); let hello = null;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line) continue;
        const j = JSON.parse(line);
        if (j.t === 'hello' && !hello) hello = j;
        else if (j.t === 'st') st.set(j.id, j);
        else if (j.t === 'chunk' && !chunks.has(`${j.cx},${j.cz}`)) chunks.set(`${j.cx},${j.cz}`, j);
        else if (j.t === 'cmd') cmds.set(j.id, { cmd: j, res: null });
        else if (j.t === 'res' && cmds.has(j.id)) cmds.get(j.id).res = j;
    }
    return { hello, st, chunks, cmds: [...cmds.values()].filter((c) => c.res) };
}
const stateString = (s) => { const p = Object.entries(s.p || {}); return `minecraft:${s.n}${p.length ? `[${p.map(([k, v]) => `${k}=${v}`).join(',')}]` : ''}`; };

/** Mineflayer slot -> the server's slot name for `item replace entity`. */
function slotName(i) {
    if (i >= 36 && i <= 44) return `hotbar.${i - 36}`;
    if (i >= 9 && i <= 35) return `inventory.${i - 9}`;
    return { 5: 'armor.head', 6: 'armor.chest', 7: 'armor.legs', 8: 'armor.feet', 45: 'weapon.offhand' }[i] || null;
}
/** The item with its components, as `item replace` takes it (1.20.5+ component syntax). */
function itemString(row) {
    const [, name, , dmg, ench] = row, comps = [];
    const levels = (ench || []).filter(([n]) => n !== 'unbreakable');
    if (levels.length) comps.push(`enchantments={levels:{${levels.map(([n, l]) => `"minecraft:${n}":${l}`).join(',')}}}`);
    if ((ench || []).some(([n]) => n === 'unbreakable')) comps.push('unbreakable={}');
    if (dmg) comps.push(`damage=${dmg}`);
    return `minecraft:${name}${comps.length ? `[${comps.join(',')}]` : ''}`;
}
const invKey = (inv) => JSON.stringify((inv || []).map((r) => [r[0], r[1], r[2], r[4] || null]).sort((a, b) => a[0] - b[0]));
const rowsOf = (bot) => require('./record').botState(bot).inv;

(async () => {
    const rep = T.reporter('sim_play');
    const files = fs.readdirSync(TRACE).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(TRACE, f));
    const recs = files.map(load).filter((r) => r.hello && (!ONLY || ONLY.has(r.hello.bot)));
    if (!recs.length) throw new Error(`no traces in ${TRACE}`);
    const names = recs.map((r) => r.hello.bot);
    const { S, svc, seed } = await T.open(names);
    console.log(`[play] seed ${seed}; bots ${names.join(' ')}; recorded seed must be the same (up.sh N --new --seed S)`);
    const bots = new Map(names.map((n) => [n, svc.bots.get(n).bot]));
    const { execute } = require('../../src/skills');

    // 1. the recorded blocks back: per recorded chunk, every cell that differs from the new world's copy (seen from a bot standing in it)
    const chunks = new Map();
    for (const r of recs) for (const [k, c] of r.chunks) if (!chunks.has(k) || chunks.get(k).ms > c.ms) chunks.set(k, { ...c, st: r.st });
    const b0 = bots.get(names[0]);
    let restored = 0, skippedChunks = 0;
    await S.must(`gamemode spectator ${names[0]}`);                                   // flying from chunk to chunk without falling
    for (const c of chunks.values()) {
        await S.must(`forceload add ${c.cx * 16} ${c.cz * 16}`);
        await S.must(`tp ${names[0]} ${c.cx * 16 + 8} 320 ${c.cz * 16 + 8}`);
        let col = null;
        for (let i = 0; i < 60 && !col; i++) { await T.sleep(250); col = b0.world.getColumn(c.cx, c.cz); }
        if (!col) { skippedChunks++; console.log(`[play] chunk ${c.cx},${c.cz} never arrived`); continue; }
        await T.sleep(500);
        const cells = new Uint16Array(zlib.inflateSync(Buffer.from(c.cells, 'base64')).buffer.slice(0));
        const diffs = [];
        const p = { x: 0, y: 0, z: 0 };
        for (let k = 0; k < cells.length; k++) {
            p.x = k % 16; p.z = (k >> 4) % 16; p.y = Math.floor(k / 256) + c.minY;
            const now = col.getBlockStateId(p);
            if (now !== cells[k]) diffs.push([c.cx * 16 + p.x, p.y, c.cz * 16 + p.z, cells[k]]);
        }
        if (diffs.length > 4096) { skippedChunks++; console.log(`[play] chunk ${c.cx},${c.cz}: ${diffs.length} cells differ: not the same seed? left alone`); continue; }
        diffs.sort((p, q) => p[1] - q[1]);                                               // bottom up: a block that needs a floor finds it
        for (const [x, y, z, s] of diffs) { const sd = c.st.get(s); if (sd && sd.n) { await S.cmd(`setblock ${x} ${y} ${z} ${stateString(sd)} replace`); restored++; } }
    }
    await S.must(`gamemode survival ${names[0]}`);
    console.log(`[play] restored ${restored} cells in ${chunks.size - skippedChunks} chunks (${skippedChunks} left alone)`);

    // 2. the commands, in recorded order, each from its recorded state
    const all = [];
    for (const r of recs) for (const c of r.cmds) all.push({ bot: r.hello.bot, ...c });
    all.sort((a, b) => a.cmd.ms - b.cmd.ms);
    const count = { played: 0, runLayer: 0, cancelled: 0, forceFailed: 0, same: 0 };
    for (const { bot: name, cmd, res } of all) {
        if (count.played >= MAX) break;
        const move = cmd.layer === 'run' && cmd.name.startsWith('move:') ? cmd.name.slice(5) : null;
        if (cmd.layer !== 'execute' && !move) { count.runLayer++; continue; }
        if (res.reason === 'cancelled') { count.cancelled++; continue; }
        const bot = bots.get(name), b = cmd.before;
        // position and look
        const e = bot.entity.position, [x, y, z] = b.pos;
        if (Math.hypot(e.x - x, e.y - y, e.z - z) > 0.05) {
            const yaw = 180 - (b.yaw * 180) / Math.PI, pitch = -(b.pitch * 180) / Math.PI;
            await S.must(`tp ${name} ${x} ${y} ${z} ${yaw.toFixed(2)} ${pitch.toFixed(2)}`);
            for (let i = 0; i < 40 && bot.entity.position.distanceTo(new Vec3(x, y, z)) > 0.05; i++) await T.sleep(50);
        }
        // the pack
        if (invKey(rowsOf(bot)) !== invKey(b.inv)) {
            await S.cmd(`clear ${name}`);
            for (const row of b.inv) { const sl = slotName(row[0]); if (sl) await S.cmd(`item replace entity ${name} ${sl} with ${itemString(row)} ${row[2]}`); }
            for (let i = 0; i < 40 && invKey(rowsOf(bot)) !== invKey(b.inv); i++) await T.sleep(50);
            if (invKey(rowsOf(bot)) !== invKey(b.inv)) { count.forceFailed++; console.log(`[play] ${name} #${cmd.id}: pack not restored: ${invKey(rowsOf(bot))} vs ${invKey(b.inv)}`); }
        }
        if (Number.isInteger(b.slot) && bot.quickBarSlot !== b.slot) bot.setQuickBarSlot(b.slot);
        await T.sleep(150);                                                             // the server's copy settles (slot packets, the teleport's ack)
        bot.__simrecRef = cmd.id;
        const opts = { atomic: !!cmd.atomic }; if (cmd.maxTicks) opts.maxTicks = cmd.maxTicks;
        let out;
        try { out = move ? await require('../../src/work/bot/moves').runMove(bot, move, cmd.args, cmd.maxTicks ? { maxTicks: cmd.maxTicks } : {}) : await execute(bot, cmd.name, cmd.args, opts); } finally { delete bot.__simrecRef; }
        count.played++;
        if (out.ok === res.ok && (out.ok || out.reason === res.reason)) count.same++;
        if (count.played % 25 === 0) console.log(`[play] ${count.played} played, ${count.same} with the recorded outcome`);
    }
    console.log(`[play] done: ${JSON.stringify(count)}`);
    rep.line?.(`played ${count.played}, same outcome ${count.same}`);
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
