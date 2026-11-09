'use strict';
// moe/features.py in JavaScript: an observation (the simulator's, or SkillSpace's plus the scan fields of scan.js) -> the context vector and the candidate rows of an expert.
// The numbers must equal the Python ones (tests/test_experts_pure.js checks 28 recorded observations against the trained policies).
const F = require('../../models/experts/features.json');

const CMD = Object.fromEntries(F.cmds.map((c, i) => [c, i]));
const NG = F.groups.length, M = F.M, T = F.T, TGT = 5 + NG, GRID_LAYERS = F.GRID_LAYERS, N_CAT = F.N_CAT, N_REASON = F.N_REASON, K = F.K, N_CMD = F.N_CMD;
const NCORE = F.core.length;
const CORE_IX = new Map(F.core.map((n, i) => [n, i]));
const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Per-vocabulary tables: item index -> core slot (NCORE = other), log/planks flags, the scan group of the block (-1 none). Cached per names array. */
const tables = new WeakMap();
function tablesFor(names) {
    let t = tables.get(names);
    if (t) return t;
    const coreOf = new Int32Array(names.length).fill(NCORE), isLog = new Uint8Array(names.length), isPlanks = new Uint8Array(names.length), groupOf = new Int32Array(names.length).fill(-1);
    names.forEach((n, i) => {
        if (CORE_IX.has(n)) coreOf[i] = CORE_IX.get(n);
        isLog[i] = n.endsWith('_log') || n.endsWith('_stem') ? 1 : 0; isPlanks[i] = n.endsWith('_planks') ? 1 : 0;
        if (isLog[i]) groupOf[i] = 0; else if (n === 'coal_ore' || n === 'deepslate_coal_ore') groupOf[i] = 1; else if (n === 'iron_ore' || n === 'deepslate_iron_ore') groupOf[i] = 2;
    });
    coreOf[0] = NCORE;
    t = { coreOf, isLog, isPlanks, groupOf }; tables.set(names, t);
    return t;
}

/** {item index: count} of the pack (the observation stores count / 64). */
function inventory(o) {
    const inv = new Map();
    for (let k = 0; k < o.inv_item.length; k++) { const i = o.inv_item[k]; if (i) inv.set(i, (inv.get(i) || 0) + Math.round(o.inv_count[k] * 64)); }
    return inv;
}

/** The T nearest scanned cells of the groups in `rel`: rows [dx, dy, dz, dist, present, group one-hot] flattened, and the group of the nearest (or -1). */
function targets(o, rel, anon = false) {
    const out = new Float64Array(T * TGT);
    if (!rel.length || !o.scan) return { out, g: -1 };
    const rows = [];
    for (const g of rel) for (let m = 0; m < M; m++) { const b = (g * M + m) * 5; if (o.scan[b + 4] > 0) rows.push({ d: o.scan[b + 3], g, b }); }
    rows.sort((a, b) => a.d - b.d);          // stable: ties keep the group order of `rel`
    rows.slice(0, T).forEach((r, i) => { for (let j = 0; j < 5; j++) out[i * TGT + j] = o.scan[r.b + j]; if (!anon) out[i * TGT + 5 + r.g] = 1; });
    return { out, g: rows.length ? rows[0].g : -1 };
}

/** The context vector (length F.ctx_dim) of an observation for an expert that is shown the scan groups `rel`. `names`: vocabulary (index -> item name). */
function ctx(o, names, rel = [], anon = false) {
    const t = tablesFor(names), inv = new Float64Array(NCORE + 1);
    let logs = 0, planks = 0;
    for (const [i, n] of inventory(o)) { inv[t.coreOf[i]] += n; if (t.isLog[i]) logs += n; if (t.isPlanks[i]) planks += n; }
    for (let i = 0; i < inv.length; i++) inv[i] = Math.min(inv[i] / 64, 1);
    const tot = [Math.min(logs / 64, 1), Math.min(planks / 64, 1)];
    const per = o.grid.length / GRID_LAYERS, hist = new Float64Array(GRID_LAYERS * N_CAT);
    for (let l = 0; l < GRID_LAYERS; l++) for (let j = 0; j < per; j++) hist[l * N_CAT + clip(o.grid[l * per + j], 0, N_CAT - 1)] += 1 / Math.max(per, 1);
    const n = o.view_cat.length, catCnt = new Float64Array(N_CAT), catMin = new Float64Array(N_CAT).fill(1), itemCnt = new Float64Array(NCORE + 1), itemMin = new Float64Array(NCORE + 1).fill(1);
    for (let r = 0; r < n; r++) {
        const c = o.view_cat[r], d = o.view_dist[r], it = o.view_item[r];
        catCnt[clip(c, 0, N_CAT - 1)] += 1 / n;
        if (it === 0 && c === 0) continue;
        const ci = Math.min(c, N_CAT - 1); catMin[ci] = Math.min(catMin[ci], d);
        const k = t.coreOf[it]; itemCnt[k] += 1 / n; itemMin[k] = Math.min(itemMin[k], d);
    }
    const ent = []; for (const row of o.ent_feat) for (const v of row) ent.push(v);
    const reason = new Float64Array(N_REASON); reason[Math.min(Math.trunc(o.last_reason), N_REASON - 1)] = 1;
    const relv = new Float64Array(NG); if (!anon) for (const g of rel) relv[g] = 1;
    const tg = targets(o, rel, anon).out;
    const parts = [o.self, o.clock, inv, tot, hist, catCnt, catMin, itemCnt, itemMin, ent, reason, [Math.min(o.dt_ticks / 100, 5)], relv, tg];
    const out = new Float64Array(F.ctx_dim); let p = 0;
    for (const a of parts) for (const v of a) out[p++] = v;
    if (p !== F.ctx_dim) throw new Error(`ctx has ${p} numbers, the model wants ${F.ctx_dim}`);
    return out;
}

/**
 * The K candidate rows and the mask. `actions`: command indices the expert may use (wait is always left); candidates that walk to or mine a log / coal / iron block of a group
 * not in `rel` are masked. Last two columns: `seen` (the bot stood near the destination in its last 24 commands) and the progress toward the nearest relevant target.
 */
function cands(o, names, rel = [], anon = false, actions = null) {
    const t = tablesFor(names), out = new Float64Array(K * F.cand_dim), mask = new Array(K).fill(false), inv = inventory(o);
    const base = N_CMD + NCORE + 1, relNat = rel.filter((g) => g < 3), allow = actions ? new Set([...actions, CMD.wait]) : null;
    const { g } = targets(o, rel, anon);
    for (let k = 0; k < K; k++) {
        const cmd = o.cand_cmd[k], item = o.cand_item[k];
        let ok = !!o.cand_mask[k] && cmd > 0;
        if (ok && allow && !allow.has(cmd)) ok = false;
        const grp = t.groupOf[item];
        if (ok && (cmd === 1 || cmd === 2) && grp >= 0 && !relNat.includes(grp)) ok = false;
        mask[k] = ok;
        if (!ok) continue;
        const row = k * F.cand_dim;
        out[row + clip(cmd, 0, N_CMD - 1)] = 1; out[row + N_CMD + t.coreOf[item]] = 1;
        out[row + base] = o.cand_ent[k] > 0 ? 1 : 0;
        for (let j = 0; j < 8; j++) out[row + base + 1 + j] = o.cand_feat[k][j];
        out[row + base + 9] = item ? Math.min((inv.get(item) || 0) / 64, 1) : 0;
        if (o.cand_seen) out[row + base + 10] = o.cand_seen[k];
        if (o.cand_scan && rel.length && g >= 0) out[row + base + 11] = o.cand_scan[k][g];
    }
    return { cand: out, mask };
}

module.exports = { ctx, cands, targets, inventory, CMD, K, NG, M, T, GROUPS: F.groups };
