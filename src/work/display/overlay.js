'use strict';
// The in-game display (owner 2026-11-06): what the bots are doing, drawn in the world with particles that only the operator sees.
//   paths  the way a bot is walking (from its planner), thinned to the budget, with a big mark on the destination
//   lanes  the mining divisions: each pit lane outlined at the rim and at the layer it is digging now, joined by corner posts
//   tags   every tagged block marked by a short column; a link is a dotted line from the machine to its container
// Particles are server commands (`particle ... force @a[tag=aip_see]`), so any client sees them: no mod, nothing to install. A mod that draws
// real lines would need Java and a build for every Forge version and would have to be installed on every player's PC (docs/implemented/DISPLAY-v1.md).
// The overlay sends through the service's RCON queue, a few dozen commands per frame, and skips a frame when the queue is behind.
const shapes = require('./shapes');

const VIEW_TAG = 'aip_see';
const DEFAULTS = Object.freeze({ on: true, paths: true, lanes: true, tags: true });
const FRAME_MS = 1500;                      // dust lives 0.4-4 s: redrawn every 1.5 s it reads as continuous
const SHARE = { paths: 0.4, lanes: 0.45, tags: 0.15 };
const NEAR = 180;                           // blocks (X-Z) from a viewer: farther shapes are not drawn
const PATH_STALE_MS = 25000;                // a path nobody has refreshed for this long is not shown

/** The points of one frame from `state` (see service/display.js displayState), at most `budget`, split between the layers. */
function framePoints(state, cfg, budget) {
    const near = (p) => state.viewers.some((v) => Math.hypot(v.x - p.x, v.z - p.z) <= NEAR);
    const layers = { paths: [], lanes: [], tags: [] };
    if (cfg.paths) for (const b of state.bots) {
        if (!b.path || !b.path.cells.length) continue;
        let i = 0, best = Infinity;                                                        // the part of the path ahead of the bot
        if (b.pos) b.path.cells.forEach((c, k) => { const d = Math.hypot(c[0] + 0.5 - b.pos.x, c[1] - b.pos.y, c[2] + 0.5 - b.pos.z); if (d < best) { best = d; i = k; } });
        const ahead = b.path.cells.slice(i).map(([x, y, z]) => ({ x: x + 0.5, y: y + 0.2, z: z + 0.5, c: b.color }));
        const [lx, ly, lz] = b.path.cells[b.path.cells.length - 1];
        if (ahead.length && near(ahead[0])) layers.paths.push(...ahead, ...Array(3).fill({ x: lx + 0.5, y: ly + 0.9, z: lz + 0.5, c: b.color, s: 2 }));
    }
    if (cfg.lanes) for (const l of state.lanes) {
        const sp = 2, top = l.rim, act = l.activeY;
        const pts = [...shapes.rectOutline(l.box, top + 1.02, sp, l.color)];
        if (act < top) pts.push(...shapes.rectOutline(l.box, act + 1.02, sp, l.color, 1.5), ...shapes.corners(l.box, act + 1.02, top + 1.02, sp, l.color));
        if (pts.length && near(pts[0])) layers.lanes.push(...pts);
    }
    if (cfg.tags) for (const t of state.tags) {
        const c = t.machine ? 6 : 5, base = { x: t.x + 0.5, y: t.y + 1.15, z: t.z + 0.5 };
        if (!near(base)) continue;
        layers.tags.push(...shapes.segment(base, { ...base, y: base.y + 1.2 }, 0.6, c));
        if (t.end) layers.tags.push(...shapes.segment(base, { x: t.end.x + 0.5, y: t.end.y + 1.15, z: t.end.z + 0.5 }, 1.2, c));
    }
    const out = [];
    for (const [name, pts] of Object.entries(layers)) out.push(...shapes.thin(pts, Math.max(4, Math.floor(budget * SHARE[name]))));
    return out;
}

class Overlay {
    /**
     * @param o.rcon      async (command) -> reply: the service's RCON queue
     * @param o.state     () -> state for framePoints (null when there is nothing to draw)
     * @param o.config    () -> {on, paths, lanes, tags}
     * @param o.humans    async () -> [{name, x, y, z}]: the players who should see it (not bots), overworld only
     * @param o.pending   () -> number of commands waiting in the RCON queue
     * @param o.budget    particles per frame (default 70)
     */
    constructor(o) {
        this.o = { ...o, budget: o.budget > 0 ? o.budget : 70, frameMs: o.frameMs > 0 ? o.frameMs : FRAME_MS };
        this.timer = null; this.busy = false; this.viewers = []; this.viewersAt = -Infinity; this.tagged = new Set(); this.frames = 0; this.sent = 0;
    }
    start() { if (!this.timer) { this.timer = setInterval(() => this.frame().catch(() => {}), this.o.frameMs); this.timer.unref?.(); } }
    stop() { clearInterval(this.timer); this.timer = null; }

    /** Players who see the overlay carry the tag `aip_see` (one selector for every command); refreshed every 8 s. */
    async _viewers(now) {
        if (now - this.viewersAt < 8000) return this.viewers;
        this.viewersAt = now;
        const humans = await this.o.humans(); this.viewers = humans;
        for (const h of humans) if (!this.tagged.has(h.name)) { await this.o.rcon(`tag ${h.name} add ${VIEW_TAG}`); this.tagged.add(h.name); }
        for (const n of [...this.tagged]) if (!humans.some((h) => h.name === n)) this.tagged.delete(n);
        return humans;
    }

    /** Draw one frame. Returns the number of commands sent (0 when off, nobody watches, or the queue is behind). */
    async frame(now = Date.now()) {
        const cfg = { ...DEFAULTS, ...(this.o.config() || {}) };
        if (!cfg.on || this.busy) return 0;
        if (this.o.pending() > 2) return 0;                          // never delay the bots' own commands for decoration
        this.busy = true;
        try {
            const viewers = await this._viewers(now);
            if (!viewers.length) return 0;
            const state = this.o.state(); if (!state) return 0;
            const pts = framePoints({ ...state, viewers }, cfg, this.o.budget);
            const sel = `@a[tag=${VIEW_TAG}]`;
            for (const p of pts) await this.o.rcon(shapes.dustCommand(p, sel));
            this.frames++; this.sent += pts.length;
            return pts.length;
        } finally { this.busy = false; }
    }
}

module.exports = { Overlay, framePoints, VIEW_TAG, DEFAULTS, PATH_STALE_MS, FRAME_MS };
