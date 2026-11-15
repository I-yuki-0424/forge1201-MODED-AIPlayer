'use strict';
// Shared code of the T26 tests (docs/implemented/TEST-WORLDS-T26.md). Test code. Every result is graded from the SERVER (RCON), never from what the bot says.
// The owner's standard (2026-11-14): three or more worlds in parallel, a new random seed every run, only the prerequisite kit given; a rate of 80 % or below is a failure,
// 90 % is WIP, 100 % is a success (each test names its own required rate). One trial = one bot doing its task once.
const fs = require('fs');
const L = require('../real/lib');

const sleep = L.sleep;
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/§./g, '');
let CURRENT_DIFFICULTY = null;
const WORLD = Number(process.env.T26_WORLD || 0), RUN = process.env.RUN || `r${Date.now().toString(36)}`, CONTROL = process.env.CONTROL || '';

/** Tools: plain diamond (the owner's "full set of tools"); BEST=1 netherite, efficiency 255, unbreakable (strip-mining: "give the best possible tools"). */
function toolItems(best) {
    const ench = best ? '[enchantments={efficiency:255},unbreakable={}]' : '';
    const m = best ? 'netherite' : 'diamond';
    return ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].map((k) => `minecraft:${m}_${k}${ench} 1`).concat([`minecraft:shears${best ? '[unbreakable={}]' : ''} 1`]);
}

/** Give the kit: the pack is emptied first, then tools, `blocks` cobblestone (temporary blocks), food. */
async function kit(S, name, { blocks = 64, best = false, food = 32 } = {}) {
    await S.cmd(`clear ${name}`);
    for (const it of toolItems(best)) await S.must(`give ${name} ${it}`);
    for (let n = blocks; n > 0; n -= 64) await S.must(`give ${name} minecraft:cobblestone ${Math.min(64, n)}`);
    if (food) await S.must(`give ${name} minecraft:cooked_beef ${food}`);
    await S.cmd(`effect clear ${name}`);
}

/** How many of an item a player holds, read by the server (`clear <name> <item> 0` counts without taking). Item tags (#minecraft:logs) work too. */
async function holds(S, name, item) {
    const o = strip(await S.cmd(`clear ${name} ${item.startsWith('#') ? item : 'minecraft:' + item} 0`));
    const m = /Found (\d+) matching/.exec(o);
    return m ? Number(m[1]) : 0;
}

/** Can the cell (x, y, z) see the sky (the server's own test)? The chunk must be loaded (a bot nearby or forceloaded). */
async function seesSky(S, x, y, z) {
    return /^Test passed/.test(strip(await S.cmd(`execute positioned ${x} ${y} ${z} if predicate {condition:"minecraft:location_check",predicate:{can_see_sky:true}}`)));
}

/** Put a player on the surface near (x, z): the server's own spreadplayers (never on a liquid). Returns the position the server reports. */
async function onSurface(S, name, x, z) {
    await S.cmd(`forceload add ${x} ${z}`);
    const o = strip(await S.cmd(`spreadplayers ${x} ${z} 0 3 false ${name}`));
    await S.cmd(`forceload remove ${x} ${z}`);
    await sleep(1500);
    const p = await L.posOf(S, name);
    return { said: o.slice(0, 120), at: p };
}

/**
 * Deaths per bot, counted by the SERVER (a deathCount scoreboard objective, created at the start). The bot's own death event was not enough: after a death the service may connect a new bot
 * object and the listener was gone (pb-b, 2026-11-15: two deaths in the server log, 0 in the report). The returned object is filled in by `await deaths.read()`; until then it holds the
 * event count as a lower bound.
 */
function countDeaths(svc, names, S = null) {
    const d = Object.fromEntries(names.map((n) => [n, 0]));
    for (const n of names) { const r = svc.bots.get(n); if (r && r.bot) r.bot.on('death', () => { d[n]++; }); }
    if (S) {
        S.cmd('scoreboard objectives add t26deaths deathCount').catch(() => {});
        for (const n of names) S.cmd(`scoreboard players set ${n} t26deaths 0`).catch(() => {});
        Object.defineProperty(d, 'read', { enumerable: false, value: async () => { for (const n of names) { const m = /has (\d+) \[/.exec(strip(await S.cmd(`scoreboard players get ${n} t26deaths`))); if (m) d[n] = Math.max(d[n], Number(m[1])); } return d; } });
    }
    return d;
}

/** Count every server move (a test that the bot did it on its own: teleport stays off, a server move fails the trial). */
function countMoves(svc) {
    const m = {}; const om = svc._moved.bind(svc);
    svc._moved = (n, x) => { m[n] = (m[n] || 0) + 1; return om(n, x); };
    return m;
}

/** Run a console command on one bot and wait for it (or `limitMin`); returns {result, sec, timeout}. CONTROL=noop sends nothing (the negative control). */
async function command(svc, name, cmd, args, limitMin) {
    const t0 = Date.now(), rec = svc.bots.get(name);
    if (CONTROL === 'noop') { await sleep(5000); return { result: null, sec: 5, control: true }; }
    const r = await svc.runCommand({ bots: [name], command: cmd, args });
    if (!r.started || !r.started.length) return { result: { ok: false, refused: r }, sec: 0 };
    while (Date.now() - t0 < limitMin * 60000 && rec.cmd && rec.cmd.status === 'running') await sleep(1000);
    const timeout = !!(rec.cmd && rec.cmd.status === 'running');
    if (timeout) { rec.cmd.cancel.cancelled = true; await sleep(3000); }
    return { result: rec.cmd && rec.cmd.result, sec: Math.round((Date.now() - t0) / 1000), timeout };
}

/** The test's report: trials [{bot, ok, detail}], written to /out/<RUN>/<test>-w<WORLD>.json; the suite (suite.js) adds the worlds up. */
function reporter(test) {
    const trials = [], t0 = Date.now(), meta = { test, world: WORLD, run: RUN, control: CONTROL || null };
    return {
        meta,
        trial(bot, ok, detail) { trials.push({ bot, ok: !!ok, detail }); console.log(`[${test} w${WORLD}] ${ok ? 'PASS' : 'FAIL'} ${bot} ${JSON.stringify(detail).slice(0, 700)}`); },
        write(extra = {}) {
            const dir = `/out/${RUN}`; fs.mkdirSync(dir, { recursive: true });
            const k = trials.filter((t) => t.ok).length;
            fs.writeFileSync(`${dir}/${test}-w${WORLD}${CONTROL ? '-' + CONTROL : ''}.json`, JSON.stringify({ ...meta, difficulty: CURRENT_DIFFICULTY, ...extra, sec: Math.round((Date.now() - t0) / 1000), passed: k, trials }, null, 1));
            console.log(`[${test} w${WORLD}] ${k}/${trials.length} trials passed${CONTROL ? ' (CONTROL ' + CONTROL + ')' : ''}`);
            return k;
        },
    };
}

/** Say something in the game (the owner watching sees what the test does). */
async function say(S, text) { try { await S.cmd(`tellraw @a ${JSON.stringify({ text: `[test] ${text}`, color: 'aqua' })}`); } catch (_) { /* chat is a courtesy */ } }

/**
 * Difficulty (owner 2026-11-16): the movement tests (move_a, move_b) run on Normal, with the night's mobs; every other test runs PEACEFUL, so that a failure cannot be a hostile mob
 * (which the system cannot tell apart from a system fault). `open(names, settings, 'normal')` is how a movement test says so; DIFFICULTY=normal|easy|hard|peaceful overrides for one run.
 */
async function open(names, settings = {}, difficulty = 'peaceful') {
    const { shared, S } = await L.connectRcon();
    const seed = strip(await S.cmd('seed'));
    const diff = process.env.DIFFICULTY || difficulty;
    if (!['peaceful', 'easy', 'normal', 'hard'].includes(diff)) throw new Error(`bad difficulty ${diff}`);
    await S.cmd('gamerule keep_inventory false'); await S.cmd(`difficulty ${diff}`);
    CURRENT_DIFFICULTY = diff; console.log(`[t26] difficulty ${diff}`);
    const svc = await L.openService(shared, names, { teleport: 'off', ...settings });
    return { shared, S, svc, seed, difficulty: diff };
}

module.exports = { ...L, sleep, strip, WORLD, RUN, CONTROL, kit, holds, seesSky, onSurface, countDeaths, countMoves, command, reporter, say, open, toolItems };
