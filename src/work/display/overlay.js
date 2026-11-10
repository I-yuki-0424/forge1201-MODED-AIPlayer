'use strict';
// The in-game display (owner 2026-11-06, redone 2026-11-11): what the bots are doing, drawn in the world as real lines (block_display entities, display/shapes.js), in every dimension.
//   paths  the way a bot is walking: a SOLID, glowing line in the bot's colour (seen through walls), a big cube on the destination
//   lanes  the designated range of a pit lane: a DASHED outline at the rim and at the layer it is digging now, joined by dashed corner posts
//   tags   every tagged block marked by a short column; a link is a dashed line from the machine to its container
// Entities are server commands (`execute in <dimension> run summon block_display ...`), so any client sees them: no mod, nothing to install. They are seen by every player in that dimension
// (an entity has no per-player visibility); the switches on the Automation page turn them off. Only what is new is summoned and only what is gone is killed (stable keys), a few dozen
// commands per frame at most; pieces are drawn only near a viewer, so they live in loaded chunks and a kill always reaches them. A run's entities carry an epoch tag, and the entities
// of an earlier run (a crash) are killed in every dimension on the first frame and every minute.
const shapes = require('./shapes');
const dimensions = require('../world/dimensions');

const DEFAULTS = Object.freeze({ on: true, paths: true, lanes: true, tags: true });
const FRAME_MS = 1000;
const NEAR = 110;                           // blocks (X-Z) from a viewer in the same dimension: farther pieces are not drawn (and so stay inside loaded chunks)
const PATH_STALE_MS = 25000;                // a path nobody has refreshed for this long is not shown
const CAP = { paths: 420, lanes: 520, tags: 120 };       // pieces per layer on the whole server
const PER_FRAME = 70;                       // summon + kill commands per frame
const SWEEP_MS = 60000;
const VIEW_TAG = 'aip_see';                 // kept for the page's wording: the old particle display tagged its viewers

/** The pieces of one frame from `state` (see service/display.js displayState): a Map key -> {dim, piece}. */
function framePieces(state, cfg) {
    const out = new Map(), count = { paths: 0, lanes: 0, tags: 0 };
    const near = (dim, x, z) => state.viewers.some((v) => v.dim === dim && Math.hypot(v.x - x, v.z - z) <= NEAR);
    const add = (layer, dim, p) => {
        if (count[layer] >= CAP[layer]) return;
        const k = shapes.keyOf(dim, p); if (out.has(k)) return;
        out.set(k, { dim, piece: p, layer }); count[layer]++;
    };
    if (cfg.paths) for (const b of state.bots) {
        if (!b.path || !b.path.cells.length || !b.pos) continue;
        const dim = b.dim || 'overworld', pts = b.path.cells.map(([x, y, z]) => [x + 0.5, y + 0.15, z + 0.5]);
        let i = 0, best = Infinity;                                                        // the part of the path ahead of the bot
        pts.forEach((c, k) => { const d = Math.hypot(c[0] - b.pos.x, c[1] - b.pos.y, c[2] - b.pos.z); if (d < best) { best = d; i = k; } });
        if (!near(dim, pts[i][0], pts[i][2])) continue;
        for (const [a, c] of shapes.runs(pts.slice(i))) add('paths', dim, shapes.piece(a, c, shapes.T_PATH, b.color, true));
        const e = pts[pts.length - 1];
        add('paths', dim, shapes.piece([e[0], e[1] + 0.35, e[2]], [e[0], e[1] + 0.95, e[2]], shapes.T_MARK, b.color, true));
    }
    if (cfg.lanes) for (const l of state.lanes) {
        const dim = l.dim || 'overworld', cx = (l.box.x0 + l.box.x1 + 1) / 2, cz = (l.box.z0 + l.box.z1 + 1) / 2;
        if (!near(dim, cx, cz) && !near(dim, l.box.x0, l.box.z0) && !near(dim, l.box.x1, l.box.z1)) continue;
        const o = { dash: 1.6, gap: 0.9, t: shapes.T_RANGE, c: l.color, glow: true }, top = l.rim + 1.02, act = l.activeY + 1.02;
        for (const p of shapes.rectDashed(l.box, top, o)) add('lanes', dim, p);
        if (l.activeY < l.rim) {
            for (const p of shapes.rectDashed(l.box, act, o)) add('lanes', dim, p);
            for (const p of shapes.postsDashed(l.box, act, top, { ...o, dash: 2.2, gap: 1.2 })) add('lanes', dim, p);
        }
    }
    if (cfg.tags) for (const t of state.tags) {
        const dim = t.dim || 'overworld', c = t.machine ? 6 : 5, x = t.x + 0.5, y = t.y + 1.15, z = t.z + 0.5;
        if (!near(dim, x, z)) continue;
        add('tags', dim, shapes.piece([x, y, z], [x, y + 1.4, z], shapes.T_TAG, c, true));
        if (t.end) for (const p of shapes.dashed([x, y + 0.2, z], [t.end.x + 0.5, t.end.y + 1.35, t.end.z + 0.5], { dash: 1, gap: 0.8, t: shapes.T_TAG, c })) add('tags', dim, p);
    }
    return out;
}

class Overlay {
    /**
     * @param o.rcon      async (command) -> reply: the service's RCON queue
     * @param o.state     () -> state for framePieces (null when there is nothing to draw)
     * @param o.config    () -> {on, paths, lanes, tags}
     * @param o.humans    async () -> [{name, x, y, z, dim}]: the players who should see it (not bots), in any dimension
     * @param o.pending   () -> number of commands waiting in the RCON queue
     * @param o.perFrame  summon + kill commands per frame (default 70)
     */
    constructor(o) {
        this.o = { ...o, perFrame: o.perFrame > 0 ? o.perFrame : PER_FRAME, frameMs: o.frameMs > 0 ? o.frameMs : FRAME_MS };
        this.epoch = `aipe${Date.now().toString(36)}`;
        this.quiet = false; this.timer = null; this.busy = false; this.viewers = []; this.viewersAt = -Infinity; this.frames = 0; this.sent = 0;
        this.drawn = new Map();              // key -> {dim}: what stands in the world now
        this.swept = new Set(); this.sweptAt = -Infinity;
    }
    start() { if (!this.timer) { this.timer = setInterval(() => this.frame().catch(() => {}), this.o.frameMs); this.timer.unref?.(); } }
    stop() { clearInterval(this.timer); this.timer = null; }

    async _viewers(now) {
        if (now - this.viewersAt < 5000) return this.viewers;
        this.viewersAt = now;
        const humans = await this.o.humans(); this.viewers = humans.map((h) => ({ ...h, dim: dimensions.canon(h.dim) || 'overworld' }));
        return this.viewers;
    }

    /**
     * The server tells every operator, in chat, what a console command did ("[Rcon: Summoned new Block Display]"), hundreds of times a minute here. These two rules switch that off
     * (they hide the feedback of everyone's commands, errors still show): the owner asked for it.
     */
    async _quiet() {
        await this.o.rcon('gamerule sendCommandFeedback false');
        await this.o.rcon('gamerule logAdminCommands false');
        this.quiet = true;
    }

    /** Kill the entities of other runs (and, with `all`, of this one) in the dimensions that matter. */
    async _sweep(dims, now, all = false) {
        for (const d of dims) await this.o.rcon(all ? shapes.killAllCommand(dimensions.rconId(d)) : shapes.killStaleCommand(dimensions.rconId(d), this.epoch));
        this.sweptAt = now;
    }

    /** Remove everything this run drew (the console stops, the display is switched off, nobody watches). */
    async clear() {
        const dims = new Set([...this.drawn.values()].map((v) => v.dim));
        this.drawn.clear();
        if (dims.size) await this._sweep(dims, Date.now(), true);
    }

    /** Draw one frame. Returns the number of commands sent (0 when off, nobody watches, or the queue is behind). */
    async frame(now = Date.now()) {
        const cfg = { ...DEFAULTS, ...(this.o.config() || {}) };
        if (this.busy) return 0;
        if (!cfg.on) { if (this.drawn.size) { this.busy = true; try { await this.clear(); } finally { this.busy = false; } } return 0; }
        if (this.o.pending() > 2) return 0;                          // never delay the bots' own commands for decoration
        this.busy = true;
        try {
            if (!this.quiet && this.o.quiet !== false) await this._quiet();
            const viewers = await this._viewers(now);
            const vdims = new Set(viewers.map((v) => v.dim));
            if (!viewers.length) { if (this.drawn.size) await this.clear(); return 0; }
            for (const d of vdims) if (!this.swept.has(d)) { this.swept.add(d); await this._sweep([d], now); }
            if (now - this.sweptAt > SWEEP_MS) await this._sweep(vdims, now);
            const state = this.o.state(); if (!state) return 0;
            const want = framePieces({ ...state, viewers }, cfg);
            let n = 0;
            for (const [k, v] of [...this.drawn]) {                    // gone, or no longer near a viewer
                if (n >= this.o.perFrame) break;
                if (want.has(k) && vdims.has(v.dim)) continue;
                await this.o.rcon(shapes.killCommand(dimensions.rconId(v.dim), k)); this.drawn.delete(k); n++;
            }
            for (const [k, v] of want) {
                if (n >= this.o.perFrame) break;
                if (this.drawn.has(k)) continue;
                await this.o.rcon(shapes.summonCommand(dimensions.rconId(v.dim), v.piece, k, this.epoch)); this.drawn.set(k, { dim: v.dim }); n++;
            }
            this.frames++; this.sent += n;
            return n;
        } finally { this.busy = false; }
    }
}

module.exports = { Overlay, framePieces, VIEW_TAG, DEFAULTS, PATH_STALE_MS, FRAME_MS, NEAR };
