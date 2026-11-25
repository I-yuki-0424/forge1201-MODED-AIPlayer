'use strict';
// The in-game display (owner 2026-11-06, redone 2026-11-11): what the bots are doing, drawn in the world as real lines (block_display entities, display/shapes.js), in every dimension.
//   paths  the way a bot is walking: a SOLID, glowing line in the bot's colour (seen through walls), a big cube on the destination
//   lanes  the designated range of a pit lane: a DASHED outline at the rim and at the layer it is digging now, joined by dashed corner posts
//   tags   every tagged block marked by a short column; a link is a dashed line from the machine to its container
// Entities are server commands (`execute in <dimension> run summon block_display ...`), so any client sees them: no mod, nothing to install. They are seen by every player in that dimension
// (an entity has no per-player visibility); the switches on the Automation page turn them off.
// LIFETIME (owner 2026-11-25, list 5 Small 1): a piece is keyed by what it shows (a run of a bot's path, a dash of a lane, the column of a tag: shapes.idKey), summoned once when the
// thing becomes valid, updated in place (`data merge`, shapes.updateCommands) while it changes, and killed only when the thing is no longer valid (the walk is over: display/paths.js;
// the job ended; the tag was removed) or no viewer is near. Before, pieces were keyed by geometry: every cell the bot passed killed and summoned the path's first piece and its
// destination mark, a growing claim redrew its whole outline, and with the per-frame budget spent on kills the new pieces came frames later: lines blinked and vanished.
// A few dozen commands per frame at most; pieces are drawn only near a viewer, so they live in loaded chunks and a kill always reaches them. A run's entities carry an epoch tag,
// and the entities of an earlier run (a crash) are killed in every dimension on the first frame and every minute.
const shapes = require('./shapes');
const paths = require('./paths');
const dimensions = require('../world/dimensions');

const DEFAULTS = Object.freeze({ on: true, paths: true, lanes: true, tags: true });
const FRAME_MS = 1000;
const NEAR = 110;                           // blocks (X-Z) from a viewer in the same dimension: farther pieces are not drawn (and so stay inside loaded chunks)
const PATH_STALE_MS = paths.MAX_MS;         // a path is never shown longer than this (its real end: display/paths.js advance)
const CAP = { paths: 420, lanes: 520, tags: 120 };       // pieces per layer on the whole server
const PER_FRAME = 70;                       // summon + update + kill commands per frame
const SWEEP_MS = 60000;
const VIEW_TAG = 'aip_see';                 // kept for the page's wording: the old particle display tagged its viewers

/** The pieces of one frame from `state` (see service/display.js displayState): a Map key -> {dim, piece, layer}. The key names what the piece shows, not where it is. */
function framePieces(state, cfg) {
    const out = new Map(), count = { paths: 0, lanes: 0, tags: 0 };
    const near = (dim, x, z) => state.viewers.some((v) => v.dim === dim && Math.hypot(v.x - x, v.z - z) <= NEAR);
    const add = (layer, dim, id, p) => {
        if (count[layer] >= CAP[layer]) return;
        const k = shapes.idKey(dim, id); if (out.has(k)) return;
        out.set(k, { dim, piece: p, layer }); count[layer]++;
    };
    // every bot gets an equal share of the path layer (the first bots' long winding paths took the whole cap and only three of eight bots were shown, owner 2026-11-23, problem 4).
    // A path is drawn from the cell the bot has reached (path.idx, kept by display/paths.js) to its end; each straight run keeps its identity while the bot walks it.
    const walking = cfg.paths ? state.bots.filter((b) => b.path && b.path.cells.length && b.pos) : [];
    const share = walking.length ? Math.max(4, Math.floor(CAP.paths / walking.length)) : 0;
    for (const b of walking) {
        const dim = b.dim || 'overworld', cs = b.path.cells, idx = Math.min(cs.length - 1, b.path.idx || 0), pt = (c) => [c[0] + 0.5, c[1] + 0.15, c[2] + 0.5];
        const here = pt(cs[idx]), e = pt(cs[cs.length - 1]), id = `p|${b.name}|${b.path.serial || 0}`;
        if (!near(dim, here[0], here[2]) && !near(dim, e[0], e[2])) continue;
        add('paths', dim, `${id}|end`, shapes.piece([e[0], e[1] + 0.35, e[2]], [e[0], e[1] + 0.95, e[2]], shapes.T_MARK, b.color, true));
        for (const r of paths.runsAhead(b.path, idx).slice(0, share - 1)) add('paths', dim, `${id}|${r.n}`, shapes.piece(pt(cs[r.i]), pt(cs[r.j]), shapes.T_PATH, b.color, true));
    }
    if (cfg.lanes) for (const l of state.lanes) {
        const dim = l.dim || 'overworld', cx = (l.box.x0 + l.box.x1 + 1) / 2, cz = (l.box.z0 + l.box.z1 + 1) / 2, id = `l|${l.job}|${l.id}`;
        if (!near(dim, cx, cz) && !near(dim, l.box.x0, l.box.z0) && !near(dim, l.box.x1, l.box.z1)) continue;
        const o = { dash: 1.6, gap: 0.9, t: shapes.T_RANGE, c: l.color, glow: true }, top = l.rim + 1.02, act = l.activeY + 1.02;
        shapes.rectDashed(l.box, top, o).forEach((p, i) => add('lanes', dim, `${id}|r${i}`, p));
        if (l.activeY < l.rim) {
            shapes.rectDashed(l.box, act, o).forEach((p, i) => add('lanes', dim, `${id}|a${i}`, p));
            shapes.postsDashed(l.box, act, top, { ...o, dash: 2.2, gap: 1.2 }).forEach((p, i) => add('lanes', dim, `${id}|p${i}`, p));
        }
    }
    if (cfg.tags) for (const t of state.tags) {
        const dim = t.dim || 'overworld', c = t.machine ? 6 : 5, x = t.x + 0.5, y = t.y + 1.15, z = t.z + 0.5, id = `t|${t.name}`;
        if (!near(dim, x, z)) continue;
        add('tags', dim, `${id}|c`, shapes.piece([x, y, z], [x, y + 1.4, z], shapes.T_TAG, c, true));
        if (t.end) shapes.dashed([x, y + 0.2, z], [t.end.x + 0.5, t.end.y + 1.35, t.end.z + 0.5], { dash: 1, gap: 0.8, t: shapes.T_TAG, c }).forEach((p, i) => add('tags', dim, `${id}|${i}`, p));
    }
    return out;
}

/** The rules that switch off the operators' chat/log echo of console commands: 26.1 spelling first, then the 1.20.1 one. */
const QUIET_RULES = ['send_command_feedback', 'log_admin_commands', 'sendCommandFeedback', 'logAdminCommands'];

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
        this.drawn = new Map();              // key -> {dim, sig, anchor}: what stands in the world now, how it looks, where its entity stands
        this.counts = { summon: 0, update: 0, kill: 0 };
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
        // Minecraft 26.1 renamed every game rule to snake_case: `sendCommandFeedback` is rejected there ("Incorrect argument") and the feedback kept coming (found 2026-11-16, 1310
        // "[Rcon: Summoned new Block Display]" lines in one log). Both spellings are sent; the one the server does not know is answered with an error and ignored.
        for (const rule of QUIET_RULES) await this.o.rcon(`gamerule ${rule} false`);
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
            const room = () => n < this.o.perFrame;
            for (const [k, v] of [...this.drawn]) {                    // no longer valid, or no longer near a viewer
                if (!room()) break;
                if (want.has(k) && want.get(k).dim === v.dim && vdims.has(v.dim)) continue;
                await this.o.rcon(shapes.killCommand(dimensions.rconId(v.dim), k)); this.drawn.delete(k); n++; this.counts.kill++;
            }
            for (const [k, v] of want) {                               // new: summoned; changed: updated in place (the entity stays)
                if (!room()) break;
                const d = this.drawn.get(k), sig = shapes.sigOf(v.piece);
                if (!d) { await this.o.rcon(shapes.summonCommand(dimensions.rconId(v.dim), v.piece, k, this.epoch)); this.drawn.set(k, { dim: v.dim, sig, anchor: v.piece.a.slice() }); n++; this.counts.summon++; continue; }
                if (d.sig === sig) continue;
                const u = shapes.updateCommands(dimensions.rconId(v.dim), v.piece, k, d.anchor);
                for (const c of u.commands) await this.o.rcon(c);
                d.sig = sig; d.anchor = u.anchor; n += u.commands.length; this.counts.update++;
            }
            this.frames++; this.sent += n;
            return n;
        } finally { this.busy = false; }
    }
}

module.exports = { QUIET_RULES, Overlay, framePieces, VIEW_TAG, DEFAULTS, PATH_STALE_MS, FRAME_MS, NEAR };
