'use strict';
// SkillSpace (src/rl/skill_space.js) plus what the v2 experts were trained with (tools/sim/src/scan.rs, obs.rs): the scan of target cells (here: the one cell the caller names, group
// `way`), scan moves (a move_to toward the target from the reachable cell nearest to it, flagged in feat[7]), the progress of every move/tunnel toward the target and `seen`
// (the bot stood near the destination in its last 24 commands). Everything is computed on the same integer feet cells as the simulator.
const Vec3 = require('vec3');
const { SkillSpace, K, CAND_F } = require('../rl/skill_space');
const { tunnelCells } = require('../skills/commands/block');
const F = require('../../models/experts/features.json');

const NG = F.groups.length, M = F.M, WAY = F.groups.indexOf('way');
const R = 64, SEEN_KEEP = 24;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const clip = (x) => Math.max(-1, Math.min(1, x));
const d3 = (a, b) => Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);

class ExpertSpace extends SkillSpace {
    constructor(bot, voc) { super(bot, voc); this.target = null; this.recent = []; }
    /** The cell the experts walk to (group `way`), or null. */
    setTarget(t) { this.target = t ? { x: t.x, y: t.y, z: t.z } : null; }
    /** Call before each command: the cell the bot stands in (it enters the `seen` memory). */
    remember(cell) { this.recent.push({ x: cell.x, y: cell.y, z: cell.z }); if (this.recent.length > SEEN_KEEP) this.recent.shift(); }
    here() { const p = this.bot.entity.position; return { x: Math.floor(p.x), y: Math.floor(p.y + 0.2), z: Math.floor(p.z) }; }

    candidates() {
        const base = super.candidates(), wait = base[base.length - 1], rest = base.slice(0, -1), t = this.target;
        if (!t) return base;
        const me = this.here(), now = d3(me, t) ** 2;
        let best = null;
        for (const n of this.lastNodes || []) { const d = (t.x - n[0]) ** 2 + (t.y - n[1]) ** 2 + (t.z - n[2]) ** 2; if (!best || d < best.d) best = { d, q: n }; }
        if (best && best.d + 1 <= now) {
            const [x, y, z] = best.q, f = this.feat(new Vec3(x + 0.5, y, z + 0.5)); f[7] = 1;
            rest.push({ cmd: 'move_to', args: { x, y, z }, item: 0, ent: 0, feat: f });
        }
        return rest.concat([wait]).slice(0, K);
    }

    observe(progress, last, killed, clock) {
        const o = super.observe(progress, last, killed, clock), me = this.here(), t = this.target;
        const scan = new Array(NG * M * 5).fill(0);
        if (t) { const b = WAY * M * 5; scan.splice(b, 5, r4(clip((t.x - me.x) / R)), r4(clip((t.y - me.y) / R)), r4(clip((t.z - me.z) / R)), r4(Math.min(d3(me, t) / R, 1)), 1); }
        const dest = (c) => {
            if (c.cmd === 'move_to') return c.args;
            if (c.cmd === 'tunnel') return tunnelCells(me, c.args.dir, c.args.dy).to;
            return null;
        };
        const seen = (q) => (this.recent.filter((p) => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 + (p.z - q.z) ** 2 <= 2.25).length / 4);
        const rows = [], sn = [];
        for (let k = 0; k < K; k++) {
            const c = this.cands[k], q = c && dest(c), row = new Array(NG).fill(0);
            if (q && t) row[WAY] = r4(clip((d3(me, t) - d3(q, t)) / 16));
            rows.push(row); sn.push(q ? r4(Math.min(seen(q), 1)) : 0);
        }
        return { ...o, scan, cand_scan: rows, cand_seen: sn };
    }
}

module.exports = { ExpertSpace, WAY, d3, CAND_F };
