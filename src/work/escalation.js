'use strict';
// BOT mechanism side of the router + skill-policy architecture (DPOD integrations/botsystem/experts, DESIGN.md): when its command
// sequences cannot carry a goal out (an amount too large for `gather`, say) the mechanism may ask the router which expert answers.
// This file only BUILDS the request and READS the decision, in the closed form DPOD validates (same limits). It is not wired into any
// job and no expert exists yet (owner 2026-11-06: not on the learning queue); the inventory is what the bot itself holds, nothing else.
const GOAL_ID = /^[a-z][a-z0-9_]{1,40}$/;
const NAME = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/;
const MAX_AMOUNT = 2304, MAX_ITEMS = 512, MAX_WHY = 200;

/** One request line (a JSON string with a trailing newline). Throws on anything DPOD would refuse. */
function buildRequest({ runId, seq, goalId, amount, inventory, why = '' }) {
    if (typeof runId !== 'string' || !runId) throw new Error('runId');
    if (!Number.isInteger(seq) || seq < 0) throw new Error('seq must be a non-negative integer');
    if (!GOAL_ID.test(goalId || '')) throw new Error('bad goalId');
    if (!Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) throw new Error(`amount 1..${MAX_AMOUNT}`);
    const inv = {};
    for (const [k, v] of Object.entries(inventory || {})) {
        if (!NAME.test(k) || !Number.isInteger(v) || v < 0 || v > 1e6) throw new Error(`bad inventory entry ${k}`);
        if (v > 0) inv[k] = v;
    }
    if (Object.keys(inv).length > MAX_ITEMS) throw new Error('inventory too large');
    return JSON.stringify({ v: 1, type: 'escalate', run_id: runId, seq, goal_id: goalId, amount, inventory: inv, why: String(why).slice(0, MAX_WHY) }) + '\n';
}

/** The decision for `seq`: {expert: string|null, setup: [goalId], reason}. Anything else is an error (the router is not trusted blindly either). */
function readDecision(line, { runId, seq }) {
    let m; try { m = JSON.parse(line); } catch (_) { throw new Error('decision is not JSON'); }
    if (!m || m.v !== 1 || m.type !== 'route' || m.run_id !== runId || m.seq !== seq) throw new Error('not the decision for this request');
    if (m.expert !== null && (typeof m.expert !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(m.expert))) throw new Error('bad expert id');
    if (!Array.isArray(m.setup) || m.setup.length > 8 || !m.setup.every((g) => GOAL_ID.test(g))) throw new Error('bad setup list');
    if (typeof m.reason !== 'string' || m.reason.length > 120) throw new Error('bad reason');
    return { expert: m.expert, setup: m.setup, reason: m.reason };
}

module.exports = { buildRequest, readDecision, MAX_AMOUNT };
