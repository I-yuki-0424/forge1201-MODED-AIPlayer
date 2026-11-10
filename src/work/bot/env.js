'use strict';
// The environment of a real Mineflayer bot for the worker (worker.js) and the jobs: the action layer's `execute`, the recovery ladder
// (jump, sidestep, back to the last good place), defence (guard.js), discard, tools, the inventory. Everything a job may ask of a bot is here;
// the loop that claims units and retries is worker.js.
const janitor = require('./janitor');
const dimensions = require('../world/dimensions');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The environment of a real Mineflayer bot on the action layer. */
function botEnv(bot, { cancel = { cancelled: false }, rcon = null, avoid = null, others = null, guard: withGuard = false, defend = true, moved = null, teleport = () => 'near', gates = null, stockMiss = null, experts = null, expertLog = null } = {}) {
    const { execute } = require('../../skills');
    const { fromBot } = require('../../skills/world');
    const { feetCell } = require('../../skills/motion');
    const w = fromBot(bot);
    let good = null;                                             // the feet cell where the bot last finished a unit: a place it can stand and work
    const hold = async (key, ms) => { bot.setControlState(key, true); await sleep(ms); bot.setControlState(key, false); };
    /**
     * One basic fix per call, then the caller waits. The first failure in a place gets the gentlest (level 2 jump, 3 step aside, 4 back to the last good place);
     * the same failure in the same place again gets a different one (escape.js: step back, a pause, a server lift ...), not the same fix over and over.
     */
    const escapes = new Map();
    // Where the recovery time goes (owner 2026-11-10: "it often feels extremely slow, a lot of retries and timeouts before it finally moves"): the fix in progress is told to the worker as a
    // stretch inside `recover` (env.sub), so that the health row says how long each kind took (fix:jump, fix:wait, fix:lift, fix:back ...). Measured in the live pit before this: recover
    // took 20-40 % of all bot time (229-514 s of 1200 per minute), the trained experts only about 4 %; the rest was walks back to the last good place, which ran to the command's 60 s limit.
    const fixSub = (n) => { if (envObj && envObj.sub) envObj.sub(n); };
    async function recover(level, failure) { try { return await recoverFix(level, failure); } finally { fixSub(null); } }
    async function recoverFix(level, failure) {
        if (cancel && cancel.cancelled) return;
        const esc = require('./escape'), f = feetCell(bot.entity.position);
        const { fix, h } = esc.pick(escapes, level, failure, f); fixSub(`fix:${fix}`);
        const stepTo = async (dx, dz, ms) => { await bot.look(Math.atan2(-dx, -dz), 0, true); await hold('forward', ms); };
        const roomAt = (dx, dz) => { const k = (y) => w.kindAt(f.x + dx, f.y + y, f.z + dz); return k(0) === 'air' && k(1) === 'air' && k(-1) === 'solid'; };   // free feet and head cell, solid floor
        const sidestep = async (ms) => {
            for (let i = 0; i < 4; i++) { const [dx, dz] = esc.freshDirection(h); if (roomAt(dx, dz)) { await stepTo(dx, dz, ms); return true; } }
            return false;
        };
        if (fix === 'jump') { await hold('jump', 350); await sleep(250); await hold('jump', 350); return; }
        if (fix === 'sidestep') { if (!await sidestep(350)) await hold('jump', 350); return; }
        if (fix === 'back_off') { if (!await sidestep(800)) await hold('jump', 350); return; }          // two cells away: the next approach comes from another side
        if (fix === 'wait') { await sleep(1500 + Math.floor(Math.random() * 2000)); return; }          // something in the way moves on, the server catches up
        if (fix === 'lift') {
            if (rcon && envObj.lift) { const l = await envObj.lift(f, { radius: 4, up: 2, down: 1, purpose: 'recover', why: `escape after ${(failure && failure.reason) || 'a failed move'}` }); if (l.ok) return; }
            if (!await sidestep(800)) await hold('jump', 350);
            return;
        }
        if (good) {
            const here = feetCell(bot.entity.position);
            const dist = Math.abs(here.x - good.x) + Math.abs(here.z - good.z) + Math.abs(here.y - good.y);
            // Far (three levels or more, or 24 blocks): not on foot. From the surface the planner walked 30 levels down into the pit and a bot fell 86 blocks (live pit 2026-11-07).
            if (dist > 2 && expertsOn() && dist <= EXPERT_RETURN && (!rcon || Math.abs(here.y - good.y) >= 3 || Math.hypot(here.x - good.x, here.z - good.z) > 24)) {
                // far or on another level: the planner walked into pits from here (live pit 2026-11-07), a server move looks like teleporting: the expert goes back, digging if it must
                const e = await envObj.expertMove(good, { why: `back to the last good place after ${(failure && failure.reason) || 'a failed move'}`, escape: Math.abs(here.y - good.y) >= 3, maxMs: 25000 });
                if (e.ok) return;
            }
            if (dist > 2 && rcon && (Math.abs(here.y - good.y) >= 3 || Math.hypot(here.x - good.x, here.z - good.z) > 24)) await envObj.back(good, { purpose: 'recover', why: `back to the last good place after ${(failure && failure.reason) || 'a failed move'}` });
            else if (dist > 2) { fixSub('fix:walk_back'); await execute(bot, 'move_to', { x: good.x, y: good.y, z: good.z }, { cancel, maxTicks: BACK_TICKS }); }       // a walk back that has not arrived in 15 s is not going to: the next fix is another one
        }
    }
    const { items: dropsNear } = require('./drops');
    // Defence (guard.js): while `defend` is on, a command that runs when the bot is attacked is stopped (reason `cancelled`) and the worker fights first.
    let defendOn = !!defend;
    const gd = withGuard ? require('./guard').attach(bot, { cancel }) : null;
    // A unit is interrupted when the operator cancels, when the bot is attacked (guard), or when it is under water with its air running out (below 9 of 20): the
    // worker then runs the water rescue before the next unit (the live pit drowned two bots mid-dig: the water check only ran between units).
    const drowning = () => { const o = bot.oxygenLevel; return typeof o === 'number' && o < 9 && (!!bot.entity.isInWater || require('./water').inWater(w, feetCell(bot.entity.position))); };
    // The first reason a unit was stopped is kept (takeCancelCause) so that a `cancelled` result says why: 17 cancelled units cost more bot time than 27 finished ones in one live window and nothing said which of the three it was.
    let stopCause = null;
    const causeNow = () => cancel.cancelled ? 'operator' : (gd && defendOn && gd.interrupt.cancelled) ? 'attacked' : drowning() ? 'drowning' : null;
    const unitCancel = { get cancelled() { const c = causeNow(); if (c && !stopCause) stopCause = c; return !!c; } };
    /** A cell with air for the body and solid below, and no drop of more than three beside it (no ledge, tree top or pillar edge to walk off: two bots fell to their death after a lift). */
    const safeStand = (x, y, z) => {
        if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') return false;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            if (w.kindAt(x + dx, y, z + dz) === 'water' || w.kindAt(x + dx, y, z + dz) === 'liquid' || w.kindAt(x + dx, y, z + dz) === 'danger') return false;
            if (![1, 2, 3].some((k) => w.kindAt(x + dx, y - k, z + dz) === 'solid')) return false;
        }
        return true;
    };
    // A standing cell the bot can walk out of: a neighbour on the same level, one step up (with room overhead) or one step down. A one-cell pocket by a chest was
    // chosen as 'nearest standable' and held two bots for good (live pit 2026-11-07).
    const walkable = (x, y, z) => w.kindAt(x, y, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid';
    const hasExit = (x, y, z) => [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => walkable(x + dx, y, z + dz) || (walkable(x + dx, y + 1, z + dz) && w.kindAt(x, y + 2, z) === 'air') || walkable(x + dx, y - 1, z + dz)) ? 1 : 0;
    /** Can this item harvest that block (registry harvestTools)? True when nothing is asked or the block needs no tool. */
    const canHarvest = (itemName, block) => {
        if (!block) return true;
        const reg = bot.registry, b = reg && reg.blocksByName[String(block).replace(/^minecraft:/, '')], it = reg && reg.itemsByName[itemName];
        return !b || !b.harvestTools || (!!it && !!b.harvestTools[it.id]);
    };
    const have = (item) => bot.inventory.items().reduce((n, i) => n + (i.name === item ? i.count : 0), 0);
    const disc = require('./discard');
    const feet = () => feetCell(bot.entity.position);
    // A line for every container (queue.js; owner 2026-11-09: a crowd at one chest, one bot that cannot finish holds all the others). A bot takes its turn before it walks to the
    // chest (approach: `reserve`) or, failing that, before the command that uses it; the front place runs out after a minute (the command is cancelled), a bot that fails there is
    // sent a few blocks away, and the next one is served. Without `gates` (tests, one-off commands) nothing changes.
    const held = new Map();                                      // "box:x,y,z" -> the ticket `reserve` took, used by the next command on that container
    const boxKey = (c) => `box:${c.x},${c.y},${c.z}`;
    const isCell = (a) => !!a && Number.isInteger(a.x) && Number.isInteger(a.y) && Number.isInteger(a.z);
    const SENT_AWAY = new Set(['timeout', 'stuck', 'unreachable', 'not_confirmed', 'not_visible']);
    const lineFail = (e, key) => ({ ok: false, reason: e && e.reason === 'cancelled' ? 'cancelled' : 'timeout', detail: { stage: 'queue', key, why: String((e && e.message) || e).slice(0, 120) } });
    // A short stretch inside whatever the bot is doing (waiting in a line, a server lift, a chest window) is told to the worker (env.sub) so that the health row can say how long it took;
    // when it ends the bot is back in its activity (a unit keeps its phase).
    const around = async (n, fn) => { if (envObj.sub) envObj.sub(n); try { return await fn(); } finally { if (envObj.sub) envObj.sub(null); } };
    const enter = (cell, base, o = {}) => around('line', async () => { try { return { t: await gates.enter(boxKey(cell), bot.username, { cancel: base, ...o }) }; } catch (e) { return { fail: lineFail(e, boxKey(cell)) }; } });
    /** A few blocks away from a cell (not into the way of the next bot): the standable cell 5 to 9 blocks off that is nearest to where the bot stands. */
    const sendAway = async (cell) => {
        const f = feet(), c = [];
        for (let dx = -9; dx <= 9; dx++) for (let dz = -9; dz <= 9; dz++) {
            const d = Math.hypot(dx, dz); if (d < 5 || d > 9) continue;
            for (const dy of [0, 1, -1]) { const x = cell.x + dx, y = f.y + dy, z = cell.z + dz; if (w.kindAt(x, y, z) === 'air' && w.kindAt(x, y + 1, z) === 'air' && w.kindAt(x, y - 1, z) === 'solid') { c.push({ x, y, z, d: Math.hypot(x - f.x, z - f.z) + Math.abs(y - f.y) }); break; } }
        }
        c.sort((a, b) => a.d - b.d);
        for (const t of c.slice(0, 2)) { const m = await Promise.race([execute(bot, 'move_to', { x: t.x, y: t.y, z: t.z }, { cancel, maxTicks: 240 }), sleep(9000).then(() => ({ ok: false }))]); if (m.ok) return { ok: true, to: t }; }
        return { ok: false, reason: 'unreachable' };
    };
    // A visit: ONE turn for all the commands a bot runs on a container in a row (every item kind of a deposit). Before, each deposit command queued again behind the whole crowd:
    // a bot with ten kinds of items stood in the line ten times, and 13-16 of 20 bots waited at the Ender chest while three used it (live 2026-11-09, 'deposit does nothing').
    const visits = new Map();                                    // "box:x,y,z" -> the ticket of the visit in progress
    const queued = async (cell, base, call) => {
        if (!gates || !isCell(cell)) return call(base);
        const k = boxKey(cell), open = visits.get(k);
        if (open && !open.left && !open.evicted) { if (open.renew) open.renew(); return call({ get cancelled() { return base.cancelled || open.evicted; } }); }
        let t = held.get(k); held.delete(k);
        if (!t || t.left || t.evicted) { const e = await enter(cell, base); if (e.fail) return e.fail; t = e.t; }
        const c = { get cancelled() { return base.cancelled || t.evicted; } };
        let r;
        try { r = await around('chest', () => call(c)); } finally { t.leave(); }
        if (t.evicted && !r.ok && !base.cancelled) r = { ...r, ok: false, reason: 'timeout', detail: { ...(r.detail || {}), stage: 'queue', why: 'held the line longer than its time limit: next bot' } };
        if (!r.ok && (t.evicted || SENT_AWAY.has(r.reason)) && !base.cancelled) { try { await sendAway(cell); } catch (_) { /* leaving the spot is a courtesy */ } }
        return r;
    };
    /** Run `fn` (commands on the container at `cell`) under one turn of its line. Returns fn's result, or the failure when no turn came ({ok:false, reason, detail}). Without lines: just fn. */
    const visit = async (cell, fn) => {
        if (!gates || !isCell(cell) || visits.has(boxKey(cell))) return fn();
        const k = boxKey(cell); let t = held.get(k); held.delete(k);
        if (!t || t.left || t.evicted) { const e = await enter(cell, cancel); if (e.fail) return e.fail; t = e.t; }
        visits.set(k, t);
        try { return await around('chest', fn); } finally { visits.delete(k); t.leave(); }
    };
    // The trained RL experts (src/experts, docs/implemented/EXPERTS-v1.md): the movement expert walks where the planner finds no way, the stuck-escape expert digs and climbs out of a hole;
    // both run on the action layer's own commands (with this bot's cancel, fixtures and tool rules). Setting `experts` (default on). Every use is reported to `expertLog`.
    const expertsOn = () => !!experts && experts() !== false;
    // How far the experts are asked to go (measured in the live pit, 2026-11-09, 20 bots: 72 uses in 25 minutes; the 12 that were sent 50-140 blocks or 30-60 levels timed out after a minute
    // each and the server moved the bot anyway, while the short ones took 6-15 s): a recovery goes on foot when the place is within 24 blocks (|dx|+|dy|+|dz|), a lift within 16.
    const EXPERT_RETURN = 24, EXPERT_LIFT = 16;
    // The experts are a way out, not a way to spend a minute: a recovery gives them 25 s (was 45 / 30: the failures took 42 s on average, the successes 1-23 s), and a bot whose expert failed twice in
    // five minutes goes without one for three minutes (the same place, the same failure, the same minute lost again).
    const EXPERT_FAILS = [], expertBlocked = () => Date.now() < expertOffUntil; let expertOffUntil = 0;
    const BACK_TICKS = 300;
    const useExpert = async (name, target, o = {}) => {
        if (!expertsOn()) return { ok: false, reason: 'refused', detail: { why: 'the experts are off (setting experts)' } };
        if (expertBlocked()) return { ok: false, reason: 'refused', detail: { why: 'this bot\'s expert failed twice a moment ago: the other fixes first', blockedFor: Math.round((expertOffUntil - Date.now()) / 1000) } };
        const t0 = Date.now(), from = feetCell(bot.entity.position);
        let r;
        try { r = await require('../../experts').drive(bot, name, target, { exec: (n, a) => execute(bot, n, a, { cancel: unitCancel }), cancel: unitCancel, maxMs: o.maxMs || 90000, maxSteps: o.maxSteps }); }
        catch (e) { r = { ok: false, reason: 'internal', steps: 0, detail: { message: String((e && e.message) || e).slice(0, 120) } }; }
        const out = { ok: !!r.ok, reason: r.ok ? undefined : r.reason, detail: { expert: name, steps: r.steps, from, to: feetCell(bot.entity.position), target, remaining: r.dist !== undefined ? Math.round(r.dist * 10) / 10 : undefined, ms: Date.now() - t0, why: o.why } };
        if (!out.ok && ['timeout', 'stuck'].includes(out.reason)) { const t = Date.now(); EXPERT_FAILS.push(t); while (EXPERT_FAILS.length && t - EXPERT_FAILS[0] > 300000) EXPERT_FAILS.shift(); if (EXPERT_FAILS.length >= 2) { expertOffUntil = t + 180000; EXPERT_FAILS.length = 0; } }
        else if (out.ok && out.detail.steps) EXPERT_FAILS.length = 0;
        if (expertLog) { try { expertLog({ expert: name, ok: out.ok, reason: out.reason, steps: r.steps, from, to: out.detail.to, target, ms: out.detail.ms, why: o.why || '' }); } catch (_) { /* reporting must not break the move */ } }
        return out;
    };
    /** The cell a recovery move would go to: standable, a way out first, no edge or fluid beside it, then the nearest (the same ranking as `lift`). null when there is none. */
    const pickCell = (S, { radius = 5, down = 0, up = 2 } = {}) => {
        const oth = others ? others() : [], cand = [];
        for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let y = S.y - down; y <= S.y + up; y++) {
            const x = S.x + dx, z = S.z + dz;
            if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
            if (oth.some((o) => Math.hypot(o.x - (x + 0.5), o.z - (z + 0.5)) < 1.3)) continue;
            cand.push({ x, y, z, safe: safeStand(x, y, z), exit: hasExit(x, y, z), d: Math.hypot(dx, dz) + Math.abs(y - S.y) });
        }
        cand.sort((a, b) => (b.exit - a.exit) || (b.safe - a.safe) || (a.d - b.d));
        return cand[0] || null;
    };
    const CHEST_OPS = new Set(['deposit', 'withdraw']), CHEST_MOVES = new Set(['take_usable', 'stash_worn', 'deposit_many']);
    const envObj = {
        w, bot, now: Date.now, cancelled: () => !!cancel.cancelled, recover, stockMiss, act: null, sub: null,
        temps: bot.__temps || null,                                   // the registry of blocks the bots placed, shared by every bot (temps.js)
        temp: bot.__temps ? bot.__temps.view(bot) : new Map(),        // this bot's view of it: what it placed or what stands within 10 blocks and is cleaned by whoever passes
        stations: bot.__stations || (bot.__stations = {}),           // crafting table / furnace the bot placed and has not taken back: reused by the next script run (script.js)
        discard: disc.makeClear({ rcon, name: bot.username, count: have }),
        dumpSpot: avoid ? () => disc.dumpSpot(w, feet(), { avoid: avoid(), others: others ? others() : [] }) : null,
        threat: gd ? () => (bot.__preempt ? { reflex: true } : defendOn ? gd.threat() : null) : null,
        // A reflex that has the body (a fall, lava) finishes first; then the fight, if there is one; then the worker runs the stopped unit again.
        defend: gd ? async () => { for (let i = 0; i < 100 && bot.__preempt; i++) await sleep(100); return gd.defend((name, args) => execute(bot, name, args, { cancel })); } : null,
        dispose: () => { if (gd) gd.detach(); }, rememberGood: () => { good = feetCell(bot.entity.position); escapes.clear(); },
        inWater: () => !!bot.entity.isInWater || require('./water').inWater(w, feetCell(bot.entity.position)),
        items: (near, r) => dropsNear(bot, near, r),
        configure: (o) => { if (o && typeof o.defend === 'boolean') defendOn = o.defend; return require('../../skills/options').configure(bot, o); },
        // `within`: the box of the pit job the bot works in (set by the service): a pillar with nothing to stack takes a block from the undug part of it (moves.js harvestBlock).
        within: null,
        run: (name, args) => (CHEST_MOVES.has(name)
            ? queued(args, cancel, (c) => require('./moves').runMove(bot, name, args, { cancel: c }))
            : require('./moves').runMove(bot, name, (name === 'pillar' || name === 'harvest') && envObj.within && !args.within ? { ...args, within: envObj.within } : args, { cancel })),
        // Take a turn at a container before walking to it (reach.js approach); null = go on, else the failure. `release` gives the turn back when the walk failed.
        reserve: async (cell) => {
            if (!gates || !isCell(cell) || held.has(boxKey(cell))) return null;
            const e = await enter(cell, cancel, { holdMs: Math.round(gates.o.holdMs * 1.5) }); if (e.fail) return e.fail;
            held.set(boxKey(cell), e.t);
            const tm = setTimeout(() => { if (held.get(boxKey(cell)) === e.t) { held.delete(boxKey(cell)); e.t.leave(); } }, 45000); if (tm.unref) tm.unref();       // never used: do not hold the line
            return null;
        },
        release: (cell) => { if (!isCell(cell)) return; const t = held.get(boxKey(cell)); if (t) { held.delete(boxKey(cell)); t.leave(); } },
        sendAway, visit,
        // The last place that worked, or where it stands: the server puts the bot back on its feet instead of leaving it stopped where it cannot go on (owner 2026-11-09: they are moved
        // by the server when stuck anyway; "teleport back instead of staying stopped for good"). A 'job' move: always allowed, whatever the recovery setting says.
        goBack: async (why = 'sent back') => {
            if (!rcon) return { ok: false, reason: 'refused', detail: { why: 'no RCON' } };
            const here = feet();
            if (good && (Math.abs(here.x - good.x) + Math.abs(here.z - good.z) + Math.abs(here.y - good.y)) > 2) return envObj.back(good, { purpose: 'job', why });
            return envObj.lift(here, { radius: 8, up: 2, down: 2, purpose: 'job', why });
        },
        climb: (t) => require('./moves').climbTo(envObj, t),
        /** The movement expert (or, from inside a hole, the stuck-escape expert: `escape`) takes the bot to the cell `target`. {ok, reason, detail} like a command. */
        expertMove: (target, o = {}) => useExpert(o.escape ? 'unstick' : 'move', target, o),
        /** The stuck-escape expert: out of a shaft, pit or sealed pocket, to `target` or, when none is given, the open ground around. */
        expertEscape: (target = null, o = {}) => {
            const g = target || require('../../experts/ground').groundAbove(w, feetCell(bot.entity.position));
            if (!g) return Promise.resolve({ ok: false, reason: 'unreachable', detail: { why: 'no open ground found in the loaded chunks around the bot' } });
            return useExpert('unstick', { x: g.x, y: g.y, z: g.z }, { why: o.why || 'stuck', ...o });
        },
        expertsOn,
        dimension: () => { const d = (bot.game && bot.game.dimension) || 'overworld'; return dimensions.canon(d) || String(d); },
        // The limits of the dimension the bot is in (world/dimensions.js; an unknown one takes what the login packet said), and work over an abyss (bridge.js: a bridge out, the job, the walk back).
        profile: () => dimensions.profile(envObj.dimension(), bot.game ? { minY: bot.game.minY, height: bot.game.height } : null),
        workOver: (work, opt = {}) => require('./bridge').workOver(envObj, work, { minY: envObj.profile().minY, ...opt }),
        // Face a cell and press forward until `until()` is true or `ms` is up (a portal is entered by walking into it); `ahead`: keep the heading the bot has.
        walkInto: async (cell, { until, ms = 8000 } = {}) => {
            const t0 = Date.now();
            try {
                while (!(cancel && cancel.cancelled) && Date.now() - t0 < ms) {
                    if (until && until()) return true;
                    if (!cell.ahead) { const p = bot.entity.position; await bot.look(Math.atan2(-(cell.x + 0.5 - p.x), -(cell.z + 0.5 - p.z)), 0, true); }
                    bot.setControlState('forward', true); await sleep(100);
                }
                return !!(until && until());
            } finally { bot.setControlState('forward', false); }
        },
        cross: (gate, o) => require('./portal').cross(envObj, gate, o),
        // A long walk in legs inside the loaded chunks (travel.js): a move_to beyond the view distance fails for want of chunks.
        travel: async (t, o) => {
            const tr = require('./travel'), run = () => tr.travel({ exec: envObj.exec, here: envObj.here, w, cancel: unitCancel }, t, o);
            let r = await run();
            if (r.ok || !expertsOn() || !['unreachable', 'stuck', 'timeout', 'not_visible'].includes(r.reason)) return r;
            // No leg of any length could be walked: the movement expert takes the bot toward the target inside the loaded chunks (round what the planner cannot, through what it must dig), then the legs go on.
            const here = feetCell(bot.entity.position), aim = tr.legCandidates(w, here, t)[0];
            if (!aim) return r;
            const e = await envObj.expertMove({ x: aim.x, y: aim.y, z: aim.z }, { why: `no way on foot toward ${t.x} ${t.z} (${r.reason})`, maxMs: 60000 });
            if (!e.ok) return { ...r, detail: { ...(r.detail || {}), expert: e.reason } };
            r = await run();
            return r.ok ? { ...r, expert: true } : r;
        },
        // Back to a place the bot left (script step go_back): the server moves it (a road-less pit cannot be entered on foot); without RCON it walks.
        back: async (o, opt = {}) => {
            if (!rcon || !Number.isInteger(o.x) || !Number.isInteger(o.y) || !Number.isInteger(o.z)) return execute(bot, 'move_to', o, { cancel });
            // Not to the exact cell it left: its floor may be gone by now (dug away, flooded) and a bot put there falls to its death (it did, twice). The nearest standable
            // cell around it, the cell itself first (distance 0).
            const l = await envObj.lift(o, { radius: 3, down: 3, up: 2, purpose: opt.purpose || 'job', why: opt.why || 'back to the last good place' });
            return l.ok ? { ok: true, to: l.to } : l;
        },
        // A tool counts only if it is not worn out AND, when a script is asked to fix a missing tool for a block (`this.need`, set by the worker and the service), it can
        // harvest that block: a stone pickaxe is no replacement for the one that was missing for gold ore (live 2026-11-07: replace-tool answered ok and the bot waited on).
        canHarvest: function (itemName) { return canHarvest(itemName, this && this.need); },
        usableCount: function (cls) { return bot.inventory.items().filter((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i) && canHarvest(i.name, this && this.need)).length; },
        gather: (a) => require('../jobs/gather').gather(bot, a, { cancel, execute: (b, n, x, o) => execute(b, n, x, o) }),
        usableTool: function (cls) { return bot.inventory.items().find((i) => i.name.endsWith(`_${cls}`) && !require('../../skills/options').isWorn(bot, i) && canHarvest(i.name, this && this.need)) || null; },
        canCraft: (item) => { const it = bot.registry.itemsByName[item]; return !!it && bot.recipesFor(it.id, null, 1, true).length > 0; },
        itemExists: (n) => !!bot.registry.itemsByName[n],
        // Another bot in (or next to) the cell the bot stands in: a block cannot be placed there (a pillar fails not_confirmed) until one of them steps aside.
        // Move the bot (server `tp`, position only) to the nearest cell where it can stand at the layer of a station that is far above or below it and cannot be
        // walked to: in a ragged open pit a floating pillar block cannot be climbed down and a shaft cannot be walked up. A cell needs air for the body and solid below.
        // `purpose`: 'job' (a station in another layer, a way out of the pit, the water rescue) is always allowed; 'recover' (the escape ladder after a failed move) follows the
        // operator's `teleport` setting: off = never, near = within 16 blocks across and 6 up or down, any = as far as it takes. With the setting OFF no server move is made at all, for any purpose
        // (lift, rejoin, goBack, back all refuse; the callers walk, dig or give up). Every server move is reported to `moved`
        // (owner 2026-11-08: "the bot moves as if teleporting"; it was this, and nothing said so).
        lift: (S, o = {}) => around('lift', async () => {
            const { radius = 5, down = 0, up = 2, purpose = 'job', why = '', skipSame = false } = o;
            // A recovery move first on foot, by the stuck-escape expert (owner 2026-11-09: "it moves as if teleporting"): the standable cell the server move would pick, reached by walking, digging
            // and climbing; the server moves the bot only when that fails (and not at all with setting teleport = off).
            if (purpose === 'recover' && expertsOn()) {
                const c0 = pickCell(S, { radius, down, up }), f0 = feetCell(bot.entity.position);
                if (c0 && Math.abs(c0.x - f0.x) + Math.abs(c0.y - f0.y) + Math.abs(c0.z - f0.z) <= EXPERT_LIFT) { const e = await envObj.expertMove({ x: c0.x, y: c0.y, z: c0.z }, { escape: true, why: `escape after ${why || 'a failed move'}`, maxMs: 20000 }); if (e.ok) return { ok: true, to: { x: c0.x, y: c0.y, z: c0.z }, how: 'expert' }; }
            }
            if (!rcon) return { ok: false, reason: 'refused', detail: { why: 'no RCON' } };
            const mode = teleport();
            if (mode === 'off') return { ok: false, reason: 'refused', detail: { why: 'server moves are off (setting teleport)', purpose } };         // off = no tp of any kind, whatever the purpose (owner 2026-11-10: "teleportation is prohibited for the time being")
            const oth = others ? others() : [], cand = [];
            for (let dx = -radius; dx <= radius; dx++) for (let dz = -radius; dz <= radius; dz++) for (let y = S.y - down; y <= S.y + up; y++) {
                const x = S.x + dx, z = S.z + dz;
                if (w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
                if (oth.some((o) => Math.hypot(o.x - (x + 0.5), o.z - (z + 0.5)) < 1.3)) continue;
                cand.push({ x, y, z, safe: safeStand(x, y, z), exit: hasExit(x, y, z), d: Math.hypot(dx, dz) + Math.abs(y - S.y) });
            }
            if (!cand.length) return { ok: false, reason: 'unreachable', detail: { why: 'no standable cell near the station' } };
            cand.sort((a, b) => (b.exit - a.exit) || (b.safe - a.safe) || (a.d - b.d));      // a cell that can be left on foot first (not a sealed pocket), then one without an edge or fluid beside it, then the nearest
            const c = cand[0], p0 = bot.entity.position, dist = Math.round(Math.hypot(c.x + 0.5 - p0.x, c.y - p0.y, c.z + 0.5 - p0.z));
            if (purpose === 'recover' && mode === 'near' && (Math.hypot(c.x + 0.5 - p0.x, c.z + 0.5 - p0.z) > 16 || Math.abs(c.y - p0.y) > 6)) return { ok: false, reason: 'refused', detail: { why: `${dist} blocks is too far for a recovery move (setting teleport: near)`, dist } };
            if (skipSame && dist === 0) return { ok: true, to: { x: c.x, y: c.y, z: c.z }, same: true };         // `skipSame` (the pit asks): already standing there = no server move (it was logged as "moved 0 blocks" every try); goBack still moves the bot
            const from = { x: Math.round(p0.x), y: Math.round(p0.y), z: Math.round(p0.z) };
            try { await rcon(`tp ${bot.username} ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); } catch (e) { return { ok: false, reason: 'refused', detail: { message: String(e.message).slice(0, 80) } }; }
            if (moved) { try { moved({ kind: 'server_tp', from, to: { x: c.x, y: c.y, z: c.z }, dist, purpose, why: why || purpose }); } catch (_) { /* reporting must not break the move */ } }
            for (let i = 0; i < 30; i++) { await sleep(100); const p = bot.entity.position; if (Math.abs(p.x - c.x - 0.5) < 1.5 && Math.abs(p.y - c.y) < 1.5 && Math.abs(p.z - c.z - 0.5) < 1.5 && bot.entity.onGround) return { ok: true, to: { x: c.x, y: c.y, z: c.z } }; }
            return { ok: false, reason: 'not_confirmed' };
        }),
        // A bot far from its job (it died and came back at the world spawn, 1,500 blocks away): the chunks of the job are not in its world model, so `lift` finds nothing to stand on and a walk
        // cannot even start. The server puts it on the cell above the station (or on the last good place) when, and only when, the server itself says both cells there are air; nothing is
        // guessed, a cell that is not open (or a chunk that is not loaded) is no destination. Live 2026-11-09: four bots stood at the spawn for 20 minutes, each trying a 180-block corridor.
        rejoin: (S, { why = 'back to the job' } = {}) => around('lift', async () => {
            if (!rcon) return { ok: false, reason: 'refused', detail: { why: 'no RCON' } };
            if (teleport() === 'off') return { ok: false, reason: 'refused', detail: { why: 'server moves are off (setting teleport)' } };
            const tries = [];
            if (S && Number.isInteger(S.x)) tries.push({ x: S.x, y: S.y + 1, z: S.z, name: 'the station' });
            if (good) tries.push({ x: good.x, y: good.y, z: good.z, name: 'the last good place' });
            const p0 = bot.entity.position, from = { x: Math.round(p0.x), y: Math.round(p0.y), z: Math.round(p0.z) };
            for (const t of tries) {
                let out = '';
                try { out = String(await rcon(`execute if block ${t.x} ${t.y} ${t.z} minecraft:air if block ${t.x} ${t.y + 1} ${t.z} minecraft:air run tp ${bot.username} ${t.x + 0.5} ${t.y} ${t.z + 0.5}`)); } catch (e) { return { ok: false, reason: 'refused', detail: { message: String(e.message).slice(0, 80) } }; }
                if (!/teleported/i.test(out)) continue;
                for (let i = 0; i < 40; i++) {
                    await sleep(100); const p = bot.entity.position;
                    if (Math.abs(p.x - t.x - 0.5) < 2 && Math.abs(p.y - t.y) < 3 && Math.abs(p.z - t.z - 0.5) < 2) {
                        if (moved) { try { moved({ kind: 'server_tp', from, to: { x: t.x, y: t.y, z: t.z }, dist: Math.round(Math.hypot(t.x - from.x, t.z - from.z)), purpose: 'job', why: `${why} (${t.name})` }); } catch (_) { /* reporting must not break the move */ } }
                        await sleep(600);                                  // the chunks around the new place arrive
                        return { ok: true, to: { x: t.x, y: t.y, z: t.z }, at: t.name };
                    }
                }
            }
            return { ok: false, reason: 'unreachable', detail: { why: 'far from the job and the server knows no open cell to send the bot to', botSide: true, stage: 'rejoin' } };
        }),
        // Walk to the nearest standable cell that no other bot stands in or next to (two bots in one cell blocked each other's pillar for ten minutes).
        stepAside: async () => {
            const f = feetCell(bot.entity.position), oth = others ? others() : [];
            const free = (x, z) => !oth.some((o) => Math.hypot(o.x - (x + 0.5), o.z - (z + 0.5)) < 1.3);
            let tried = 0;
            for (let rad = 1; rad <= 3 && tried < 6; rad++) {
                for (let dx = -rad; dx <= rad && tried < 6; dx++) for (let dz = -rad; dz <= rad && tried < 6; dz++) {
                    if (Math.max(Math.abs(dx), Math.abs(dz)) !== rad) continue;
                    for (const dy of [0, 1, -1]) {
                        const x = f.x + dx, y = f.y + dy, z = f.z + dz;
                        if (!free(x, z) || w.kindAt(x, y, z) !== 'air' || w.kindAt(x, y + 1, z) !== 'air' || w.kindAt(x, y - 1, z) !== 'solid') continue;
                        tried++; const m = await execute(bot, 'move_to', { x, y, z }, { cancel });
                        if (m.ok) return { ok: true, to: { x, y, z } };
                        break;
                    }
                }
            }
            return { ok: false, reason: 'unreachable' };
        },
        crowded: () => !!others && others().some((o) => Math.hypot(o.x - bot.entity.position.x, o.z - bot.entity.position.z) < 0.9),
        pause: (ticks) => sleep(ticks * 50),                       // let the thing in the way (another bot, an item) move on
        unitCancel,
        /** Why the last unit was stopped (operator, attacked, drowning, reflex), then forgotten; null when nothing stopped it. */
        takeCancelCause: () => { const c = stopCause || (bot.__preempt ? 'reflex' : null); stopCause = null; return c; },
        // `o.maxTicks`: a shorter budget than the command's own (a walk to a station that has not arrived in 30 s is not going to; the worker's ladder takes over).
        exec: (name, args, o = {}) => (CHEST_OPS.has(name) ? queued(args, unitCancel, (c) => execute(bot, name, args, { cancel: c })) : execute(bot, name, args, { cancel: unitCancel, ...(Number.isInteger(o.maxTicks) ? { maxTicks: o.maxTicks } : {}) })),
        // For the water rescue: stopped by the operator only. `drowning()` is what sends the worker to the rescue, so the rescue's own commands must not be cancelled by it
        // (live 2026-11-09: every swim and fill came back `cancelled` at once, the worker claimed the next unit, which was cancelled at once too: 99,639 failures in a loop that never yielded and froze all 20 bots).
        execFree: (name, args) => (CHEST_OPS.has(name) ? queued(args, cancel, (c) => execute(bot, name, args, { cancel: c })) : execute(bot, name, args, { cancel })),
        have,
        inv: () => janitor.inventoryOf(bot),
        here: feet,
        pos: () => ({ x: bot.entity.position.x, z: bot.entity.position.z, dim: envObj.dimension() }),      // dim: sites in another dimension are not usable containers (sites.js reachable)
    };
    return envObj;
}

module.exports = { botEnv };
