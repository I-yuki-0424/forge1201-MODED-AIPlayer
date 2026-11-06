'use strict';
// Simple scripts for the pure bots (owner 2026-11-06): several commands with a few if-statements, so that somewhat complicated things
// that need no learning run by themselves on dozens of bots at once. Example: dig the range; IF there is no usable tool > IF there are
// iron ingots and sticks (or sticks can be made) > craft what is missing at a crafting table > go back to work.
//
// A script is plain JSON (stored one file per script, or built in):  { "name": "...", "steps": [ STEP, ... ] }
//   STEP  { "cmd": "craft", "args": {...}, "at": "tools", "table": true, "optional": true }   one command of the action layer (or "pillar")
//           "at": a site tag: x, y, z of the nearest tagged site are added to the arguments; "table": the crafting table placed by `station`
//           "optional": a failure does not end the script
//         { "if": COND, "then": [STEP...], "else": [STEP...] }
//         { "take": { "item": "iron_ingot", "count": 3, "from": "ore" }, "optional": true }   withdraw from the nearest site with that tag
//         { "take_tool": { "class": "pickaxe", "from": "tools" } }     one USABLE tool of that class from the tools chest (never a worn-out one), best tier first
//         { "put_away": true }                                          the inventory upkeep (full inventory): items go to the tagged sites
//         { "station": "crafting_table" } / { "release_station": true } place a table beside the bot (made from planks if needed) / take it back
//         { "leave_pit": true }                                         out of the pit by the pillar method (needs the job's box)
//         { "return": "ok" | "fail" }                                   end: ok = solved, go back to work
//   COND  { "has": "iron_ingot" } | { "has": { "item": "iron_ingot", "min": 3 } } | { "tool": "pickaxe" } (a usable, not worn one)
//         { "can_craft": "stick" } | { "site": "tools" } | { "free_slots": 4 } | { "all": [..] } | { "any": [..] } | { "not": COND }
// The grammar is closed: unknown keys, commands outside the action layer, deep nesting or more than 200 steps are refused when the
// script is stored, not discovered at run time. Nothing in a script can run code.
const { COMMANDS, validateArgs } = require('../../skills');
const janitor = require('./janitor');

const MAX_STEPS = 200, MAX_DEPTH = 6;
const WORK_MOVES = new Set(['pillar', 'take_usable']);
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const CLASSES = new Set(['pickaxe', 'axe', 'shovel', 'sword', 'hoe']);
const STEP_KEYS = new Set(['go_back', 'cmd', 'args', 'at', 'table', 'furnace', 'optional', 'gather', 'make_planks', 'if', 'then', 'else', 'take', 'take_tool', 'put_away', 'station', 'release_station', 'leave_pit', 'return', 'log']);
const COND_KEYS = new Set(['has', 'tool', 'usable', 'harvests', 'can_craft', 'site', 'free_slots', 'in_pit', 'planks', 'logs', 'all', 'any', 'not']);
const REACH_DY = 12;                          // a tagged chest more than this many levels above or below the bot is not walked to (the planner would search for a minute and fail)
const ITEM = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/;

class ScriptError extends Error {}
const bad = (m) => { throw new ScriptError(m); };

function validateCond(c, depth) {
    if (depth > MAX_DEPTH) bad('conditions nested too deep');
    if (!c || typeof c !== 'object' || Array.isArray(c)) bad('a condition is an object');
    const ks = Object.keys(c); if (ks.length !== 1 || !COND_KEYS.has(ks[0])) bad(`a condition has exactly one of: ${[...COND_KEYS].join(', ')}`);
    const [k] = ks, v = c[k];
    if (k === 'has') { const item = typeof v === 'string' ? v : v && v.item; if (typeof item !== 'string' || !ITEM.test(item)) bad('has: an item name'); if (typeof v === 'object' && v.min !== undefined && !(Number.isInteger(v.min) && v.min >= 0 && v.min <= 2304)) bad('has.min is an integer 0..2304'); }
    else if (k === 'tool') { if (!CLASSES.has(v)) bad(`tool: one of ${[...CLASSES].join(', ')}`); }
    else if (k === 'can_craft') { if (typeof v !== 'string' || !ITEM.test(v)) bad('can_craft: an item name'); }
    else if (k === 'site') { if (typeof v !== 'string' || !/^[a-z]{2,12}$/.test(v)) bad('site: a tag'); }
    else if (k === 'free_slots') { if (!Number.isInteger(v) || v < 0 || v > 36) bad('free_slots: 0..36'); }
    else if (k === 'in_pit') { if (v !== true) bad('in_pit: true'); }
    else if (k === 'harvests') { if (typeof v !== 'string' || !ITEM.test(v)) bad('harvests: an item name'); }
    else if (k === 'usable') { if (!v || !CLASSES.has(v.class) || !Number.isInteger(v.min) || v.min < 1 || v.min > 9) bad('usable: {class, min: 1..9}'); }
    else if (k === 'planks' || k === 'logs') { if (!Number.isInteger(v) || v < 1 || v > 64) bad(`${k}: 1..64`); }
    else if (k === 'not') validateCond(v, depth + 1);
    else { if (!Array.isArray(v) || !v.length || v.length > 8) bad(`${k}: a list of 1..8 conditions`); for (const x of v) validateCond(x, depth + 1); }
}

/** Throws ScriptError unless the script is well formed; returns it (normalised copy) otherwise. */
function validate(script) {
    if (!script || typeof script !== 'object' || Array.isArray(script)) bad('a script is an object');
    if (typeof script.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(script.name)) bad('script name: a-z 0-9 _ - (max 32)');
    let n = 0;
    const steps = (list, depth) => {
        if (depth > MAX_DEPTH) bad('steps nested too deep');
        if (!Array.isArray(list)) bad('steps is a list');
        for (const s of list) {
            if (++n > MAX_STEPS) bad(`more than ${MAX_STEPS} steps`);
            if (!s || typeof s !== 'object' || Array.isArray(s)) bad('a step is an object');
            for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) bad(`unknown key ${k.slice(0, 20)} in a step`);
            if (s.if !== undefined) { validateCond(s.if, 1); steps(s.then || [], depth + 1); steps(s.else || [], depth + 1); }
            else if (s.cmd !== undefined) {
                if (!COMMANDS[s.cmd] && !WORK_MOVES.has(s.cmd)) bad(`unknown command ${String(s.cmd).slice(0, 20)}`);
                if (s.args !== undefined && (typeof s.args !== 'object' || Array.isArray(s.args))) bad('args is an object');
                if (s.at !== undefined && !/^[a-z]{2,12}$/.test(s.at)) bad('at: a site tag');
            } else if (s.take !== undefined) {
                const t = s.take; if (!t || typeof t.item !== 'string' || !ITEM.test(t.item) || !/^[a-z]{2,12}$/.test(t.from || '') || !(t.count === undefined || (Number.isInteger(t.count) && t.count >= 1 && t.count <= 2304))) bad('take: {item, count?, from: tag}');
            } else if (s.take_tool !== undefined) {
                const t = s.take_tool; if (!t || !CLASSES.has(t.class) || !/^[a-z]{2,12}$/.test(t.from || '') || !(t.until === undefined || (Number.isInteger(t.until) && t.until >= 1 && t.until <= 6))) bad('take_tool: {class, from: tag, until?: 1..6}');
            } else if (s.gather !== undefined) {
                const g = s.gather; if (!g || typeof g.target !== 'string' || !ITEM.test(g.target) || !(g.count === undefined || (Number.isInteger(g.count) && g.count >= 1 && g.count <= 64)) || !(g.radius === undefined || (Number.isInteger(g.radius) && g.radius >= 4 && g.radius <= 64))) bad('gather: {target, count?: 1..64, radius?: 4..64}');
            } else if (s.make_planks !== undefined) { if (!Number.isInteger(s.make_planks) || s.make_planks < 1 || s.make_planks > 16) bad('make_planks: 1..16 (planks to make from the logs in the pack)'); }
            else if (s.station !== undefined) { if (!['crafting_table', 'furnace'].includes(s.station)) bad('station: crafting_table or furnace'); }
            else if (s.return !== undefined) { if (!['ok', 'fail'].includes(s.return)) bad('return: ok or fail'); }
            else if (!(s.put_away || s.release_station || s.leave_pit || s.go_back || typeof s.log === 'string')) bad('a step does something: cmd, if, take, take_tool, gather, make_planks, put_away, station, release_station, leave_pit, go_back, return or log');
        }
    };
    steps(script.steps, 1);
    return JSON.parse(JSON.stringify({ name: script.name, steps: script.steps }));
}

// ------------------------------------------------------------------------------------------------------------------------ run

const count = (env, item) => (env.have ? env.have(item) : 0);
const toolOf = (cls, env) => (env.usableTool ? env.usableTool(cls) : null);
const sumItems = (env, re) => (typeof env.inv === 'function' ? env.inv().items.reduce((n, i) => n + (re.test(i.name) ? i.count : 0), 0) : 0);
const firstItem = (env, re) => (typeof env.inv === 'function' ? (env.inv().items.find((i) => re.test(i.name) && i.count > 0) || {}).name : undefined);

function holds(c, env) {
    const k = Object.keys(c)[0], v = c[k];
    if (k === 'has') { const item = typeof v === 'string' ? v : v.item, min = typeof v === 'object' && v.min !== undefined ? v.min : 1; return count(env, item) >= min; }
    if (k === 'tool') return !!toolOf(v, env);
    if (k === 'can_craft') return !!(env.canCraft && env.canCraft(v));
    if (k === 'site') return !!(env.sites && env.sites.find(v, env.pos ? env.pos() : null));
    if (k === 'free_slots') return env.inv ? env.inv().slotsFree >= v : false;
    if (k === 'usable') return (env.usableCount ? env.usableCount(v.class) : toolOf(v.class, env) ? 1 : 0) >= v.min;
    if (k === 'harvests') return env.canHarvest ? !!env.canHarvest(v) : true;
    if (k === 'in_pit') return !!(env.box && env.here && env.w && require('./exit').inPit(env, env.box));
    if (k === 'planks' || k === 'logs') return sumItems(env, k === 'planks' ? /_planks$/ : /_(log|stem|hyphae)$/) >= v;
    if (k === 'not') return !holds(v, env);
    if (k === 'all') return v.every((x) => holds(x, env));
    return v.some((x) => holds(x, env));
}

/**
 * Run a validated script on a bot. `env`: exec(name, args), run(name, args) for work moves, have(item), usableTool(class), canCraft(item),
 * inv(), here(), pos(), w, sites (a Sites), policy (janitor), box (the pit's box, for leave_pit), cancel.
 * Returns { ok: true|false, ended: 'ok' | 'fail' | 'end' | 'error' | 'cancelled', steps, reason?, log: [...] }. `ok` is true for `return ok` and for
 * running off the end without a `return` (a script that does what it says and stops).
 */
async function runScript(script, env, { cancel = { cancelled: false }, maxSteps = MAX_STEPS * 4 } = {}) {
    const st = { steps: 0, log: [], table: null };
    const note = (m) => { if (st.log.length < 60) st.log.push(String(m).slice(0, 160)); };
    const result = (ended, extra = {}) => ({ ok: ended === 'ok' || ended === 'end', ended, steps: st.steps, log: st.log, ...extra });
    const site = (tag) => (env.sites ? env.sites.find(tag, env.pos ? env.pos() : null) : null);
    const command = async (name, args, { table = false, furnace = false, at = null, atSite = null } = {}) => {
        let a = { ...(args || {}) };
        if (atSite) a = { ...a, x: atSite.x, y: atSite.y, z: atSite.z };
        else if (at) { const s = site(at); if (!s) return { ok: false, reason: 'invalid_target', detail: { why: `no site tagged ${at}` } }; a = { ...a, x: s.x, y: s.y, z: s.z }; }
        if (table) { if (!st.table) return { ok: false, reason: 'no_station', detail: { why: 'no crafting table placed (use station first)' } }; a = { ...a, ...st.table }; }
        if (furnace) { if (!st.furnace) return { ok: false, reason: 'no_station', detail: { why: 'no furnace placed (use station first)' } }; a = { ...a, ...st.furnace }; }
        if (WORK_MOVES.has(name)) return env.run ? env.run(name, a) : { ok: false, reason: 'invalid_args', detail: { why: 'no work moves here' } };
        try { validateArgs(name, a); } catch (e) { return { ok: false, reason: e.reason || 'invalid_args', detail: e.detail }; }
        return env.exec(name, a);
    };
    async function block(list) {
        for (const s of list) {
            if (cancel.cancelled) return 'cancelled';
            if (++st.steps > maxSteps) return 'error';
            if (s.if !== undefined) { const r = await block(holds(s.if, env) ? s.then || [] : s.else || []); if (r) return r; continue; }
            if (s.return !== undefined) return s.return;
            if (typeof s.log === 'string') { note(s.log); continue; }
            let res = { ok: true };
            if (s.cmd !== undefined) { res = await command(s.cmd, s.args, { table: !!s.table, furnace: !!s.furnace, at: s.at }); note(`${s.cmd} ${res.ok ? 'ok' : res.reason}`); }
            else if (s.take !== undefined) {
                const t = s.take, target = site(t.from);
                res = target ? await command('withdraw', { item: t.item, count: t.count || 1 }, { at: t.from }) : { ok: false, reason: 'invalid_target', detail: { why: `no site tagged ${t.from}` } };
                note(`take ${t.item} from ${t.from}: ${res.ok ? 'ok' : res.reason}`);
            } else if (s.take_tool !== undefined) {
                // Usable tools of the class from the tools chest (take_usable: not worn out, best tier, most uses left), never a worn one, until the bot holds
                // `until` of them (default 1). A chest far above or below the bot (a pit bottom, 100 levels down) is not tried: nobody can walk there.
                const { class: cls, from, until = 1 } = s.take_tool, usable = () => (env.usableCount ? env.usableCount(cls) : toolOf(cls, env) ? 1 : 0);
                const chests = env.sites ? env.sites.findAll(from, env.pos ? env.pos() : null).slice(0, 3) : [];
                res = { ok: usable() >= until };
                if (!res.ok && !chests.length) { res = { ok: false, reason: 'invalid_target', detail: { why: `no site tagged ${from}` } }; note(res.detail.why); }
                else if (!res.ok) {
                    // The nearest tagged chest first; one that is far above or below, or is no chest at all (the tag sits on air), is passed over for the next.
                    const why = [];
                    for (const chest of chests) {
                        if (usable() >= until) break;
                        const dy = env.here ? Math.abs(chest.y - env.here().y) : 0;
                        if (dy > REACH_DY) { why.push(`${chest.name} is ${dy} levels away`); continue; }
                        for (let n = 0; n < 6 && usable() < until; n++) {
                            const r = await command('take_usable', { class: cls }, { atSite: chest });
                            if (r.ok) { note(`took a ${cls}${r.detail && r.detail.item ? ` (${r.detail.item}, ${r.detail.left} uses left)` : ''} from ${chest.name}`); continue; }
                            if (['died', 'disconnected', 'cancelled'].includes(r.reason)) { res = r; break; }
                            why.push(`${chest.name}: ${r.reason === 'missing_item' ? `no usable ${cls}${r.detail && r.detail.worn ? ` (${r.detail.worn} worn out)` : ''}` : r.reason}`);
                            break;
                        }
                        if (res.reason === 'died' || res.reason === 'disconnected' || res.reason === 'cancelled') break;
                    }
                    if (usable()) res = { ok: true };
                    else if (!res.reason) { res = { ok: false, reason: 'missing_item', detail: { why: `no usable ${cls} from the ${from} chests: ${why.join('; ') || 'none reachable'}` } }; note(res.detail.why); }
                }
            } else if (s.gather !== undefined) {
                res = env.gather ? await env.gather({ target: s.gather.target, count: s.gather.count || 4, radius: s.gather.radius || 24 }) : { ok: false, reason: 'invalid_args', detail: { why: 'no gathering here' } };
                note(`gather ${s.gather.target}: ${res.ok ? 'ok' : res.reason}`);
            } else if (s.make_planks !== undefined) {
                const log = firstItem(env, /_(log|stem|hyphae)$/);
                res = log ? await env.exec('craft', { item: log.replace(/_(log|stem|hyphae)$/, '_planks'), count: s.make_planks }) : { ok: false, reason: 'missing_item', detail: { why: 'no log to make planks from' } };
                note(`planks from ${log || 'nothing'}: ${res.ok ? 'ok' : res.reason}`);
            } else if (s.put_away) {
                res = env.policy ? await janitor.maintain(env, { ...env.policy, freeTarget: 36, sites: env.sites || env.policy.sites }) : { ok: true };
            } else if (s.station) {
                res = await placeStation(env, st, s.station);
                note(`${s.station.replace('_', ' ')} ${res.ok ? 'placed' : res.reason}`);
            } else if (s.release_station) {
                if (st.table) { res = await env.exec('mine', { ...st.table }); st.table = null; }
            } else if (s.leave_pit) {
                if (!st.origin && env.here) st.origin = { ...env.here() };                    // where the bot stood: `go_back` returns there
                res = env.box && env.leavePit ? await env.leavePit(env.box) : { ok: false, reason: 'invalid_target', detail: { why: 'not in a pit job' } };
                note(`leave pit: ${res.ok ? res.how : res.reason}${res.levels ? ` (${res.levels} levels)` : ''}${!res.ok && res.detail && res.detail.why ? ` [${String(res.detail.why).slice(0, 70)}]` : ''}${env.here ? ` now y ${env.here().y}` : ''}`);
            } else if (s.go_back) {
                // Back to where the pit work was left (a road-less pit cannot be walked into again): the server moves the bot there, nothing in the world changes.
                res = st.origin && env.back ? await env.back(st.origin) : { ok: true };
                note(`back to ${st.origin ? [st.origin.x, st.origin.y, st.origin.z].join(' ') : 'nowhere'}: ${res.ok ? 'ok' : res.reason}`);
            }
            if (!res.ok && !s.optional) { if (res.reason === 'died' || res.reason === 'disconnected' || res.reason === 'cancelled') return res.reason; return { fail: res }; }
        }
        return null;
    }
    const r = await block(script.steps);
    if (r && typeof r === 'object') return result('fail', { reason: r.fail.reason, detail: r.fail.detail });
    if (r === 'ok') return result('ok');
    if (r === 'fail') return result('fail');
    if (r === 'cancelled' || r === 'died' || r === 'disconnected') return result('cancelled', { reason: r });
    if (r === 'error') return result('error', { reason: 'too_many_steps' });
    return result('end');
}

/** A crafting table or a furnace beside the bot: placed from the inventory, made first when there is none (planks / 8 cobblestone). Sets st.table or st.furnace to its x, y, z. */
async function placeStation(env, st, kind = 'crafting_table') {
    if (count(env, kind) < 1) {
        if (!(env.canCraft && env.canCraft(kind))) return { ok: false, reason: 'missing_materials', detail: { why: kind === 'furnace' ? 'no furnace and no 8 cobblestone to make one' : 'no crafting table and no planks to make one' } };
        // A furnace is a 3x3 recipe: made at a crafting table (placed first when the bot has none out); a table is made in the 2x2 grid.
        let at = {};
        if (kind === 'furnace') {
            if (!st.table) { const t = await placeStation(env, st, 'crafting_table'); if (!t.ok) return t; }
            at = st.table;
        }
        const c = await env.exec('craft', { item: kind, count: 1, ...at });
        if (!c.ok) return c;
    }
    // The cell beside the bot first, then any free cell within two blocks (the bot may stand among walls and chests); a few tries.
    const spots = [janitor.shulkerSpot(env.w, env.here()), ...janitor.freeSpots(env.w, env.here())].filter(Boolean);
    if (!spots.length) return { ok: false, reason: 'invalid_target', detail: { why: `no free cell near the bot for a ${kind.replace('_', ' ')}` } };
    let p = { ok: false, reason: 'invalid_target' }, spot = null;
    for (const c of spots.slice(0, 4)) { spot = c; p = await env.exec('place', { x: c.x, y: c.y, z: c.z, item: kind }); if (p.ok) break; if (['died', 'disconnected', 'cancelled'].includes(p.reason)) break; }
    if (p.ok) st[kind === 'furnace' ? 'furnace' : 'table'] = { x: spot.x, y: spot.y, z: spot.z };          // only the coordinates: the rest would reach the craft command as an unknown argument
    return p;
}

// ------------------------------------------------------------------------------------------------------------------------ built in

/** The owner's example: no usable tool -> a free one from the tools chest -> else craft one (iron, sticks) -> back to work. */
const REPLACE_TOOL = {
    name: 'replace-tool',
    steps: [
        { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        // 1. the tools chest (only a usable tool; a chest far above or below is skipped)
        { take_tool: { class: 'pickaxe', from: 'tools' }, optional: true },
        { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        // 1b. the chest is far above (the pit is deep): climb out (pillar), take, and be put back where the work was left
        { if: { site: 'tools' }, then: [
            { leave_pit: true, optional: true },
            { take_tool: { class: 'pickaxe', from: 'tools', until: 2 }, optional: true },
            // While the bot is up here: what it needs to make a pickaxe down there (the chests are out of reach from the pit bottom).
            { if: { not: { has: { item: 'iron_ingot', min: 3 } } }, then: [
                { take: { item: 'iron_ingot', count: 3, from: 'ore' }, optional: true },
                { if: { not: { has: { item: 'iron_ingot', min: 3 } } }, then: [{ take: { item: 'iron_ingot', count: 3, from: 'storage' }, optional: true }] },
            ] },
            { if: { any: [{ not: { has: { item: 'stick', min: 4 } } }, { all: [{ not: { has: { item: 'crafting_table', min: 1 } } }, { not: { planks: 4 } }] }] }, then: [
                { take: { item: 'stick', count: 8, from: 'storage' }, optional: true },
                { if: { any: [{ not: { has: { item: 'stick', min: 4 } } }, { not: { planks: 6 } }] }, then: [
                    { if: { not: { planks: 6 } }, then: [
                        { if: { not: { logs: 3 } }, then: [{ gather: { target: 'oak_log', count: 4, radius: 24 }, optional: true }] },
                        { if: { not: { logs: 3 } }, then: [{ gather: { target: 'jungle_log', count: 4, radius: 24 }, optional: true }] },
                        { if: { not: { logs: 3 } }, then: [{ gather: { target: 'spruce_log', count: 4, radius: 24 }, optional: true }] },
                        { make_planks: 12, optional: true },
                    ] },
                    { if: { not: { has: { item: 'stick', min: 4 } } }, then: [{ cmd: 'craft', args: { item: 'stick', count: 8 }, optional: true }] },
                ] },
            ] },
            { go_back: true, optional: true },
        ] },
        { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        // 2. made from what the bot carries or can fetch: sticks (planks <- logs <- a tree nearby), then iron (ingots, or raw iron smelted in a furnace) or stone
        { if: { not: { has: { item: 'stick', min: 2 } } }, then: [{ take: { item: 'stick', count: 4, from: 'storage' }, optional: true }] },
        { if: { not: { has: { item: 'stick', min: 2 } } }, then: [
            { if: { not: { planks: 2 } }, then: [
                // Trees are on the surface: from inside the pit the bot would walk to the wall in front of one and back (live pit 2026-11-07), so it does not look.
                { if: { all: [{ not: { logs: 1 } }, { not: { in_pit: true } }] }, then: [{ gather: { target: 'oak_log', count: 2, radius: 24 }, optional: true }] },
                { make_planks: 4, optional: true },
            ] },
            { cmd: 'craft', args: { item: 'stick', count: 4 }, optional: true },
        ] },
        { if: { not: { has: { item: 'iron_ingot', min: 3 } } }, then: [
            { take: { item: 'iron_ingot', count: 3, from: 'ore' }, optional: true },
            { if: { not: { has: { item: 'iron_ingot', min: 3 } } }, then: [{ take: { item: 'iron_ingot', count: 3, from: 'storage' }, optional: true }] },
            { if: { all: [{ not: { has: { item: 'iron_ingot', min: 3 } } }, { has: { item: 'raw_iron', min: 3 } }] }, then: [
                { station: 'furnace', optional: true },
                { cmd: 'smelt', args: { item: 'raw_iron', count: 3 }, furnace: true, optional: true },
            ] },
        ] },
        { if: { all: [{ has: { item: 'iron_ingot', min: 3 } }, { has: { item: 'stick', min: 2 } }] }, then: [
            { station: 'crafting_table' },
            { cmd: 'craft', args: { item: 'iron_pickaxe', count: 1 }, table: true },
            { release_station: true },
            { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        ] },
        // 3. no iron: a stone pickaxe from cobblestone mined on the way (it breaks stone and iron ore)
        { if: { all: [{ harvests: 'stone_pickaxe' }, { any: [{ has: { item: 'cobblestone', min: 3 } }, { has: { item: 'cobbled_deepslate', min: 3 } }] }, { has: { item: 'stick', min: 2 } }] }, then: [
            { station: 'crafting_table' },
            { cmd: 'craft', args: { item: 'stone_pickaxe', count: 1 }, table: true },
            { release_station: true },
            { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        ] },
        // 4. nothing else: a wooden pickaxe from planks and sticks (it breaks stone and cobblestone, so the bot can mine its way up to a stone pickaxe)
        { if: { all: [{ harvests: 'wooden_pickaxe' }, { has: { item: 'stick', min: 2 } }, { planks: 3 }] }, then: [
            { station: 'crafting_table' },
            { cmd: 'craft', args: { item: 'wooden_pickaxe', count: 1 }, table: true },
            { release_station: true },
            { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        ] },
        { return: 'fail' },
    ],
};
/** At the start of a job (and whenever the bot passes the chest): hold three usable pickaxes, so that a worn one is replaced on the spot. */
const STOCK_TOOLS = {
    name: 'stock-tools',
    steps: [
        { take_tool: { class: 'pickaxe', from: 'tools', until: 3 }, optional: true },
        // Still fewer than three (the bot works deep in the pit, the chest is far above): climb out, fill up, be put back (the owner's tools chest first, before anything is crafted).
        { if: { not: { usable: { class: 'pickaxe', min: 3 } } }, then: [
            { leave_pit: true, optional: true },
            { take_tool: { class: 'pickaxe', from: 'tools', until: 3 }, optional: true },
            { go_back: true, optional: true },
        ] },
        // Sticks for pickaxes made in the pit (replace-tool): from the storage chest, else planks from a tree nearby (outside the pit only). Twelve sticks make six pickaxes.
        { if: { not: { has: { item: 'stick', min: 8 } } }, then: [
            { take: { item: 'stick', count: 12, from: 'storage' }, optional: true },
            { if: { all: [{ not: { has: { item: 'stick', min: 8 } } }, { not: { in_pit: true } }] }, then: [
                { if: { not: { planks: 6 } }, then: [
                    { if: { not: { logs: 3 } }, then: [{ gather: { target: 'oak_log', count: 4, radius: 24 }, optional: true }] },
                    { if: { not: { logs: 3 } }, then: [{ gather: { target: 'jungle_log', count: 4, radius: 24 }, optional: true }] },
                    { if: { not: { logs: 3 } }, then: [{ gather: { target: 'spruce_log', count: 4, radius: 24 }, optional: true }] },
                    { if: { not: { logs: 3 } }, then: [{ gather: { target: 'birch_log', count: 4, radius: 24 }, optional: true }] },
                    { make_planks: 12, optional: true },
                ] },
                { cmd: 'craft', args: { item: 'stick', count: 12 }, optional: true },
            ] },
        ] },
        { return: 'ok' },
    ],
};
/** A full inventory: put everything away by the sites (ore, junk, storage), then carry on. */
const MAKE_ROOM = { name: 'make-room', steps: [{ put_away: true }, { return: 'ok' }] };
const BUILT_IN = new Map([[REPLACE_TOOL.name, validate(REPLACE_TOOL)], [MAKE_ROOM.name, validate(MAKE_ROOM)], [STOCK_TOOLS.name, validate(STOCK_TOOLS)]]);

module.exports = { validate, runScript, holds, placeStation, ScriptError, BUILT_IN, REPLACE_TOOL, STOCK_TOOLS, MAKE_ROOM, MAX_STEPS, TIERS, CLASSES };
