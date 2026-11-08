'use strict';
// Live check of a journey through a portal on a REAL Forge server (the demo server): two tagged gates (overworld and a prebuilt one in the Nether), the operator's
// `journey` to a target in the Nether and back. Grading is the server's state (the bot's Dimension and Pos), not the bot's report. Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=portal_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const { Server, sleep } = require('../skills/bench');

const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };
const clean = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/portal-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: shared });
    const A = 'PrtA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    await S.must(`gamemode survival ${A}`); await S.must('time set day'); await S.must('difficulty peaceful'); await S.must(`effect give ${A} minecraft:resistance 999 4 true`);
    const BX = 3000, BZ = 3000, FLOOR = -61, top = FLOOR + 4, y = top + 1;
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    await S.must(`fill ${BX - 2} ${FLOOR + 1} ${BZ - 8} ${BX + 24} ${top} ${BZ + 24} minecraft:stone`);
    await S.must(`fill ${BX - 2} ${top + 1} ${BZ - 8} ${BX + 24} ${top + 8} ${BZ + 24} minecraft:air`);
    // overworld gate: frame x BX..BX+3, interior BX+1..BX+2, y .. y+2, axis x (the bot comes from the south, z larger)
    await S.must(`fill ${BX} ${y - 1} ${BZ} ${BX + 3} ${y + 3} ${BZ} minecraft:obsidian`);
    await S.must(`fill ${BX + 1} ${y} ${BZ} ${BX + 2} ${y + 2} ${BZ} minecraft:nether_portal[axis=x]`);
    // Nether gate prebuilt where the overworld portal leads: x/8, z/8
    const NX = Math.floor((BX + 1) / 8), NZ = Math.floor(BZ / 8), NY = 70, nether = (c) => `execute in minecraft:the_nether run ${c}`;
    await S.must(nether(`forceload add ${NX - 20} ${NZ - 20} ${NX + 20} ${NZ + 20}`)); await sleep(3000);
    await S.must(nether(`fill ${NX - 8} ${NY - 1} ${NZ - 8} ${NX + 8} ${NY - 1} ${NZ + 8} minecraft:netherrack`));
    await S.must(nether(`fill ${NX - 8} ${NY} ${NZ - 8} ${NX + 8} ${NY + 8} ${NZ + 8} minecraft:air`));
    await S.must(nether(`fill ${NX} ${NY - 1} ${NZ} ${NX + 3} ${NY + 3} ${NZ} minecraft:obsidian`));
    await S.must(nether(`fill ${NX + 1} ${NY} ${NZ} ${NX + 2} ${NY + 2} ${NZ} minecraft:nether_portal[axis=x]`));
    svc.addSite({ name: 'ow-gate', x: BX + 1, y, z: BZ, purpose: 'portal', dim: 'overworld' });
    svc.addSite({ name: 'ne-gate', x: NX + 1, y: NY, z: NZ, purpose: 'portal', dim: 'nether', twin: 'ow-gate' });
    svc.addSite({ name: 'ow-gate', x: BX + 1, y, z: BZ, purpose: 'portal', dim: 'overworld', twin: 'ne-gate' });
    const dimOf = async () => /the_nether/.test(clean(await S.cmd(`data get entity ${A} Dimension`))) ? 'nether' : 'overworld';
    const pos = async () => { const m = /\[(-?[\d.]+)d, (-?[\d.]+)d, (-?[\d.]+)d\]/.exec(clean(await S.cmd(`data get entity ${A} Pos`))); return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null; };
    await S.must(`tp ${A} ${BX + 8} ${y} ${BZ + 12}`); await sleep(2000);
    check('the bot starts in the overworld', (await dimOf()) === 'overworld');
    const run = async (args) => { const r = await svc.runCommand({ bots: [A], command: 'journey', args }); if (!r.started.length) return { refused: r.refused }; await until(() => { const c = svc.bots.get(A).cmd; return c && c.status !== 'running'; }, 240000, 'journey ends'); return svc.bots.get(A).cmd; };
    const plan = await svc.runCommand({ bots: [A], command: 'journey', args: { x: 0, z: 0, dim: 'end' } });
    await sleep(1500); const c0 = svc.bots.get(A).cmd;
    check('no gate leads to the end: the journey says so', c0 && c0.status === 'failed' && /no tagged portal/.test(JSON.stringify(c0.result)), c0 && c0.result);
    const c1 = await run({ x: NX + 6, y: NY, z: NZ + 6, dim: 'nether' });
    const p1 = await pos();
    check('journey to a target in the Nether went through the gate (server: bot is in the Nether next to it)', c1.status === 'ok' && (await dimOf()) === 'nether' && p1 && Math.hypot(p1.x - (NX + 6), p1.z - (NZ + 6)) <= 4, { status: c1.status, result: c1.result, pos: p1 });
    const c2 = await run({ x: BX + 8, y, z: BZ + 12, dim: 'overworld' });
    const p2 = await pos();
    check('and back to the overworld through the same pair', c2.status === 'ok' && (await dimOf()) === 'overworld' && p2 && Math.hypot(p2.x - (BX + 8), p2.z - (BZ + 12)) <= 4, { status: c2.status, result: c2.result, pos: p2 });
    await svc.stop();
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
