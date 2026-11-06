'use strict';
// Live check of the tools coordination on a REAL Forge server (the demo server, play mod set + aux_console): the tools chest hands out a USABLE tool only,
// worn-out tools are thrown away by exact stack and a good one of the same name stays, the particle commands stop filling the chat, the Tag Tool item exists.
// Grading is the SERVER's state (chest NBT, `clear ... 0` counts), not the bots' reports. Test code.
//   (cd /mnt/data/forgeaip-play/demo && LIVE_SCRIPT=tools_live.js ./live.sh)
const fs = require('fs');
const { Rcon } = require('../../src/rl/rcon');
const { WorkService } = require('../../src/work/service');
const janitor = require('../../src/work/bot/janitor');
const { Overlay } = require('../../src/work/display/overlay');
const { Server, sleep } = require('../skills/bench');

const FLOOR = -61, BX = 2800, BZ = 2800;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`[live] ${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' ' + JSON.stringify(detail).slice(0, 300) : ''}`); };

async function main() {
    const rc = new Rcon({ host: process.env.RCON_HOST || 'demo', port: Number(process.env.RCON_PORT) || 25575, password: process.env.RCON_PASSWORD || '', timeoutMs: 60000 });
    await rc.connect();
    let tail = Promise.resolve();
    const shared = { command(c) { const p = tail.then(() => rc.command(c)); tail = p.catch(() => {}); return p; } };
    const S = new Server(shared, 'x');
    const svc = new WorkService({ dataDir: fs.mkdtempSync('/tmp/tools-live-'), host: process.env.MC_HOST || 'demo', port: Number(process.env.MC_PORT) || 25565, maxBots: 4, reconnectMs: 4000, display: false, rcon: { command: (c) => shared.command(c) } });
    const A = 'ToolA';
    svc.addBot(A);
    const until = async (cond, ms, what) => { const t0 = Date.now(); while (!(await cond())) { if (Date.now() - t0 > ms) throw new Error(`timeout: ${what}`); await sleep(250); } };
    await until(() => svc.status().bots.every((b) => b.state === 'online'), 120000, 'bot online'); await sleep(2500);
    const bot = svc.bots.get(A).bot;
    await S.must(`gamemode survival ${A}`); await S.must(`clear ${A}`); await S.must('time set day');
    await S.must(`forceload add ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`);
    const top = FLOOR + 4, y = top + 1;
    await S.must(`fill ${BX - 2} ${FLOOR + 1} ${BZ - 2} ${BX + 24} ${top} ${BZ + 24} minecraft:stone`);
    await S.must(`fill ${BX - 2} ${top + 1} ${BZ - 2} ${BX + 24} ${top + 8} ${BZ + 24} minecraft:air`); await sleep(1500);
    const held = async (spec) => { const o = await S.cmd(`clear ${A} ${spec} 0`); const m = /(\d+)/.exec(o.replace(/\x1b\[[0-9;]*m/g, '')); return /No items were found/i.test(o) ? 0 : m ? Number(m[1]) : -1; };
    const chestHas = async (spec) => { const o = await S.cmd(`execute if data block ${BX + 4} ${y} ${BZ + 4} Items[{id:"minecraft:${spec}"}]`); return /passed/i.test(o); };

    // ---- the tools chest: two worn pickaxes (iron 10 uses left, diamond 3), a good iron one (230), a stone one (121)
    await S.must(`setblock ${BX + 4} ${y} ${BZ + 4} minecraft:chest`);
    await S.must(`item replace block ${BX + 4} ${y} ${BZ + 4} container.0 with minecraft:iron_pickaxe{Damage:240}`);
    await S.must(`item replace block ${BX + 4} ${y} ${BZ + 4} container.1 with minecraft:diamond_pickaxe{Damage:1558}`);
    await S.must(`item replace block ${BX + 4} ${y} ${BZ + 4} container.2 with minecraft:iron_pickaxe{Damage:20}`);
    await S.must(`item replace block ${BX + 4} ${y} ${BZ + 4} container.3 with minecraft:stone_pickaxe{Damage:10}`);
    await S.must(`tp ${A} ${BX + 4.5} ${y} ${BZ + 1.5}`); await sleep(1500);
    svc.addSite({ name: 'tools-chest', x: BX + 4, y, z: BZ + 4, tags: ['tools'] });
    svc.setSettings({ retireWorn: true });
    const r = await svc.runScript(A, 'replace-tool');
    check('replace-tool took a pickaxe from the tools chest', r.ok, { ended: r.ended, log: r.log });
    await sleep(500);
    check('it is the good iron pickaxe (230 uses left): tier first among the usable ones', (await held('minecraft:iron_pickaxe{Damage:20}')) === 1 && (await held('minecraft:stone_pickaxe')) === 0 && (await held('minecraft:diamond_pickaxe')) === 0, { good: await held('minecraft:iron_pickaxe{Damage:20}') });
    check('the worn ones stayed in the chest (worn diamond, worn iron)', (await chestHas('diamond_pickaxe')) && (await chestHas('iron_pickaxe')) && (await chestHas('stone_pickaxe')));
    // only worn ones left in a chest: nothing is taken, the script says why
    await S.must(`clear ${A}`); await S.must(`setblock ${BX + 4} ${y} ${BZ + 4} minecraft:air`); await S.must(`setblock ${BX + 4} ${y} ${BZ + 4} minecraft:chest`);
    await S.must(`item replace block ${BX + 4} ${y} ${BZ + 4} container.0 with minecraft:iron_pickaxe{Damage:243}`); await S.must(`item replace block ${BX + 4} ${y} ${BZ + 4} container.1 with minecraft:iron_pickaxe{Damage:245}`);
    const r2 = await svc.runScript(A, 'replace-tool');
    check('a chest with only worn pickaxes gives nothing and the bot has none', !r2.ok && (await held('minecraft:iron_pickaxe')) === 0 && r2.log.some((l) => /no usable pickaxe in the tools chest \(2 worn out\)/.test(l)), { ended: r2.ended, log: r2.log.slice(0, 3) });

    // ---- use up: worn pickaxes in the pack are thrown away by their wear, the good one stays
    await S.must(`clear ${A}`);
    await S.must(`give ${A} minecraft:iron_pickaxe{Damage:20} 1`); await S.must(`give ${A} minecraft:iron_pickaxe{Damage:243} 1`); await S.must(`give ${A} minecraft:iron_pickaxe{Damage:236} 1`); await S.must(`give ${A} minecraft:diamond_pickaxe{Damage:1560} 1`); await sleep(1500);
    const cancel = { cancelled: false }, env = svc.envFactory(bot, cancel, { worker: true }); env.configure({ retireWorn: true });
    const inv0 = env.inv();
    check('the bot sees three worn stacks of four', inv0.worn.length === 3, inv0.worn);
    const m = await janitor.maintain(env, svc._pitPolicy(null)); await sleep(1000);
    check('maintain discarded exactly the worn stacks on the server', m.ok && m.done.length === 3 && (await held('minecraft:iron_pickaxe{Damage:243}')) === 0 && (await held('minecraft:iron_pickaxe{Damage:236}')) === 0 && (await held('minecraft:diamond_pickaxe')) === 0, { done: m.done.map((o) => [o.item, o.damage]) });
    check('the good pickaxe of the same name stayed', (await held('minecraft:iron_pickaxe{Damage:20}')) === 1);
    check('and no item entity was made', !/count: [1-9]/.test(await S.cmd('execute if entity @e[type=minecraft:item]')));

    // ---- chat: the two game rules are set by the overlay's first frame; the Tag Tool item is in the game
    const o = new Overlay({ rcon: (c) => shared.command(c), pending: () => 0, config: () => ({ on: true }), state: () => ({ bots: [], lanes: [], tags: [{ name: 'c', x: BX + 4, y, z: BZ + 4, machine: false, end: null }] }), humans: async () => [{ name: A, x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }], budget: 40 });
    const n = await o.frame();
    check('a frame is drawn and the server commands stay out of the chat (rules off)', n > 4 && /false/.test(await S.cmd('gamerule sendCommandFeedback')) && /false/.test(await S.cmd('gamerule logAdminCommands')), { sent: n });
    await S.must(`give ${A} aipconsole:tag_tool 1`); await sleep(500);
    check('the Tag Tool item exists on the server', (await held('aipconsole:tag_tool')) === 1);

    await svc.stop(); await S.must(`forceload remove ${BX - 16} ${BZ - 16} ${BX + 32} ${BZ + 32}`).catch(() => {});
    const failed = results.filter((x) => !x.ok);
    console.log(`\n[live] ${results.length - failed.length}/${results.length} pass`);
    if (process.env.LIVE_OUT) fs.writeFileSync(process.env.LIVE_OUT, JSON.stringify(results, null, 1));
    process.exit(failed.length ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
