'use strict';
// Shared code of the T26 tests (docs/implemented/TEST-WORLDS-T26.md). Test code. Every result is graded from the SERVER (RCON), never from what the bot says.
// The owner's standard (2026-11-14): three or more worlds in parallel, a new random seed every run, only the prerequisite kit given; a rate of 80 % or below is a failure,
// 90 % is WIP, 100 % is a success (each test names its own required rate). One trial = one bot doing its task once.
const fs = require('fs');
const L = require('../real/lib');

const sleep = L.sleep;
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').replace(/§./g, '');
let CURRENT_DIFFICULTY = null;
const PROFILE = process.env.TW_PROFILE || null;            // the test-world profile (docker/tw/<name>.json): the game version every result is stated with
const WORLD = Number(process.env.T26_WORLD || 0), RUN = process.env.RUN || `r${Date.now().toString(36)}`, CONTROL = process.env.CONTROL || '';

/** Tools: plain diamond (the owner's "full set of tools"); BEST=1 netherite, efficiency 255, unbreakable (strip-mining: "give the best possible tools"). */
function toolItems(best) {
    const ench = best ? '[enchantments={efficiency:255},unbreakable={}]' : '';
    const m = best ? 'netherite' : 'diamond';
    return ['pickaxe', 'axe', 'shovel', 'sword', 'hoe'].map((k) => `minecraft:${m}_${k}${ench} 1`).concat([`minecraft:shears${best ? '[unbreakable={}]' : ''} 1`]);
}

/** The temporary block of the test worlds (owner Small 4, 2026-11-25: every temporary block is a pumpkin, so a leftover is seen at once). run.sh sets TEMP_BLOCK; the bots' choice reads the same variable. */
const TEMP_BLOCK = (process.env.TEMP_BLOCK || 'pumpkin').split(',')[0].trim().replace(/^minecraft:/, '');

/** Give the kit: the pack is emptied first, then tools, `blocks` temporary blocks (TEMP_BLOCK: pumpkins), food. */
async function kit(S, name, { blocks = 64, block = TEMP_BLOCK, best = false, food = 32 } = {}) {
    await S.cmd(`clear ${name}`);
    for (const it of toolItems(best)) await S.must(`give ${name} ${it}`);
    for (let n = blocks; n > 0; n -= 64) await S.must(`give ${name} minecraft:${block} ${Math.min(64, n)}`);
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

/**
 * A test's time limit counted in GAME minutes (TASK-20261125-079, docs/implemented/SPEED-v1.md): on a world ticking k times as fast the limit comes k times sooner in wall time, so a
 * test gives the bots the same game time at every speed. Game time is the server's world age as the bot receives it (update_time, every 20 ticks), so a server that cannot keep its
 * rate does not cut the bots short; `limitMin` wall minutes stay the outer bound (never longer than the standard at 1x). `bot` is a getter (a dead bot is replaced by a new object).
 */
function budget(bot, limitMin) {
    const age = () => { const b = bot(); const a = b && b.time ? Number(b.time.age) : NaN; return Number.isFinite(a) && a > 0 ? a : null; };
    const w0 = Date.now(), a0 = age();
    return {
        over: () => { const a = age(); return Date.now() - w0 >= limitMin * 60000 || (a0 !== null && a !== null && a - a0 >= limitMin * 1200); },
        ticks: () => { const a = age(); return a0 !== null && a !== null ? a - a0 : null; },
    };
}

/** Run a console command on one bot and wait for it (or `limitMin` game minutes, `budget`); returns {result, sec, ticks, timeout}. CONTROL=noop sends nothing (the negative control). */
async function command(svc, name, cmd, args, limitMin) {
    const t0 = Date.now(), rec = svc.bots.get(name), b = budget(() => (svc.bots.get(name) || {}).bot, limitMin);
    if (CONTROL === 'noop') { await sleep(5000); return { result: null, sec: 5, control: true }; }
    const r = await svc.runCommand({ bots: [name], command: cmd, args });
    if (!r.started || !r.started.length) return { result: { ok: false, refused: r }, sec: 0 };
    while (!b.over() && rec.cmd && rec.cmd.status === 'running') await sleep(1000);
    const timeout = !!(rec.cmd && rec.cmd.status === 'running');
    if (timeout) { rec.cmd.cancel.cancelled = true; await sleep(3000); }
    return { result: rec.cmd && rec.cmd.result, sec: Math.round((Date.now() - t0) / 1000), ticks: b.ticks(), timeout };
}

/** The test's report: trials [{bot, ok, detail}], written to /out/<RUN>/<test>-w<WORLD>.json; the suite (suite.js) adds the worlds up. */
function reporter(test) {
    const trials = [], t0 = Date.now(), meta = { test, world: WORLD, run: RUN, control: CONTROL || null, profile: PROFILE, version: process.env.MC_VERSION || null };
    return {
        meta,
        trial(bot, ok, detail) { trials.push({ bot, ok: !!ok, detail }); console.log(`[${test} w${WORLD}] ${ok ? 'PASS' : 'FAIL'} ${bot} ${JSON.stringify(detail).slice(0, 700)}`); },
        write(extra = {}) {
            const dir = `/out/${RUN}`; fs.mkdirSync(dir, { recursive: true });
            const k = trials.filter((t) => t.ok).length;
            fs.writeFileSync(`${dir}/${test}-w${WORLD}${CONTROL ? '-' + CONTROL : ''}.json`, JSON.stringify({ ...meta, difficulty: CURRENT_DIFFICULTY, speed: require('../../src/transport/time_scale').scale, ...extra, sec: Math.round((Date.now() - t0) / 1000), passed: k, trials }, null, 1));
            console.log(`[${test} w${WORLD}] ${k}/${trials.length} trials passed${CONTROL ? ' (CONTROL ' + CONTROL + ')' : ''}`);
            return k;
        },
    };
}

/**
 * Game rule names differ between versions: snake_case on 26.x (keep_inventory), camelCase up to 1.21.x (keepInventory). Every `gamerule` command of the harness goes through here:
 * one the server rejects is sent once more in the other spelling, and the spelling that worked is used from then on. Test code may write either.
 */
function ruleSpellings(shared) {
    if (shared.__rules) return; shared.__rules = new Map();
    const send = shared.command.bind(shared);
    const other = (n) => (n.includes('_') ? n.replace(/_([a-z])/g, (_, c) => c.toUpperCase()) : n.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    const rejected = (o) => /^(Unknown|Incorrect|Expected)|<--\[HERE\]/i.test(strip(o).trim());
    shared.command = async (c) => {
        const m = /^gamerule ([A-Za-z_]+)(.*)$/s.exec(c);
        if (!m) return send(c);
        const known = shared.__rules.get(m[1]);
        if (known) return send(`gamerule ${known}${m[2]}`);
        const out = await send(c);
        if (!rejected(out)) { shared.__rules.set(m[1], m[1]); return out; }
        const out2 = await send(`gamerule ${other(m[1])}${m[2]}`);
        if (!rejected(out2)) shared.__rules.set(m[1], other(m[1]));
        return rejected(out2) ? out : out2;
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
    ruleSpellings(shared);
    const seed = strip(await S.cmd('seed'));
    const diff = process.env.DIFFICULTY || difficulty;
    if (!['peaceful', 'easy', 'normal', 'hard'].includes(diff)) throw new Error(`bad difficulty ${diff}`);
    await S.cmd('gamerule keep_inventory false'); await S.cmd(`difficulty ${diff}`);
    for (const g of ['send_command_feedback', 'log_admin_commands']) await S.cmd(`gamerule ${g} false`).catch(() => {});      // no "[Rcon: ...]" echo of the display's and the harness's commands
    CURRENT_DIFFICULTY = diff; console.log(`[t26] difficulty ${diff}, profile ${PROFILE}, temporary block ${TEMP_BLOCK}`);
    // FALL_GUARD=0: the work service's fall guard off for one run (an A/B of the guard; never evidence of a pass)
    const svc = await L.openService(shared, names, { teleport: 'off', tempBlock: TEMP_BLOCK, ...(process.env.FALL_GUARD === '0' ? { fallGuard: false } : {}), ...settings });
    return { shared, S, svc, seed, difficulty: diff };
}

module.exports = { ...L, sleep, strip, WORLD, RUN, CONTROL, PROFILE, TEMP_BLOCK, ruleSpellings, kit, holds, seesSky, onSurface, countDeaths, countMoves, budget, command, reporter, say, open, toolItems };
