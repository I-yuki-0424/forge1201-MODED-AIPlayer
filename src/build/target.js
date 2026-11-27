'use strict';
// What the box must hold when the build is done: every cell of the blueprint's box in world coordinates (air included: what stands there now and is not in the blueprint goes),
// each cell's normalised target state and its recipe, the portals (one lighting each), and the item types the build uses. Pure.
const nbt = require('prismarine-nbt');
const S = require('./state');
const R = require('./rules');
const P = require('./pistons');
const CT = require('../native/inventory/contents');

const AIR_ID = 0;

class Target {
    /**
     * @param bp      a Blueprint with air (litematic.place(..., {keepAir: true}).bp): { size: [sx, sy, sz], palette: [{name, props}], blocks: [{x, y, z, s, nbt?}] }
     * @param origin  world position of the blueprint's 0,0,0 (the box's minimum corner)
     */
    constructor(bp, origin) {
        const [sx, sy, sz] = bp.size;
        this.box = { x: origin.x, y: origin.y, z: origin.z, sx, sy, sz };
        this.n = sx * sy * sz;
        this.palette = [{ name: 'air', props: {} }];
        const pk = new Map([[S.str('air', {}), 0]]);
        const idOf = (st) => { const k = S.str(st.name, st.props); let i = pk.get(k); if (i === undefined) { i = this.palette.length; this.palette.push(st); pk.set(k, i); } return i; };
        this.t = new Uint16Array(this.n);                     // palette index per cell (0 = air)
        for (const b of bp.blocks) {
            const p = bp.palette[b.s];
            let te = null;
            if (b.nbt) { try { te = nbt.simplify(b.nbt); } catch (_) { te = null; } }
            this.t[this.idx(origin.x + b.x, origin.y + b.y, origin.z + b.z)] = idOf(S.normalise(p.name, p.props, te));
        }
        // recipes per cell (they look at neighbours: chest partners, the cell an observer watches)
        this.recipe = new Array(this.n).fill(null);
        this.items = new Map();                              // item -> cells that need it
        for (let i = 0; i < this.n; i++) {
            if (this.t[i] === AIR_ID) continue;
            const c = this.cell(i);
            const r = R.recipe(this.palette[this.t[i]], (dx, dy, dz) => this.at(c.x + dx, c.y + dy, c.z + dz));
            this.recipe[i] = r;
        }
        this.portals = this._portals();
        for (const p of this.portals) for (const i of p.cells) this.recipe[i] = null;        // the lighting stands for every portal cell
        for (let i = 0; i < this.n; i++) { const r = this.recipe[i]; if (r && r.item) this.items.set(r.item, (this.items.get(r.item) || 0) + 1 + (r.repeat || 0) + (r.again ? 1 : 0)); }
        if (this.portals.length) this.items.set('flint_and_steel', (this.items.get('flint_and_steel') || 0) + this.portals.length);
        // what the blueprint's containers hold (sorter filters: the owner's Nether blueprint, addendum 3): one goal per container and item, its slots set when the container
        // stands and every block does (the late stage: a filter hopper locks only once its circuit stands); its items are part of the bill
        this.contents = [];
        for (const g of CT.blueprintContainers(bp, origin)) {
            const per = new Map(); for (const c of g.args.contents) (per.get(c.item) || per.set(c.item, []).get(c.item)).push(c);
            for (const [item, slots] of per) {
                const count = slots.reduce((a, c) => a + c.count, 0);
                this.contents.push({ k: `contents@${g.x},${g.y},${g.z}:${item}`, x: g.x, y: g.y, z: g.z, i: this.idx(g.x, g.y, g.z), item, count, slots, all: g.args.contents });
                this.items.set(item, (this.items.get(item) || 0) + count);
            }
        }
        this.pistons = P.pistonsOf(this);
    }

    idx(x, y, z) { const b = this.box; return ((y - b.y) * b.sz + (z - b.z)) * b.sx + (x - b.x); }
    inside(x, y, z) { const b = this.box; return x >= b.x && y >= b.y && z >= b.z && x < b.x + b.sx && y < b.y + b.sy && z < b.z + b.sz; }
    cell(i) { const b = this.box, x = i % b.sx, z = Math.floor(i / b.sx) % b.sz, y = Math.floor(i / (b.sx * b.sz)); return { x: b.x + x, y: b.y + y, z: b.z + z }; }
    /** Target state at a world cell (null outside the box). */
    at(x, y, z) { return this.inside(x, y, z) ? this.palette[this.t[this.idx(x, y, z)]] : null; }
    stateOf(i) { return this.palette[this.t[i]]; }
    /** What a task must make of its cell: the blueprint's state, or the other phase of a piston's machine (survey.js) when the task says so. */
    wantOf(tk) { return tk.want || this.stateOf(tk.i); }
    recipeOf(tk) { return tk.want ? R.recipe(tk.want, (dx, dy, dz) => this.at(tk.x + dx, tk.y + dy, tk.z + dz)) : this.recipe[tk.i]; }
    isAir(i) { return this.t[i] === AIR_ID; }

    /**
     * The cells whose block's click supports (the neighbours a click can give its state against, vanilla.js) are all build cells that cannot stand before it: a support cycle. Two
     * hoppers facing each other each need the other as the block clicked (a hopper faces into the block it is placed against): no order places either (iron-farm-34: the
     * pair at the bottom, "ready, no stance" on every crew of hc1/hd1 to the end). A player puts a temporary block into one of them first. Returns [{ cell: i, via: j }]: the
     * block of cell i goes against a temporary block in cell j, which is taken out before j's own block. Cells with a support on the ground or in a cell that stays empty
     * (a pillar or a scaffold gives that) start the order; computed once.
     */
    cycles() {
        if (this._cycles) return this._cycles;
        const V = require('./vanilla'), PLACED = new Set(['facing', 'half', 'type', 'axis', 'face', 'shape', 'part', 'hinge', 'hanging', 'attachment', 'rotation']);
        const looks = []; for (const [x, z] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) looks.push([x, 0, z], [x * 0.02, -1, z * 0.02], [x * 0.02, 1, z * 0.02], [x, -0.5, z], [x, 0.5, z]);
        const b = this.box, want = (x, y, z) => { if (!this.inside(x, y, z)) return null; const w = this.palette[this.t[this.idx(x, y, z)]]; return w && !S.AIR.has(S.bare(w.name)) ? w : null; };
        const sup = new Map();
        for (let i = 0; i < this.n; i++) {
            const r = this.recipe[i]; if (!r || r.op !== 'place') continue;
            const c = this.cell(i), w = this.palette[this.t[i]], wd = S.decidedProps(w.name, w.props);
            const at = (dx, dy, dz) => { const q = want(c.x + dx, c.y + dy, c.z + dz); return q ? { name: S.bare(q.name), props: q.props } : null; };
            const solid = (dx, dy, dz) => !!want(c.x + dx, c.y + dy, c.z + dz);
            const faces = [];
            for (const F of V.DIRS) {
                const v = V.VEC[F]; let ok = false;
                for (const lk of looks) {
                    for (const hy of F === 'up' ? [0] : F === 'down' ? [1] : [0.25, 0.75]) {
                        const got = V.predict(r.item, { face: F, hitY: hy, look: lk, sneak: false, at, solid });
                        if (!got || S.bare(got.name) !== S.bare(w.name)) continue;
                        ok = Object.entries(wd).every(([k, val]) => !PLACED.has(k) || got.props[k] === val || (k === 'type' && /chest$/.test(w.name) && val === 'right' && got.props[k] === 'single'));
                        if (ok) break;
                    }
                    if (ok) break;
                }
                if (ok) faces.push([c.x - v[0], c.y - v[1], c.z - v[2]]);
            }
            sup.set(i, faces);
        }
        const ok = new Set(), out = [];
        // a support that needs no build cell first: the ground under the box, or a cell that stays empty (a pillar or a scaffold stands there for the click)
        const free = ([x, y, z]) => (this.inside(x, y, z) ? !want(x, y, z) : true);
        for (const [i, f] of sup) if (f.some(free)) ok.add(i);
        for (let changed = true; changed;) {
            changed = false;
            for (const [i, f] of sup) if (!ok.has(i) && f.some(([x, y, z]) => this.inside(x, y, z) && ok.has(this.idx(x, y, z)))) { ok.add(i); changed = true; }
            if (changed) continue;
            // a cycle: its first cell goes against a temporary block in one of its supports, the rest follows
            const left = [...sup.keys()].filter((i) => !ok.has(i) && sup.get(i).length);
            if (!left.length) break;
            const i = left[0], [x, y, z] = sup.get(i)[0];
            out.push({ cell: i, via: this.idx(x, y, z) }); ok.add(i); changed = true;
        }
        this._cycles = out; this._sup = sup;
        return out;
    }
    /** The cells a click can give cell i's state against (vanilla's rules, computed with the cycles): [[x, y, z], ...], or null for a cell nothing is placed in. */
    supportsOf(i) { if (!this._sup) this.cycles(); return this._sup.get(i) || null; }

    /** Every portal of the blueprint: its cells, and the lighting (the obsidian under its lowest middle cell, clicked on top). */
    _portals() {
        const out = [], seen = new Uint8Array(this.n);
        for (let i = 0; i < this.n; i++) {
            if (seen[i] || this.t[i] === AIR_ID || S.bare(this.palette[this.t[i]].name) !== 'nether_portal') continue;
            const axis = this.palette[this.t[i]].props.axis, cells = [], q = [i]; seen[i] = 1;
            while (q.length) {
                const j = q.pop(); cells.push(j);
                const c = this.cell(j);
                for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
                    const x = c.x + dx, y = c.y + dy, z = c.z + dz; if (!this.inside(x, y, z)) continue;
                    const k = this.idx(x, y, z), s = this.palette[this.t[k]];
                    if (!seen[k] && S.bare(s.name) === 'nether_portal' && s.props.axis === axis) { seen[k] = 1; q.push(k); }
                }
            }
            const cs = cells.map((j) => ({ j, ...this.cell(j) })), minY = Math.min(...cs.map((c) => c.y)), low = cs.filter((c) => c.y === minY).sort((a, b) => a.x - b.x || a.z - b.z);
            const mid = low[Math.floor(low.length / 2)];
            out.push({ axis, cells, light: { x: mid.x, y: mid.y - 1, z: mid.z }, at: { x: mid.x, y: mid.y, z: mid.z } });
        }
        return out;
    }
}

module.exports = { Target, AIR_ID };
