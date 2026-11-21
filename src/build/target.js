'use strict';
// What the box must hold when the build is done: every cell of the blueprint's box in world coordinates (air included: what stands there now and is not in the blueprint goes),
// each cell's normalised target state and its recipe, the portals (one lighting each), and the item types the build uses. Pure.
const nbt = require('prismarine-nbt');
const S = require('./state');
const R = require('./rules');

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
        const pk = new Map([['air', 0]]);
        const idOf = (st) => { const k = S.str(st.name, st.props); let i = pk.get(k); if (i === undefined) { i = this.palette.length; this.palette.push(st); pk.set(k, i); } return i; };
        this.t = new Uint16Array(this.n);                     // palette index per cell (0 = air)
        for (const b of bp.blocks) {
            const p = bp.palette[b.s];
            let te = null;
            if (b.nbt) { try { te = nbt.simplify(b.nbt); } catch (_) { te = null; } }
            this.t[this.idx(b.x, b.y, b.z)] = idOf(S.normalise(p.name, p.props, te));
        }
        // recipes per cell (they look at neighbours: chest partners, the cell an observer watches)
        this.recipe = new Array(this.n).fill(null);
        this.items = new Map();                              // item -> cells that need it
        for (let i = 0; i < this.n; i++) {
            if (this.t[i] === AIR_ID) continue;
            const c = this.cell(i);
            const r = R.recipe(this.palette[this.t[i]], (dx, dy, dz) => this.at(c.x + dx, c.y + dy, c.z + dz));
            this.recipe[i] = r;
            if (r && r.item) this.items.set(r.item, (this.items.get(r.item) || 0) + 1 + (r.repeat || 0) + (r.again ? 1 : 0));
        }
        this.portals = this._portals();
        for (const p of this.portals) for (const i of p.cells) this.recipe[i] = null;        // the lighting stands for every portal cell
        if (this.portals.length) this.items.set('flint_and_steel', (this.items.get('flint_and_steel') || 0));
    }

    idx(x, y, z) { const b = this.box; return ((y - b.y) * b.sz + (z - b.z)) * b.sx + (x - b.x); }
    inside(x, y, z) { const b = this.box; return x >= b.x && y >= b.y && z >= b.z && x < b.x + b.sx && y < b.y + b.sy && z < b.z + b.sz; }
    cell(i) { const b = this.box, x = i % b.sx, z = Math.floor(i / b.sx) % b.sz, y = Math.floor(i / (b.sx * b.sz)); return { x: b.x + x, y: b.y + y, z: b.z + z }; }
    /** Target state at a world cell (null outside the box). */
    at(x, y, z) { return this.inside(x, y, z) ? this.palette[this.t[this.idx(x, y, z)]] : null; }
    stateOf(i) { return this.palette[this.t[i]]; }
    isAir(i) { return this.t[i] === AIR_ID; }

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
