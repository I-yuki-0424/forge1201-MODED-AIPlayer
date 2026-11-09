'use strict';
// The final sweep of an open pit (owner 2026-11-09: "there are unignorable amounts of unmined blocks left behind ... the completion check does not seem to work ... once digging
// reaches the bottom, check the assigned chunks from the top and issue mining orders for whatever remains").
// Why the old check missed them (read from the code): `pit.audit` judges a cell only when the bot's world model has it, and a bot knows only the chunks within its view distance
// (4). With many chunks in a job, most of the pit was "unknown" to the one bot that ran the last audit, and unknown cells are skipped, not failed. So the sweep goes to the
// chunk first (a walk in legs until it is loaded), then reads every finished unit of it from the top layer down and sends each unit that still holds a block back to work.
// The reopened units are the "mining orders": the ledger hands them out again, top layer first (layers below wait), and the chunk is looked at again once they are done.
// Chunks are shared between the bots that finish: each bot takes the nearest chunk nobody is looking at. Pure apart from `env` (w, pos, travel); the tests drive it.
const { DONE } = require('./crew');

const SWEEP_ROUNDS = 5;        // looks at one chunk (the first, and again after each round of repairs) before it is left as it is
const SWEEP_REOPEN_MAX = 5;    // times one unit is sent back (the inline audit stops at 3: something that keeps refilling is reported, not dug forever)
const YIELD_EVERY = 150;       // units read between two turns of the event loop (every bot lives in this process, see hazards)
const near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * @param plan       planPit(...) (regions with anchor and meta {x0, x1, z0, z1, top, bottom})
 * @param ledger     the crew ledger of the job
 * @param state      the audit's { counts: Map("region:unit" -> times sent back) }, shared so that the two checks count together
 * @param cellState  (plan, region, unit, world) -> { wrong: [cells], unknown: n } (pit.js)
 * @returns async sweep(env, now) -> { region: id | null, checked, reopened, gaveUp, unknown, travelled?, first?, busy, round }; `region: null` = nothing to look at right now
 *          (`busy`: another bot is looking at one, which may send units back: wait for it).
 */
function makeSweeper({ plan, ledger, state, cellState, rounds = SWEEP_ROUNDS, maxReopen = SWEEP_REOPEN_MAX }) {
    const byId = new Map(plan.regions.map((r) => [r.id, r])), todo = new Set(byId.keys()), busy = new Set(), seen = new Map();
    const turn = () => new Promise((r) => setImmediate(r));

    async function look(region, env, now) {
        const res = { region: region.id, checked: 0, reopened: 0, gaveUp: 0, unknown: 0 }, reg = ledger.regions.get(region.id);
        if (!reg || !reg.doneN) return res;
        const w = env.w, m = region.meta, cx = (m.x0 + m.x1) >> 1, cz = (m.z0 + m.z1) >> 1;
        // The chunk must be in the bot's world model, else every cell reads "unknown" and nothing is judged: walk toward it (legs inside the loaded area) until it is.
        const loaded = () => w.kindAt(cx, m.top, cz) !== 'unknown' && w.kindAt(cx, m.bottom, cz) !== 'unknown';
        if (!loaded() && env.travel) { const t = await env.travel({ x: cx, z: cz }, { near: 20 }); res.travelled = t.ok ? t.legs : t.reason; }
        for (let u = 0; u < reg.n; u++) {                                  // unit order = layer order: the top layer first
            if (u && u % YIELD_EVERY === 0) await turn();
            if (reg.state[u] !== DONE) continue;
            res.checked++;
            const c = cellState(plan, region, u, w);
            res.unknown += c.unknown;
            if (!c.wrong.length) continue;
            const key = `${region.id}:${u}`, n = state.counts.get(key) || 0;
            if (n >= maxReopen) { if (n === maxReopen) { state.counts.set(key, n + 1); res.gaveUp++; res.first = res.first || { unit: u, cells: c.wrong.slice(0, 4), gaveUp: true }; } continue; }
            if (ledger.reopen(region.id, u, now)) { state.counts.set(key, n + 1); res.reopened++; res.first = res.first || { unit: u, cells: c.wrong.slice(0, 4) }; }
        }
        return res;
    }

    return async function sweep(env, now) {
        const from = env.pos ? env.pos() : { x: 0, z: 0 };
        const region = [...todo].filter((id) => !busy.has(id)).map((id) => byId.get(id)).sort((a, b) => near(a.anchor, from) - near(b.anchor, from))[0];
        if (!region) return { region: null, busy: busy.size > 0, checked: 0, reopened: 0, gaveUp: 0, unknown: 0 };
        todo.delete(region.id); busy.add(region.id);
        let res;
        try { res = await look(region, env, now); } finally { busy.delete(region.id); }
        const n = (seen.get(region.id) || 0) + 1; seen.set(region.id, n);
        if ((res.reopened || res.unknown) && n < rounds) todo.add(region.id);        // sent back: look again when they are done; not readable: try to get there again
        return { ...res, busy: busy.size > 0, round: n };
    };
}

module.exports = { makeSweeper, SWEEP_ROUNDS, SWEEP_REOPEN_MAX };
