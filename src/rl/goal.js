'use strict';
// RL goal, schema v1: the only thing the LLM front-end (TASK-20261030-008) will ever emit and the policy consumes.
// Here goals are fed directly (no LLM). A goal fixes the success predicate; shaping terms are logged separately.
//   {"v":1,"type":"reach","offset":[dx,dz],"tolerance":1.0,"max_steps":150}   walk to start + offset
//   {"v":1,"type":"collect","item":"oak_log","count":1,"max_steps":150}       hold `count` of `item` in the inventory
// Closed lists below are part of the observation contract; changing them changes the declared obs_spec.
const TYPES = ['reach', 'collect'];
const ITEMS = ['oak_log', 'oak_planks', 'stick', 'cobblestone', 'dirt', 'stone', 'coal', 'raw_iron',
    'iron_ingot', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'apple', 'bread', 'sand', 'gravel'];
const GOAL_DIM = TYPES.length + 3 + ITEMS.length + 1;
const DEFAULTS = { max_steps: 150, tolerance: 1.0 };
const REL_SCALE = 16;

class GoalError extends Error {}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const isInt = (x) => Number.isInteger(x);

/** Validate an untrusted goal object and return the normalised goal. Unknown fields are refused, not ignored. */
function validateGoal(g) {
    if (!g || typeof g !== 'object' || Array.isArray(g)) throw new GoalError('goal must be an object');
    if (g.v !== 1) throw new GoalError('unsupported goal version');
    if (!TYPES.includes(g.type)) throw new GoalError(`unknown goal type ${JSON.stringify(g.type)}`);
    const allowed = g.type === 'reach' ? ['v', 'type', 'offset', 'tolerance', 'max_steps'] : ['v', 'type', 'item', 'count', 'max_steps'];
    for (const k of Object.keys(g)) if (!allowed.includes(k)) throw new GoalError(`unknown field ${k} for ${g.type}`);
    const max_steps = g.max_steps ?? DEFAULTS.max_steps;
    if (!isInt(max_steps) || max_steps < 1 || max_steps > 2000) throw new GoalError('max_steps must be an integer in 1..2000');
    if (g.type === 'reach') {
        const o = g.offset;
        if (!Array.isArray(o) || o.length !== 2 || !o.every(isNum) || o.some((x) => Math.abs(x) > 64)) throw new GoalError('offset must be [dx, dz], each within 64');
        const tolerance = g.tolerance ?? DEFAULTS.tolerance;
        if (!isNum(tolerance) || tolerance < 0.5 || tolerance > 5) throw new GoalError('tolerance must be within 0.5..5');
        return { v: 1, type: 'reach', offset: [o[0], o[1]], tolerance, max_steps };
    }
    if (!ITEMS.includes(g.item)) throw new GoalError(`item ${JSON.stringify(g.item)} not in the closed item list`);
    if (!isInt(g.count) || g.count < 1 || g.count > 8) throw new GoalError('count must be an integer in 1..8');
    return { v: 1, type: 'collect', item: g.item, count: g.count, max_steps };
}

const clip = (x) => Math.max(-1, Math.min(1, x));

/** Fixed-length numeric view of the goal for the policy. Positions are relative to the bot, never absolute. */
function encodeGoal(goal, pos, origin) {
    const v = new Array(GOAL_DIM).fill(0);
    v[TYPES.indexOf(goal.type)] = 1;
    if (goal.type === 'reach') {
        v[2] = clip((origin.x + goal.offset[0] - pos.x) / REL_SCALE);
        v[4] = clip((origin.z + goal.offset[1] - pos.z) / REL_SCALE);
    } else {
        v[2 + 3 + ITEMS.indexOf(goal.item)] = 1;
        v[GOAL_DIM - 1] = Math.min(goal.count, 16) / 16;
    }
    return v;
}

/**
 * Reward and termination from a snapshot {pos, origin, inv:{item:count}, dead}.
 * `task` is the goal's own reward; `shaping` is a potential difference (reach only) and never changes what is optimal.
 */
function assess(goal, snap, prev) {
    if (snap.dead) return { task: -1, shaping: 0, terminated: true, outcome: 'dead' };
    if (goal.type === 'reach') {
        const dist = (s) => Math.hypot(s.origin.x + goal.offset[0] - s.pos.x, s.origin.z + goal.offset[1] - s.pos.z);
        const d = dist(snap);
        const ok = d <= goal.tolerance && Math.abs(snap.pos.y - snap.origin.y) <= 1.5;
        return { task: ok ? 1 : 0, shaping: prev ? (dist(prev) - d) / 10 : 0, terminated: ok, outcome: ok ? 'success' : 'running' };
    }
    const ok = (snap.inv[goal.item] || 0) >= goal.count;
    return { task: ok ? 1 : 0, shaping: 0, terminated: ok, outcome: ok ? 'success' : 'running' };
}

module.exports = { TYPES, ITEMS, GOAL_DIM, DEFAULTS, GoalError, validateGoal, encodeGoal, assess };
