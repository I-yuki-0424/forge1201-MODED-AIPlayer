'use strict';
// Simple scripts for the pure bots (owner 2026-11-06): several commands with a few if-statements, so that somewhat complicated things
// that need no learning run by themselves on dozens of bots at once. Example: dig the range; IF there is no usable tool > IF there are
// iron ingots and sticks (or sticks can be made) > craft what is missing at a crafting table > go back to work.
//
// A script is plain JSON (stored one file per script, or built in):  { "name": "...", "steps": [ STEP, ... ] }
//   STEP  { "cmd": "craft", "args": {...}, "at": "tools", "table": true, "optional": true }   one command of the action layer (or "pillar")
//           "at": a tagged block's name, or a purpose (the nearest one): its x, y, z are added to the arguments; "table": the crafting table placed by `station`
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
const { approach } = require('./reach');

const MAX_STEPS = 200, MAX_DEPTH = 8;
const WORK_MOVES = new Set(['pillar', 'take_usable']);
const SITE_REF = /^[a-z0-9][a-z0-9_-]{1,23}$/;           // a tagged block by name, or a purpose (tools, ore, any ...)
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
const CLASSES = new Set(['pickaxe', 'axe', 'shovel', 'sword', 'hoe']);
const STEP_KEYS = new Set(['go_back', 'cmd', 'args', 'at', 'table', 'furnace', 'optional', 'gather', 'make_planks', 'if', 'then', 'else', 'take', 'take_tool', 'put_away', 'station', 'release_station', 'leave_pit', 'return', 'log']);
const COND_KEYS = new Set(['has', 'tool', 'usable', 'harvests', 'can_craft', 'site', 'free_slots', 'in_pit', 'planks', 'logs', 'all', 'any', 'not']);
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
                if (s.at !== undefined && !SITE_REF.test(s.at)) bad('at: a tagged block (its name) or a purpose');
            } else if (s.take !== undefined) {
                const t = s.take; if (!t || typeof t.item !== 'string' || !ITEM.test(t.item) || !SITE_REF.test(t.from || '') || !(t.count === undefined || (Number.isInteger(t.count) && t.count >= 1 && t.count <= 2304))) bad('take: {item, count?, from: tag}');
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
    const st = { steps: 0, log: [], table: null, miss: new Set() };      // miss: "item@x,y,z" of containers this run found without the item
    // What one bot found, all find: a container without the item is not asked again by the next bot for `ttl` (env.stockMiss, shared by the service). Twenty bots at the start each visited
    // the one tools chest for a sword, an axe and a shovel it never held: 60 visits through a one-door line, 18 bots waiting at once (live 2026-11-09).
    const shared = env.stockMiss || null;
    const missed = (k) => st.miss.has(k) || !!(shared && shared.has(k));
    const markMiss = (k) => { st.miss.add(k); if (shared) shared.add(k); };
    const note = (m) => { if (st.log.length < 60) st.log.push(String(m).slice(0, 160)); };
    const result = (ended, extra = {}) => ({ ok: ended === 'ok' || ended === 'end', ended, steps: st.steps, log: st.log, ...extra });
    const site = (tag) => (env.sites ? (env.sites.pick ? env.sites.pick(tag, env.pos ? env.pos() : null) : env.sites.find(tag, env.pos ? env.pos() : null)) : null);
    const sourcesOf = (prefer) => (env.sites ? (env.sites.sources ? env.sites.sources(env.pos ? env.pos() : null, prefer) : [env.sites.pick(prefer, env.pos ? env.pos() : null)].filter(Boolean)) : []);
    const reachText = () => `${Math.round(((env.sites && env.sites.reach) || 160) / 16)} chunks`;
    const command = async (name, args, { table = false, furnace = false, at = null, atSite = null } = {}) => {
        let a = { ...(args || {}) };
        if (atSite) a = { ...a, x: atSite.x, y: atSite.y, z: atSite.z };
        else if (at) { const s = site(at); if (!s) return { ok: false, reason: 'invalid_target', detail: { why: `no site tagged ${at} within ${reachText()}` } }; a = { ...a, x: s.x, y: s.y, z: s.z }; }
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
                // Containers come FIRST (owner 2026-11-09): every one within 10 chunks, Ender Storage before chests, the asked purpose before the rest, nearest first; a chest that
                // is out of the bot's layer is gone to (reach.js). Only when none has it does the script go on to craft or gather.
                const t = s.take, want = t.count || 1, srcs = sourcesOf(t.from).slice(0, 6), why = [];
                res = srcs.length ? { ok: false, reason: 'missing_item', detail: { why: `no container has ${t.item}`, tried: why } } : { ok: false, reason: 'invalid_target', detail: { why: `no container within ${reachText()} (tagged ${t.from})` } };
                for (const chest of srcs) {
                    const k = `${t.item}@${chest.x},${chest.y},${chest.z}`;
                    if (missed(k)) continue;                                         // this run already found the chest without it
                    const a = await approach(env, chest, { why: `to take ${t.item}` });
                    if (a) { why.push(`${chest.name}: ${a.reason}`); if (['died', 'disconnected', 'cancelled'].includes(a.reason)) { res = a; break; } continue; }
                    let r = await command('withdraw', { item: t.item, count: want }, { atSite: chest });
                    if (!r.ok && r.reason === 'missing_item' && want > 1) r = await command('withdraw', { item: t.item, count: 1 }, { atSite: chest });      // fewer than asked: what there is
                    if (r.ok) { res = r; note(`took ${t.item} from ${chest.name}`); break; }
                    if (r.reason === 'missing_item') markMiss(k);
                    why.push(`${chest.name}: ${r.reason}`);
                    if (['died', 'disconnected', 'cancelled'].includes(r.reason)) { res = r; break; }
                }
                note(`take ${t.item} (${t.from}): ${res.ok ? 'ok' : res.reason}`);
            } else if (s.take_tool !== undefined) {
                // Usable tools of the class from the containers (take_usable: not worn out, best tier, most uses left), never a worn one, until the bot holds `until` of them
                // (default 1). The tools chests first, then every other container within 10 chunks; a chest in another layer is gone to (reach.js), one that fails is passed over.
                const { class: cls, from, until = 1 } = s.take_tool, usable = () => (env.usableCount ? env.usableCount(cls) : toolOf(cls, env) ? 1 : 0);
                const chests = sourcesOf(from).slice(0, 4);
                res = { ok: usable() >= until };
                if (!res.ok && !chests.length) { res = { ok: false, reason: 'invalid_target', detail: { why: `no container within ${reachText()} (tagged ${from})` } }; note(res.detail.why); }
                else if (!res.ok) {
                    const why = [];
                    for (const chest of chests) {
                        if (usable() >= until) break;
                        const k = `${cls}@${chest.x},${chest.y},${chest.z}`;
                        if (missed(k)) continue;
                        const a = await approach(env, chest, { why: `to take a ${cls}` });
                        if (a) { why.push(`${chest.name}: ${a.reason}`); if (['died', 'disconnected', 'cancelled'].includes(a.reason)) { res = a; break; } continue; }
                        for (let n = 0; n < 6 && usable() < until; n++) {
                            const r = await command('take_usable', { class: cls }, { atSite: chest });
                            if (r.ok) { note(`took a ${cls}${r.detail && r.detail.item ? ` (${r.detail.item}, ${r.detail.left} uses left)` : ''} from ${chest.name}`); continue; }
                            if (['died', 'disconnected', 'cancelled'].includes(r.reason)) { res = r; break; }
                            if (r.reason === 'missing_item') markMiss(k);
                            why.push(`${chest.name}: ${r.reason === 'missing_item' ? `no usable ${cls}${r.detail && r.detail.worn ? ` (${r.detail.worn} worn out)` : ''}` : r.reason}`);
                            break;
                        }
                        if (res.reason === 'died' || res.reason === 'disconnected' || res.reason === 'cancelled') break;
                    }
                    if (usable()) res = { ok: true };
                    else if (!res.reason) { res = { ok: false, reason: 'missing_item', detail: { why: `no usable ${cls} from the containers: ${why.join('; ') || 'none reachable'}` } }; note(res.detail.why); }
                }
            } else if (s.gather !== undefined) {
                res = env.gather ? await env.gather({ target: s.gather.target, count: s.gather.count || 4, radius: s.gather.radius || 24 }) : { ok: false, reason: 'invalid_args', detail: { why: 'no gathering here' } };
                note(`gather ${s.gather.target}: ${res.ok ? 'ok' : res.reason}`);
            } else if (s.make_planks !== undefined) {
                const log = firstItem(env, /_(log|stem|hyphae)$/);
                res = log ? await env.exec('craft', { item: log.replace(/_(log|stem|hyphae)$/, '_planks'), count: Math.max(4, Math.min(s.make_planks, 4 * (env.have ? env.have(log) : 4))) }) : { ok: false, reason: 'missing_item', detail: { why: 'no log to make planks from' } };
                note(`planks from ${log || 'nothing'}: ${res.ok ? 'ok' : res.reason}`);
            } else if (s.put_away) {
                res = env.policy ? await janitor.maintain(env, { ...env.policy, freeTarget: 36, sites: env.sites || env.policy.sites }) : { ok: true };
            } else if (s.station) {
                res = await placeStation(env, st, s.station);
                note(`${s.station.replace('_', ' ')} ${res.ok ? 'placed' : res.reason}`);
            } else if (s.release_station) {
                // Both stations come back into the pack (owner 2026-11-09: a furnace and a table per tool replacement filled the surface). A table or furnace that cannot be
                // taken back stays remembered (env.stations) and is used again by the next run instead of a new one being placed.
                for (const k of ['table', 'furnace']) {
                    if (!st[k]) continue;
                    const kind = k === 'table' ? 'crafting_table' : 'furnace', r = await env.exec('mine', { ...st[k] });
                    if (r.ok) { if (env.stations) delete env.stations[kind]; st[k] = null; note(`${kind.replace('_', ' ')} taken back`); }
                    else { note(`${kind.replace('_', ' ')} stays: ${r.reason}`); if (k === 'table') res = r; }
                }
            } else if (s.leave_pit) {
                if (!st.origin && env.here) st.origin = { ...env.here() };                    // where the bot stood: `go_back` returns there
                res = env.box && env.leavePit ? await env.leavePit(env.box) : { ok: false, reason: 'invalid_target', detail: { why: 'not in a pit job' } };
                // Not in a pit and nothing to walk to (a sealed pocket, a hole in the hill): put the bot on a cell with a way out near where it stands.
                if (!res.ok && res.reason === 'unreachable' && env.lift && env.here) { const l = await env.lift(env.here(), { radius: 8, up: 2, down: 1 }); if (l.ok) res = { ok: true, how: 'lifted out of a pocket' }; }
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

/** The remembered station of this kind, when the block is still there and within a short walk (12 blocks across, 4 up or down); else null. */
function recallStation(env, kind) {
    const m = env.stations && env.stations[kind];
    if (!m || !env.w || !env.here) return null;
    const h = env.here();
    if (env.w.nameAt(m.x, m.y, m.z) !== kind) { delete env.stations[kind]; return null; }       // taken away or broken since
    return Math.abs(h.x - m.x) <= 12 && Math.abs(h.z - m.z) <= 12 && Math.abs(h.y - m.y) <= 4 ? { x: m.x, y: m.y, z: m.z } : null;
}

/** A crafting table or a furnace beside the bot: placed from the inventory, made first when there is none (planks / 8 cobblestone). Sets st.table or st.furnace to its x, y, z. */
async function placeStation(env, st, kind = 'crafting_table') {
    // Already placed by an earlier step of this script (the furnace needed the table first) and the bot has not walked off: use it again instead of asking for another.
    const placed = st[kind === 'furnace' ? 'furnace' : 'table'];
    // A station of an earlier run (kept in env.stations, see release_station) that is still there and near: use it, do not place and craft another.
    const known = !placed && recallStation(env, kind);
    if (known) { st[kind === 'furnace' ? 'furnace' : 'table'] = known; return { ok: true, reused: true, remembered: true }; }
    if (placed && env.here) { const h = env.here(); if (Math.abs(h.x - placed.x) <= 3 && Math.abs(h.y - placed.y) <= 3 && Math.abs(h.z - placed.z) <= 3) return { ok: true, reused: true }; }
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
    const spots = [janitor.shulkerSpot(env.w, env.here()), ...janitor.freeSpots(env.w, env.here()), ...janitor.attachSpots(env.w, env.here())].filter(Boolean);
    if (!spots.length) return { ok: false, reason: 'invalid_target', detail: { why: `no free cell near the bot for a ${kind.replace('_', ' ')}` } };
    let p = { ok: false, reason: 'invalid_target' }, spot = null;
    for (const c of spots.slice(0, 6)) { spot = c; p = await env.exec('place', { x: c.x, y: c.y, z: c.z, item: kind }); if (p.ok) break; if (['died', 'disconnected', 'cancelled'].includes(p.reason)) break; }
    if (p.ok) {
        st[kind === 'furnace' ? 'furnace' : 'table'] = { x: spot.x, y: spot.y, z: spot.z };          // only the coordinates: the rest would reach the craft command as an unknown argument
        if (env.stations) env.stations[kind] = { x: spot.x, y: spot.y, z: spot.z };
    }
    return p;
}

/**
 * A routine (owner 2026-11-08): the same script over and over until it is stopped, no policy, nothing decided. A round that fails is repeated after a longer
 * pause (2, 4, 8 ... up to 16 times the pause); five rounds in a row that fail end it (the reason is the last one's). A round that has nothing to do (an empty chest)
 * ends well and the next one starts after the pause, so a routine waits for work instead of ending.
 * `onRound({rounds, fails, last})` reports progress. Returns {ok, ended: 'stopped' | 'gave_up', rounds, reason?, log}.
 */
async function runLoop(script, env, { cancel = { cancelled: false }, pauseMs = 2000, stopAfterFails = 5, onRound = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let rounds = 0, fails = 0, last = null;
    while (!cancel.cancelled) {
        last = await runScript(script, env, { cancel });
        if (last.ended === 'cancelled') break;
        rounds++; fails = last.ok ? 0 : fails + 1;
        onRound({ rounds, fails, last });
        if (fails >= stopAfterFails) return { ok: false, ended: 'gave_up', rounds, reason: last.reason || last.ended, log: last.log };
        const wait = pauseMs * (fails ? Math.min(16, 2 ** fails) : 1);
        for (let t = 0; t < wait && !cancel.cancelled; t += 250) await sleep(Math.min(250, wait - t));
    }
    return { ok: true, ended: 'stopped', rounds, log: last ? last.log : [] };
}

// ------------------------------------------------------------------------------------------------------------------------ built in

/**
 * Tools the work layer makes by rule (owner 2026-11-09: the cobweb stopped bots for want of a sword, and only pickaxes could be made): per class the iron it takes, the sticks, and
 * the script's name (`replace-tool` stays the pickaxe's). Cobweb wants a sword, snow a shovel; an axe is faster on wood and a hoe is no work tool.
 */
const MAKE = Object.freeze({ pickaxe: { n: 3, sticks: 2 }, axe: { n: 3, sticks: 2 }, shovel: { n: 1, sticks: 2 }, sword: { n: 2, sticks: 1 } });
const MAKEABLE = Object.freeze(['pickaxe', 'sword', 'axe', 'shovel']);              // the order in which a block that several classes break is served
const toolScriptName = (cls) => (cls === 'pickaxe' ? 'replace-tool' : `replace-${cls}`);

/**
 * The owner's example for one class: no usable tool -> a free one from the containers -> else craft one (iron, sticks; stone; planks) -> back to work.
 * The pack holds what the tool is made of when it has the sticks and the iron (or raw iron and fuel, or cobblestone for a stone tool); then nothing is fetched from afar.
 */
function replaceScript(cls) {
    const m = MAKE[cls]; if (!m) throw new ScriptError(`no recipe for ${cls}`);
    const { n, sticks: sk } = m, has = (item, min) => ({ has: { item, min } }), ok = [{ return: 'ok' }], tool = { tool: cls };
    const craftable = { all: [has('stick', sk), { any: [
        has('iron_ingot', n),
        { all: [has('raw_iron', n), { any: [has('coal', 1), has('charcoal', 1), { planks: 3 }, { logs: 2 }] }] },
        { all: [{ harvests: `stone_${cls}` }, { any: [has('cobblestone', n), has('cobbled_deepslate', n)] }] },
    ] }] };
    const ingots = (then) => ({ if: { not: has('iron_ingot', n) }, then });
    return {
        name: toolScriptName(cls),
        steps: [
            { if: tool, then: ok },
            // 1. the containers (only a usable tool; the tools chests first, Ender Storage before chests; one in another layer is gone to)
            { take_tool: { class: cls, from: 'tools' }, optional: true },
            { if: tool, then: ok },
            // 1b. the containers are far above (the pit is deep) and the pack cannot make one: climb out (lift or pillar) and take what is needed up here; the crafting below also happens up
            // here, on open ground. The bot is not sent back: the next unit lifts it to its layer (a teleport back onto the spot it left put bots on one-block islands in the open pit).
            // Not when the pack already makes one (owner 2026-11-09: the bot climbed all the way up with the iron, the sticks and the cobblestone in its pack): that is crafted below.
            { if: { all: [{ site: 'tools' }, { not: craftable }] }, then: [
                { leave_pit: true, optional: true },
                { take_tool: { class: cls, from: 'tools', until: cls === 'pickaxe' ? 2 : 1 }, optional: true },
                // While the bot is up here: what it needs to make a tool down there (the chests are out of reach from the pit bottom).
                ingots([
                    { take: { item: 'iron_ingot', count: n, from: 'ore' }, optional: true },
                    ingots([{ take: { item: 'iron_ingot', count: n, from: 'any' }, optional: true }]),
                ]),
                { if: { any: [{ not: has('stick', 4) }, { all: [{ not: has('crafting_table', 1) }, { not: { planks: 4 } }] }] }, then: [
                    { take: { item: 'stick', count: 8, from: 'any' }, optional: true },
                    { if: { any: [{ not: has('stick', 4) }, { not: { planks: 6 } }] }, then: [
                        { if: { not: { planks: 6 } }, then: [
                            { if: { not: { logs: 3 } }, then: [{ gather: { target: 'oak_log', count: 4, radius: 24 }, optional: true }] },
                            { if: { not: { logs: 3 } }, then: [{ gather: { target: 'jungle_log', count: 4, radius: 24 }, optional: true }] },
                            { if: { not: { logs: 3 } }, then: [{ gather: { target: 'spruce_log', count: 4, radius: 24 }, optional: true }] },
                            { make_planks: 12, optional: true },      // as many as the logs in the pack give, up to 12 (one log: 4)
                        ] },
                        { if: { not: has('stick', 4) }, then: [{ cmd: 'craft', args: { item: 'stick', count: 8 }, optional: true }] },
                    ] },
                ] },
            ] },
            { if: tool, then: ok },
            // 2. made from what the bot carries or can fetch: sticks (planks <- logs <- a tree nearby), then iron (ingots, or raw iron smelted in a furnace) or stone
            { if: { not: has('stick', sk) }, then: [{ take: { item: 'stick', count: 4, from: 'any' }, optional: true }] },
            { if: { not: has('stick', sk) }, then: [
                { if: { not: { planks: 2 } }, then: [
                    // Trees are on the surface: from inside the pit the bot would walk to the wall in front of one and back (live pit 2026-11-07), so it does not look.
                    { if: { all: [{ not: { logs: 1 } }, { not: { in_pit: true } }] }, then: [{ gather: { target: 'oak_log', count: 2, radius: 24 }, optional: true }] },
                    { make_planks: 4, optional: true },
                ] },
                { cmd: 'craft', args: { item: 'stick', count: 4 }, optional: true },
            ] },
            ingots([
                { take: { item: 'iron_ingot', count: n, from: 'ore' }, optional: true },
                ingots([{ take: { item: 'iron_ingot', count: n, from: 'any' }, optional: true }]),
                { if: { all: [{ not: has('iron_ingot', n) }, has('raw_iron', n)] }, then: [
                    { station: 'furnace', optional: true },
                    { cmd: 'smelt', args: { item: 'raw_iron', count: n }, furnace: true, optional: true },
                ] },
            ]),
            { if: { all: [has('iron_ingot', n), has('stick', sk)] }, then: [
                { station: 'crafting_table' },
                { cmd: 'craft', args: { item: `iron_${cls}`, count: 1 }, table: true },
                { release_station: true },
                { if: tool, then: ok },
            ] },
            // 3. no iron: a stone tool from cobblestone mined on the way (a pickaxe of it breaks stone and iron ore)
            { if: { all: [{ harvests: `stone_${cls}` }, { any: [has('cobblestone', n), has('cobbled_deepslate', n)] }, has('stick', sk)] }, then: [
                { station: 'crafting_table' },
                { cmd: 'craft', args: { item: `stone_${cls}`, count: 1 }, table: true },
                { release_station: true },
                { if: tool, then: ok },
            ] },
            // 4. nothing else: a wooden tool from planks and sticks (a pickaxe of it breaks stone and cobblestone, so the bot can mine its way up to a stone one)
            { if: { all: [{ harvests: `wooden_${cls}` }, has('stick', sk), { planks: n }] }, then: [
                { station: 'crafting_table' },
                { cmd: 'craft', args: { item: `wooden_${cls}`, count: 1 }, table: true },
                { release_station: true },
                { if: tool, then: ok },
            ] },
            { return: 'fail' },
        ],
    };
}
const REPLACE_TOOL = replaceScript('pickaxe');

/** The tool classes that break `block` (from the registry's harvestTools: item names, last word), e.g. cobweb -> sword, shears. [] when any tool (or none) does. */
function toolClassesOf(registry, block) {
    const b = registry && registry.blocksByName && registry.blocksByName[String(block || '').replace(/^minecraft:/, '')];
    if (!b || !b.harvestTools) return [];
    return [...new Set(Object.keys(b.harvestTools).map((id) => registry.items[id] && registry.items[id].name).filter(Boolean).map((n) => n.split('_').pop()))];
}
/** The class a bot should MAKE to break `block`: the first of pickaxe, sword, axe, shovel among the classes that break it; null when only something the bot cannot make does (shears). */
const craftClassFor = (registry, block) => { const cs = toolClassesOf(registry, block); return MAKEABLE.find((c) => cs.includes(c)) || null; };

/**
 * A script that fetches an item the bot ran out of (the water rule's seal blocks, a block to stack with ...) from the containers, before the bot waits for the operator.
 * `detail` is the failed command's: `item`, or `tried` (the list of acceptable items, first choice first). Null when it names nothing to fetch.
 */
function fetchScript(detail) {
    const names = [];
    const add = (n) => { if (typeof n === 'string' && ITEM.test(n) && !names.includes(n)) names.push(n); };
    if (detail) { add(detail.item); if (Array.isArray(detail.tried)) detail.tried.forEach(add); }
    if (!names.length) return null;
    const steps = [];
    for (const n of names.slice(0, 10)) steps.push({ take: { item: n, count: 64, from: 'any' }, optional: true }, { if: { has: n }, then: [{ return: 'ok' }] });
    steps.push({ return: 'fail' });
    return validate({ name: 'fetch-item', steps });
}

/** At the start of a job (and whenever the bot passes the chest): hold three usable pickaxes, so that a worn one is replaced on the spot. */
const STOCK_TOOLS = {
    name: 'stock-tools',
    steps: [
        { take_tool: { class: 'pickaxe', from: 'tools', until: 3 }, optional: true },
        // Still fewer than three (the bot works deep in the pit, the chest is far above): climb out, fill up, be put back (the owner's tools chest first, before anything is crafted).
        { if: { not: { usable: { class: 'pickaxe', min: 3 } } }, then: [
            { leave_pit: true, optional: true },
            { take_tool: { class: 'pickaxe', from: 'tools', until: 3 }, optional: true },
        ] },
        // One sword, axe and shovel when a container has them (owner 2026-11-09): a cobweb needs a sword, and the bot makes the others itself when it has to (replace-sword ...).
        ...['sword', 'axe', 'shovel'].map((c) => ({ if: { not: { tool: c } }, then: [{ take_tool: { class: c, from: 'tools' }, optional: true }] })),
        // Sticks for pickaxes made in the pit (replace-tool): from the storage chest, else planks from a tree nearby (outside the pit only). Twelve sticks make six pickaxes.
        { if: { not: { has: { item: 'stick', min: 8 } } }, then: [
            { take: { item: 'stick', count: 12, from: 'any' }, optional: true },
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
/** Containers found without an item, remembered for `ttlMs` by every bot (a chest filled meanwhile is looked at again after that). Keys are "item@x,y,z". */
class Misses {
    constructor({ ttlMs = 120000, now = Date.now } = {}) { Object.assign(this, { ttlMs, now }); this.m = new Map(); }
    has(k) { const t = this.m.get(k); if (t === undefined) return false; if (this.now() - t > this.ttlMs) { this.m.delete(k); return false; } return true; }
    add(k) { this.m.set(k, this.now()); if (this.m.size > 500) for (const [key, t] of this.m) if (this.now() - t > this.ttlMs) this.m.delete(key); }
    get size() { return this.m.size; }
}

/** A full inventory: put everything away by the sites (ore, junk, storage), then carry on. */
const MAKE_ROOM = { name: 'make-room', steps: [{ put_away: true }, { return: 'ok' }] };
const BUILT_IN = new Map([[REPLACE_TOOL.name, validate(REPLACE_TOOL)], [MAKE_ROOM.name, validate(MAKE_ROOM)], [STOCK_TOOLS.name, validate(STOCK_TOOLS)],
    ...MAKEABLE.filter((c) => c !== 'pickaxe').map((c) => { const sc = replaceScript(c); return [sc.name, validate(sc)]; })]);

module.exports = { Misses, validate, runScript, runLoop, holds, placeStation, ScriptError, BUILT_IN, REPLACE_TOOL, STOCK_TOOLS, MAKE_ROOM, MAX_STEPS, TIERS, CLASSES, replaceScript, toolScriptName, toolClassesOf, craftClassFor, fetchScript, MAKE, MAKEABLE };
