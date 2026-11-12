'use strict';
// The command set: 15 commands over the player's primitive inputs (body.js), each with a closed argument schema and a
// tick budget. execute() validates, runs on the live clock (runner.js) and returns a result with a named reason.
// Reference: docs/implemented/SKILLS-v1.md.
const { run, SkillError, REASONS } = require('./runner');
const { moveTo, lookAt, mine, place, activate, tunnel } = require('./commands/block');
const { pickup, attack } = require('./commands/entity');
const { equip, eat, toss } = require('./commands/item');
const { craft, smelt, deposit, withdraw } = require('./commands/gui');
const { unmet } = require('./preconditions');

// Argument types. A trailing '?' marks an optional argument.
const TYPES = {
    int: (v) => Number.isInteger(v) && Math.abs(v) <= 30000000,
    entity: (v) => Number.isInteger(v) && v >= 0,
    name: (v) => typeof v === 'string' && /^[a-z0-9_]{1,64}$/.test(v),
    item: (v) => typeof v === 'string' && /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/.test(v),      // namespaced ids allowed (create:wrench)
    bool: (v) => typeof v === 'boolean',
    count: (v) => Number.isInteger(v) && v >= 1 && v <= 2304,
    dest: (v) => ['hand', 'off_hand', 'head', 'chest', 'legs', 'feet'].includes(v),
    dir: (v) => ['north', 'south', 'east', 'west'].includes(v),
    dy: (v) => v === -1 || v === 0 || v === 1,
};
// A budget that grows with the walk the command may have to do first: a fixed 1200 ticks ended every walk of about 100 blocks or more as `timeout` although the bot was moving the whole
// time (owner 2026-11-12, `place` {ticks: 1200, phase: walk}). `base` + 14 ticks per block beyond the first 5, at most 6000 (the trace cap). Targets without a cell (entities) keep `base`.
const walkTicks = (base) => (a, bot) => {
    if (!bot || !bot.entity || !Number.isInteger(a.x) || !Number.isInteger(a.z)) return base;
    const p = bot.entity.position, d = Math.hypot(a.x + 0.5 - p.x, (Number.isInteger(a.y) ? a.y - p.y : 0), a.z + 0.5 - p.z);
    return Math.min(6000, Math.max(base, Math.round(base + 14 * Math.max(0, d - 5))));
};
const XYZ = { x: 'int', y: 'int', z: 'int' };
const XYZ_OPT = { x: 'int?', y: 'int?', z: 'int?' };

const COMMANDS = {
    move_to: { fn: moveTo, args: XYZ, ticks: walkTicks(1200) },
    look_at: { fn: lookAt, args: { ...XYZ_OPT, entity: 'entity?' }, oneOf: [['x', 'y', 'z'], ['entity']], ticks: 40 },
    mine: { fn: mine, args: { ...XYZ, collect: 'bool?', blind: 'bool?' }, ticks: walkTicks(1200) },    // collect:false / blind:true are work-layer options (src/work), not offered to the RL policy
    tunnel: { fn: tunnel, args: { dir: 'dir', dy: 'dy' }, ticks: 2400 },
    place: { fn: place, args: { ...XYZ, item: 'item', fluid: 'bool?', temp: 'name?' }, ticks: walkTicks(1200) },    // namespaced ids allowed: pure bots place mod blocks (work/build.js)
    activate: { fn: activate, args: { ...XYZ, item: 'item?', sneak: 'bool?' }, ticks: walkTicks(600) },
    pickup: { fn: pickup, args: { entity: 'entity?', item: 'name?' }, oneOf: [['entity'], ['item']], ticks: 1200 },
    attack: { fn: attack, args: { entity: 'entity' }, ticks: 2400 },
    equip: { fn: equip, args: { item: 'item', dest: 'dest?' }, ticks: 100 },     // namespaced ids allowed: the router equips what `place` / `activate` need (create:wrench)
    eat: { fn: eat, args: { item: 'name?' }, ticks: 200 },
    toss: { fn: toss, args: { item: 'name', count: 'count' }, ticks: 400 },
    craft: { fn: craft, args: { item: 'name', count: 'count?', ...XYZ_OPT }, allOrNone: ['x', 'y', 'z'], ticks: 1200 },
    smelt: { fn: smelt, args: { item: 'name', count: 'count?', ...XYZ_OPT }, allOrNone: ['x', 'y', 'z'], ticks: (a) => 1200 + 200 * (a.count || 1) },
    // namespaced ids allowed (`create:limestone`): with the plain `name` type the pit's upkeep could not store any pack that held a mod item, and one such item stopped the whole deposit run (live pit 2026-11-09: the white Ender chest stayed empty)
    deposit: { fn: deposit, args: { item: 'item', count: 'count', ...XYZ }, ticks: 800 },
    withdraw: { fn: withdraw, args: { item: 'item', count: 'count', ...XYZ }, ticks: 800 },
};

/** Throws SkillError('invalid_args') unless `args` matches the command's schema exactly. */
function validateArgs(name, args) {
    const c = COMMANDS[name];
    if (!c) throw new SkillError('invalid_args', { why: `unknown command ${name}`, known: Object.keys(COMMANDS) });
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new SkillError('invalid_args', { why: 'args must be an object' });
    for (const k of Object.keys(args)) if (!(k in c.args)) throw new SkillError('invalid_args', { why: `unknown argument ${k}` });
    for (const [k, t] of Object.entries(c.args)) {
        const opt = t.endsWith('?'), type = t.replace('?', '');
        if (args[k] === undefined) { if (!opt) throw new SkillError('invalid_args', { why: `missing ${k}` }); continue; }
        if (!TYPES[type](args[k])) throw new SkillError('invalid_args', { why: `${k}=${JSON.stringify(args[k])} is not a valid ${type}` });
    }
    if (c.oneOf && c.oneOf.filter((g) => g.every((k) => args[k] !== undefined)).length !== 1) {
        throw new SkillError('invalid_args', { why: `give exactly one of ${c.oneOf.map((g) => g.join('+')).join(' | ')}` });
    }
    if (c.oneOf && c.oneOf.some((g) => g.some((k) => args[k] !== undefined) && !g.every((k) => args[k] !== undefined))) {
        throw new SkillError('invalid_args', { why: 'incomplete argument group' });
    }
    if (c.allOrNone && ![0, c.allOrNone.length].includes(c.allOrNone.filter((k) => args[k] !== undefined).length)) {
        throw new SkillError('invalid_args', { why: `give all or none of ${c.allOrNone.join(',')}` });
    }
}

/**
 * Run command `name` with `args`. Resolves to the runner's result ({ok, reason, detail, ticks, ms, phases, trace});
 * invalid arguments come back as reason 'invalid_args' without touching the game.
 */
async function execute(bot, name, args = {}, opts = {}) {
    try { validateArgs(name, args); } catch (e) {
        return { ok: false, reason: e.reason, detail: e.detail, ticks: 0, ms: 0, phases: [], trace: [] };
    }
    // `opts.atomic` (docs/implemented/COMMAND-STACK-v1.md): the instruction as the bottom of the stack. Its preconditions are checked first, from the current state alone; if one does not hold it
    // returns `precondition_failed` with each unmet one (and the measured value) before a single key is pressed, and it never walks, equips or swaps to satisfy them: the router decides that.
    if (opts.atomic) {
        const u = unmet(bot, name, args);
        if (u.length) return { ok: false, reason: 'precondition_failed', detail: { unmet: u }, ticks: 0, ms: 0, phases: [], trace: [] };
    }
    const c = COMMANDS[name];
    const maxTicks = opts.maxTicks || (typeof c.ticks === 'function' ? c.ticks(args, bot) : c.ticks);
    return run(bot, c.fn, args, { ...opts, maxTicks });
}

module.exports = { execute, validateArgs, COMMANDS, REASONS };
