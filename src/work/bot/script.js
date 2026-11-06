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
//         { "take_tool": { "class": "pickaxe", "from": "tools" } }     the best tool of that class from the tools chest, best tier first
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
const WORK_MOVES = new Set(['pillar']);
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const CLASSES = new Set(['pickaxe', 'axe', 'shovel', 'sword', 'hoe']);
const STEP_KEYS = new Set(['cmd', 'args', 'at', 'table', 'optional', 'if', 'then', 'else', 'take', 'take_tool', 'put_away', 'station', 'release_station', 'leave_pit', 'return', 'log']);
const COND_KEYS = new Set(['has', 'tool', 'can_craft', 'site', 'free_slots', 'all', 'any', 'not']);
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
                const t = s.take_tool; if (!t || !CLASSES.has(t.class) || !/^[a-z]{2,12}$/.test(t.from || '')) bad('take_tool: {class, from: tag}');
            } else if (s.station !== undefined) { if (s.station !== 'crafting_table') bad('station: crafting_table'); }
            else if (s.return !== undefined) { if (!['ok', 'fail'].includes(s.return)) bad('return: ok or fail'); }
            else if (!(s.put_away || s.release_station || s.leave_pit || typeof s.log === 'string')) bad('a step does something: cmd, if, take, take_tool, put_away, station, release_station, leave_pit, return or log');
        }
    };
    steps(script.steps, 1);
    return JSON.parse(JSON.stringify({ name: script.name, steps: script.steps }));
}

// ------------------------------------------------------------------------------------------------------------------------ run

const count = (env, item) => (env.have ? env.have(item) : 0);
const toolOf = (cls, env) => (env.usableTool ? env.usableTool(cls) : null);

function holds(c, env) {
    const k = Object.keys(c)[0], v = c[k];
    if (k === 'has') { const item = typeof v === 'string' ? v : v.item, min = typeof v === 'object' && v.min !== undefined ? v.min : 1; return count(env, item) >= min; }
    if (k === 'tool') return !!toolOf(v, env);
    if (k === 'can_craft') return !!(env.canCraft && env.canCraft(v));
    if (k === 'site') return !!(env.sites && env.sites.find(v, env.pos ? env.pos() : null));
    if (k === 'free_slots') return env.inv ? env.inv().slotsFree >= v : false;
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
    const command = async (name, args, { table = false, at = null } = {}) => {
        let a = { ...(args || {}) };
        if (at) { const s = site(at); if (!s) return { ok: false, reason: 'invalid_target', detail: { why: `no site tagged ${at}` } }; a = { ...a, x: s.x, y: s.y, z: s.z }; }
        if (table) { if (!st.table) return { ok: false, reason: 'no_station', detail: { why: 'no crafting table placed (use station first)' } }; a = { ...a, ...st.table }; }
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
            if (s.cmd !== undefined) { res = await command(s.cmd, s.args, { table: !!s.table, at: s.at }); note(`${s.cmd} ${res.ok ? 'ok' : res.reason}`); }
            else if (s.take !== undefined) {
                const t = s.take, target = site(t.from);
                res = target ? await command('withdraw', { item: t.item, count: t.count || 1 }, { at: t.from }) : { ok: false, reason: 'invalid_target', detail: { why: `no site tagged ${t.from}` } };
                note(`take ${t.item} from ${t.from}: ${res.ok ? 'ok' : res.reason}`);
            } else if (s.take_tool !== undefined) {
                const { class: cls, from } = s.take_tool; res = { ok: !!toolOf(cls, env) };
                if (!res.ok && site(from)) {
                    for (const tier of TIERS) {
                        const item = `${tier}_${cls}`; if (!(env.itemExists ? env.itemExists(item) : true)) continue;
                        const r = await command('withdraw', { item, count: 1 }, { at: from });
                        if (r.ok && toolOf(cls, env)) { res = { ok: true }; note(`took ${item} from ${from}`); break; }
                        if (r.reason === 'died' || r.reason === 'disconnected' || r.reason === 'cancelled') { res = r; break; }
                    }
                    if (!res.ok && !res.reason) { res = { ok: false, reason: 'missing_item', detail: { why: `no usable ${cls} in the ${from} chest` } }; note(res.detail.why); }
                }
            } else if (s.put_away) {
                res = env.policy ? await janitor.maintain(env, { ...env.policy, freeTarget: 36, sites: env.sites || env.policy.sites }) : { ok: true };
            } else if (s.station) {
                res = await placeStation(env, st);
                note(`crafting table ${res.ok ? 'placed' : res.reason}`);
            } else if (s.release_station) {
                if (st.table) { res = await env.exec('mine', { ...st.table }); st.table = null; }
            } else if (s.leave_pit) {
                res = env.box && env.leavePit ? await env.leavePit(env.box) : { ok: false, reason: 'invalid_target', detail: { why: 'not in a pit job' } };
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

/** A crafting table beside the bot: placed from the inventory, made from planks first when there is none. Sets st.table to its x, y, z. */
async function placeStation(env, st) {
    if (count(env, 'crafting_table') < 1) {
        if (!(env.canCraft && env.canCraft('crafting_table'))) return { ok: false, reason: 'missing_materials', detail: { why: 'no crafting table and no planks to make one' } };
        const c = await env.exec('craft', { item: 'crafting_table', count: 1 });
        if (!c.ok) return c;
    }
    const spot = janitor.shulkerSpot(env.w, env.here());
    if (!spot) return { ok: false, reason: 'invalid_target', detail: { why: 'no free cell beside the bot for a crafting table' } };
    const p = await env.exec('place', { ...spot, item: 'crafting_table' });
    if (p.ok) st.table = spot;
    return p;
}

// ------------------------------------------------------------------------------------------------------------------------ built in

/** The owner's example: no usable tool -> a free one from the tools chest -> else craft one (iron, sticks) -> back to work. */
const REPLACE_TOOL = {
    name: 'replace-tool',
    steps: [
        { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        { take_tool: { class: 'pickaxe', from: 'tools' }, optional: true },
        { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        // materials: from the ore and storage chests when they are tagged
        { if: { not: { has: { item: 'iron_ingot', min: 3 } } }, then: [{ take: { item: 'iron_ingot', count: 3, from: 'ore' }, optional: true }] },
        { if: { not: { has: { item: 'stick', min: 2 } } }, then: [{ take: { item: 'stick', count: 4, from: 'storage' }, optional: true }] },
        { if: { all: [{ has: { item: 'iron_ingot', min: 3 } }, { any: [{ has: { item: 'stick', min: 2 } }, { can_craft: 'stick' }] }] }, then: [
            { if: { not: { has: { item: 'stick', min: 2 } } }, then: [{ cmd: 'craft', args: { item: 'stick', count: 4 } }] },
            { station: 'crafting_table' },
            { cmd: 'craft', args: { item: 'iron_pickaxe', count: 1 }, table: true },
            { release_station: true },
            { if: { tool: 'pickaxe' }, then: [{ return: 'ok' }] },
        ] },
        { return: 'fail' },
    ],
};
/** A full inventory: put everything away by the sites (ore, junk, storage), then carry on. */
const MAKE_ROOM = { name: 'make-room', steps: [{ put_away: true }, { return: 'ok' }] };
const BUILT_IN = new Map([[REPLACE_TOOL.name, validate(REPLACE_TOOL)], [MAKE_ROOM.name, validate(MAKE_ROOM)]]);

module.exports = { validate, runScript, holds, placeStation, ScriptError, BUILT_IN, REPLACE_TOOL, MAKE_ROOM, MAX_STEPS, TIERS, CLASSES };
