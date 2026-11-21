'use strict';
// One build: the target, the work a survey found, who holds which piece of it, the stage the build is in, and the end. Shared by every bot of the crew (one process); each bot
// claims a station and the tasks it can reach from there (drive.js does them). No world reads of its own: the bot that claims lends its view.
//
// Stages, each starting when the one before has no task left (a survey decides; every survey sees the whole box again, so a cell spoiled later is work again):
//   prepare   seal fluids outside the box next to it, fill fluids inside that must go, clear what must go (top-down, never next to a fluid)
//   place     every block by its recipe, bottom-up within a window of layers, dependencies first (support, chest partner, the cell an observer watches); clicks right after
//   late      fluids poured and portals and fires lit, when every block stands
//   settle    a few seconds for the circuit, then one more survey: nothing left = done
const S = require('./state');
const { survey } = require('./survey');
const { seen, eyeOf, boxDist } = require('./act');
const fly = require('./fly');

const REACH = 5.2;                 // eye to the cell's box (the server allows < 6 in creative; the margin covers the server's view of the position)
const WINDOW = 1;                  // layers above the lowest open one that may be placed at the same time (the crew stands above them: see standBlocked)
const MAX_FAILS = 8;               // tries of one cell before it is parked (reported, not tried again until the next round)
const BATCH = 96;                  // tasks per claim
const ROUNDS = 3;                  // extra rounds for parked cells before the build ends with them reported
const STALL_MS = 40000;            // nothing ready for anybody this long while work is left: the ordering rules are relaxed (a dependency that cannot be met)
const STAGE_OF = { seal: 'prepare', fill: 'prepare', clear: 'prepare', place: 'place', fix: 'place', pour: 'late', ignite: 'late' };
const ORDER = ['prepare', 'place', 'late'];
const key = (x, y, z) => `${x},${y},${z}`;

class BuildJob {
    /**
     * @param target  Target (target.js)
     * @param opts    { sealItem, available: Set(item) | null (null = not read yet), log(fn), now }
     */
    constructor(target, opts = {}) {
        this.t = target;
        this.o = { reach: REACH, window: WINDOW, ...opts };
        this.log = opts.log || (() => {});
        this.stage = 'survey';
        this.tasks = new Map();            // k -> task
        this.buckets = new Map();          // 'bx,by,bz' (8-cell buckets) -> tasks, for claims near the bot
        this.claims = new Map();           // k -> bot name
        this.fails = new Map();            // k -> tries that did not hold
        this.parked = new Map();           // k -> reason
        this.cool = new Map();             // k -> time before which it is not offered
        this.bots = new Map();             // name -> { station: [cells], pos }
        this.noPath = new Map();           // name -> flights in a row that found no way
        this.surveying = null;
        this.rounds = 0;
        this.history = [];
        this.started = Date.now();
        this.done = false;
        this.result = null;
        this.available = opts.available || null;
        this.sealItem = opts.sealItem || 'smooth_stone';
        this.lit = new Set();
        this.stats = { placed: 0, cleared: 0, sealed: 0, filled: 0, fixed: 0, poured: 0, lit: 0, failed: 0, surveys: 0, escapes: 0 };
    }

    // ---- surveys ---------------------------------------------------------------------------------------------------------------------------------------------------------

    /** Survey with `bot`'s view; sets the stage from what is left. One bot at a time; the others wait for it. */
    async resurvey(bot, why) {
        if (this.surveying) return this.surveying;
        this.surveying = (async () => {
            const sv = survey(this.t, bot, { lit: new Set() });
            this.stats.surveys++;
            if (sv.unknown) { this.log(`survey: ${sv.unknown} cells not loaded for ${bot.username}`); }
            const tasks = new Map();
            // fluids the blueprint has are poured at the end, when their basin stands: while blocks are still to be placed or cleared, a fluid in the box (even one where the blueprint
            // has it, as the world made it) is filled, or it runs into every cell that is opened next to it (live 2026-11-21 run n5: clearing next to natural lava waited for ever)
            // (once the late stage has poured, fluids stay: a block put back afterwards next to them is placed into a finished basin)
            if (!this.pouredOnce && sv.tasks.some((tk) => STAGE_OF[tk.kind] === 'prepare' || STAGE_OF[tk.kind] === 'place')) for (const tk of sv.kept) sv.tasks.push(tk);
            for (const tk of sv.tasks) {
                if (this.parked.has(tk.k)) continue;
                if (tk.kind !== 'seal' && tk.kind !== 'ignite' && this.available && !this._itemOk(tk)) { this.parked.set(tk.k, `missing_item ${this._itemOf(tk)}`); continue; }
                tasks.set(tk.k, tk);
            }
            this.tasks = tasks;
            this.buckets = new Map();
            for (const tk of tasks.values()) { const k = `${Math.floor(tk.x / 8)},${Math.floor(tk.y / 8)},${Math.floor(tk.z / 8)}`; (this.buckets.get(k) || this.buckets.set(k, []).get(k)).push(tk); }
            this.claims.clear();
            this.relaxed = false; this.stallSince = 0;
            const by = {}; for (const tk of tasks.values()) by[tk.kind] = (by[tk.kind] || 0) + 1;
            let stage = 'settle';
            for (const st of ORDER) if ([...tasks.values()].some((tk) => STAGE_OF[tk.kind] === st)) { stage = st; break; }
            if (sv.unknown) stage = this.stage === 'survey' ? 'survey' : stage;
            this.history.push({ t: Date.now(), why, stage, right: sv.right, dynamic: sv.dynamic, unknown: sv.unknown, by, parked: this.parked.size });
            this.log(`survey (${why}): ${sv.right} right, ${sv.dynamic} dynamic, ${sv.phased} pistons in the other phase, ${sv.unknown} unknown, work ${JSON.stringify(by)}, parked ${this.parked.size} -> ${stage}`);
            // the tail by name (what each cell holds and should hold): a cell that keeps coming back shows itself here
            if (tasks.size && tasks.size <= 40) this.log(`survey tail: ${[...tasks.values()].map((tk) => { const h = sv.have && tk.i >= 0 ? sv.have[tk.i] : null, w = tk.i >= 0 ? this.t.wantOf(tk) : null; return `${tk.kind} ${tk.k}${w ? ' want ' + S.str(w.name, S.decidedProps(w.name, w.props)).replace('minecraft:', '') : ''}${h ? ' has ' + S.str(h.name, S.decidedProps(h.name, h.props)).replace('minecraft:', '') : ''}${this.fails.get(tk.k) ? ' x' + this.fails.get(tk.k) : ''}`; }).join(' | ')}`);
            if (stage === 'settle') {
                if (this.stage === 'settle' && !sv.unknown) { this._finish(sv); }
                this.stage = 'settle';
                this.settleAt = Date.now() + 4000;
            } else this.stage = stage;
            if (stage === 'late') this.pouredOnce = true;
            this._frontier();
        })();
        try { await this.surveying; } finally { this.surveying = null; }
    }

    _itemOf(tk) { if (tk.kind === 'fill' || tk.kind === 'seal') return this.sealItem; if (tk.kind === 'ignite') return 'flint_and_steel'; const r = tk.i >= 0 ? this.t.recipeOf(tk) : null; return r && r.item; }
    _itemOk(tk) { if (tk.kind === 'clear' || tk.kind === 'fix') return true; const it = this._itemOf(tk); return !it || this.available.has(it); }

    _finish(sv) {
        // parked cells get more rounds (a neighbour that was missing may stand now, a mob may have moved): every cell is tried again, up to ROUNDS times
        if (this.parked.size && this.rounds < ROUNDS) {
            this.rounds++;
            this.log(`round ${this.rounds + 1}: ${this.parked.size} parked cells are tried again`);
            this.parked.clear(); this.fails.clear(); this.cool.clear();
            this.stage = 'survey';
            return;
        }
        this.done = true;
        const parked = [...this.parked.entries()].map(([k, why]) => ({ k, why }));
        this.result = { ok: parked.length === 0, right: sv.right, dynamic: sv.dynamic, parked, minutes: Math.round((Date.now() - this.started) / 6000) / 10, stats: { ...this.stats } };
        this.log(`build finished: ${parked.length ? parked.length + ' cells parked' : 'every cell right'} after ${this.result.minutes} min`);
    }

    /** The lowest layer that still has blocks to place (the window starts there). */
    _frontier() {
        let f = Infinity;
        for (const tk of this.tasks.values()) if ((tk.kind === 'place' || tk.kind === 'fix') && !this.parked.has(tk.k) && tk.y < f) f = tk.y;
        this.frontier = f;
    }

    // ---- what may be done now --------------------------------------------------------------------------------------------------------------------------------------------

    /** Is task `tk` ready in `bot`'s view of the world? (`pending`: cells this bot has just sent a placement for and not read back yet: they count as standing.) */
    ready(tk, bot, now, pending = null, soft = false) {
        if (this.parked.has(tk.k) || (this.cool.get(tk.k) || 0) > now) return false;
        if (STAGE_OF[tk.kind] !== this.stage) return false;
        if (this.relaxed) return true;
        if (tk.kind === 'clear') {
            // top-down: not under a cell that still has to be cleared; never next to a fluid (it would run in)
            if (this.tasks.has(key(tk.x, tk.y + 1, tk.z)) && this.tasks.get(key(tk.x, tk.y + 1, tk.z)).kind === 'clear') return false;
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
                const h = seen(bot, { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz });
                if (h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true')) return false;
            }
            return true;
        }
        if (tk.kind === 'place' || tk.kind === 'fix') {
            if (tk.y > this.frontier + this.o.window) return false;
            const r = this.t.recipeOf(tk);
            if (tk.kind === 'place' && r) for (const d of r.deps) {
                const x = tk.x + d[0], y = tk.y + d[1], z = tk.z + d[2];
                if (pending && pending.has(key(x, y, z))) continue;
                const want = this.t.at(x, y, z), h = seen(bot, { x, y, z });
                if (!want || !h || !S.matches(want, h)) {
                    // a soft dependency (the cell an observer watches) holds only while that cell can be placed now itself: a chain of observers watching observers up past the
                    // window waited for ever (live 2026-11-21 run n7)
                    if (r.soft && r.soft.includes(d) && !soft) { const dt = this.tasks.get(key(x, y, z)); if (!dt || !this.ready(dt, bot, now, pending, true)) continue; }
                    return false;
                }
            }
            return true;
        }
        return true;
    }

    /** Why task `tk` is not ready (for the stall log): the first rule that holds it. */
    whyNot(tk, bot, now) {
        if (this.parked.has(tk.k)) return 'parked';
        if ((this.cool.get(tk.k) || 0) > now) return 'cooling';
        if (STAGE_OF[tk.kind] !== this.stage) return `stage ${STAGE_OF[tk.kind]}`;
        if ((tk.kind === 'place' || tk.kind === 'fix') && tk.y > this.frontier + this.o.window) return `above the window (frontier ${this.frontier})`;
        const r = tk.i >= 0 ? this.t.recipeOf(tk) : null;
        if (tk.kind === 'place' && r) for (const d of r.deps) {
            const x = tk.x + d[0], y = tk.y + d[1], z = tk.z + d[2], want = this.t.at(x, y, z), h = seen(bot, { x, y, z });
            if (!want || !h || !S.matches(want, h)) return `waits for ${x},${y},${z} ${want ? S.str(want.name, S.decidedProps(want.name, want.props)) : '?'} (has ${h ? S.str(h.name, S.decidedProps(h.name, h.props)) : '?'}${this.parked.has(key(x, y, z)) ? ', parked' : ''})`;
        }
        if (tk.kind === 'clear') {
            const up = this.tasks.get(key(tk.x, tk.y + 1, tk.z));
            if (up && up.kind === 'clear') return 'under a cell to clear';
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) { const h = seen(bot, { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz }); if (h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true')) return `next to ${h.name} at ${tk.x + dx},${tk.y + dy},${tk.z + dz}`; }
        }
        return 'ready';
    }

    /**
     * Cells a station must not take: the bodies of the other bots, and while placing every cell of the box's footprint at or below the top of the window. Nothing is ever placed above a
     * bot then, so no bot can be closed in by the work (live 2026-11-21, run o1: stations below the layer being placed; a floor went in over four bots and they could not get out).
     * In the late stage the cells that will hold a block.
     */
    standBlocked(name) {
        const bodies = new Set();
        for (const [n, b] of this.bots) if (n !== name && b.station) for (const c of b.station) bodies.add(key(c.x, c.y, c.z));
        const top = this.frontier + this.o.window, t = this.t, b = t.box, stage = this.stage, relaxed = this.relaxed;
        return (x, y, z) => {
            if (bodies.has(key(x, y, z))) return true;
            const over = x >= b.x && z >= b.z && x < b.x + b.sx && z < b.z + b.sz;
            if (stage === 'place' && over && !relaxed) return y <= top + 1;          // feet and head both above the window
            if (!t.inside(x, y, z)) return false;
            const i = t.idx(x, y, z);
            if (t.isAir(i)) return false;
            return stage === 'place' || stage === 'late';
        };
    }

    // ---- claims --------------------------------------------------------------------------------------------------------------------------------------------------------------

    /**
     * A station and the tasks `bot` can do from it. Returns { station: {x,y,z} (feet cell), tasks: [...] } or null (nothing ready for this bot now).
     * The seed is the lowest (placing) / highest (clearing) ready task near the bot and away from the others; the station around it that reaches the most ready tasks wins.
     */
    claim(bot, name, now = Date.now()) {
        const me = fly.feet(bot), others = [...this.bots.entries()].filter(([n, b]) => n !== name && b.station).map(([, b]) => b.station[0]);
        // ready tasks, nearest buckets first, until enough are found (a full scan of 20 000 clear tasks every claim blocked the process for over a second)
        const ready = [], G = 8;
        const keys = [...this.buckets.keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return { k, d: Math.hypot(x * G + G / 2 - me.x, (y * G + G / 2 - me.y) * 1.5, z * G + G / 2 - me.z) }; }).sort((a, b) => a.d - b.d);
        const lo = this.stage === 'place' ? this.frontier : -Infinity, hi = this.stage === 'place' ? this.frontier + this.o.window : Infinity;
        for (const { k } of keys) {
            const [, by] = k.split(',').map(Number);
            if (by * G > hi || by * G + G - 1 < lo) continue;
            for (const tk of this.buckets.get(k)) if (this.tasks.has(tk.k) && !this.claims.has(tk.k) && this.ready(tk, bot, now)) ready.push(tk);
            if (ready.length >= 400) break;
        }
        if (!ready.length) {
            // a stall: work is left, nobody holds any, nothing is ready (a support that cannot stand, a fluid that keeps a cell wet): the rules give way until the next survey
            if (!this.claims.size && this.tasks.size && !this.relaxed) {
                if (!this.stallSince) this.stallSince = now;
                else if (now - this.stallSince > STALL_MS) {
                    this.relaxed = true;
                    const why = {}; let ex = [];
                    for (const tk of this.tasks.values()) { const w = this.whyNot(tk, bot, now); const k = w.replace(/ \d.*$/, '').replace(/waits for .*/, 'waits'); why[k] = (why[k] || 0) + 1; if (ex.length < 6 && /waits/.test(w)) ex.push(`${tk.k} ${S.bare(this.t.wantOf(tk).name)} ${w}`); }
                    this.log(`stall in ${this.stage} (${this.tasks.size} tasks, none ready for ${Math.round((now - this.stallSince) / 1000)} s): order rules relaxed until the next survey; why ${JSON.stringify(why)}; e.g. ${ex.join(' | ')}`);
                }
            }
            return null;
        }
        this.stallSince = 0;
        const down = this.stage === 'prepare';
        const crowd = (tk) => others.reduce((s, o) => s + (Math.hypot(o.x - tk.x, o.z - tk.z, (o.y - tk.y) / 2) < 7 ? 1 : 0), 0);
        const seedScore = (tk) => (down ? -tk.y : tk.y) * 3 + Math.hypot(tk.x - me.x, tk.y - me.y, tk.z - me.z) * 0.25 + crowd(tk) * 25 + (tk.kind === 'seal' || tk.kind === 'fill' ? -1000 : 0);
        ready.sort((a, b) => seedScore(a) - seedScore(b));
        // a spatial index of the ready tasks, for counting what a station reaches
        const grid = new Map(), g = (v) => Math.floor(v / 4);
        for (const tk of ready) { const k = `${g(tk.x)},${g(tk.y)},${g(tk.z)}`; (grid.get(k) || grid.set(k, []).get(k)).push(tk); }
        const within = (eye) => {
            const out = [];
            for (let gx = g(eye.x - 6); gx <= g(eye.x + 6); gx++) for (let gy = g(eye.y - 6); gy <= g(eye.y + 6); gy++) for (let gz = g(eye.z - 6); gz <= g(eye.z + 6); gz++) {
                const l = grid.get(`${gx},${gy},${gz}`); if (!l) continue;
                for (const tk of l) if (boxDist(eye, tk) <= this.o.reach) out.push(tk);
            }
            return out;
        };
        const blocked = this.standBlocked(name);
        for (const seed of ready.slice(0, 4)) {
            let best = null, tried = 0;
            for (const f of stationsAround(seed, this.o.reach, down)) {
                if (tried >= 120) break;
                if (!fly.fits(bot, f.x, f.y, f.z, blocked)) continue;
                tried++;
                const eye = eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 });
                if (boxDist(eye, seed) > this.o.reach) continue;
                if (bodyCovers(f, seed)) continue;
                const reach = within(eye).filter((tk) => !bodyCovers(f, tk));
                const score = reach.length - Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z) * 0.05;
                if (!best || score > best.score) best = { f, reach, score };
            }
            if (!best) { this.cool.set(seed.k, now + 5000); continue; }
            const tasks = best.reach.sort((a, b) => (down ? b.y - a.y : a.y - b.y) || a.x - b.x || a.z - b.z).slice(0, BATCH);
            for (const tk of tasks) this.claims.set(tk.k, name);
            this.bots.set(name, { station: [best.f, { x: best.f.x, y: best.f.y + 1, z: best.f.z }], pos: me });
            return { station: best.f, tasks };
        }
        return null;
    }

    /** The bot is done with its claim: what held, what did not. */
    report(name, results, now = Date.now()) {
        for (const { tk, ok, why } of results) {
            this.claims.delete(tk.k);
            if (ok) { this.tasks.delete(tk.k); this.stats[{ seal: 'sealed', fill: 'filled', clear: 'cleared', place: 'placed', fix: 'fixed', pour: 'poured', ignite: 'lit' }[tk.kind]]++; if (tk.kind === 'place' || tk.kind === 'fix') this._lowered(tk); continue; }
            if (why === 'skipped') { this.cool.set(tk.k, now + 1500); continue; }
            if (STAGE_OF[tk.kind] === 'late') this.log(`${name}: ${tk.kind} ${tk.k} failed: ${why}`);
            const n = (this.fails.get(tk.k) || 0) + 1; this.fails.set(tk.k, n); this.stats.failed++;
            this.cool.set(tk.k, now + 2000 * Math.min(n, 5));
            if (n >= MAX_FAILS) { this.parked.set(tk.k, why || 'failed'); this.tasks.delete(tk.k); this.log(`parked ${tk.kind} ${tk.k} after ${n} tries: ${why}`); this._frontier(); }
        }
    }
    release(name, tasks) { for (const tk of tasks) if (this.claims.get(tk.k) === name) this.claims.delete(tk.k); }
    leave(name) { for (const [k, n] of this.claims) if (n === name) this.claims.delete(k); this.bots.delete(name); }
    _lowered(tk) { if (tk.y === this.frontier) this._frontier(); }

    /** Nothing left in the current stage (no task, none claimed): time for a survey. */
    exhausted() {
        if (this.stage === 'survey') return true;
        if (this.stage === 'settle') return Date.now() >= this.settleAt;
        for (const tk of this.tasks.values()) if (STAGE_OF[tk.kind] === this.stage && !this.parked.has(tk.k)) return false;
        return this.claims.size === 0;
    }

    /** For the page and the logs. */
    status() {
        const by = {}; for (const tk of this.tasks.values()) by[tk.kind] = (by[tk.kind] || 0) + 1;
        const last = this.history[this.history.length - 1];
        return { stage: this.done ? 'done' : this.stage, work: by, claimed: this.claims.size, parked: this.parked.size, right: last ? last.right : 0, total: this.t.n, stats: this.stats, frontier: Number.isFinite(this.frontier) ? this.frontier - this.t.box.y : null, result: this.result };
    }
}

/** Does a body with its feet in f cover cell c (then nothing can be placed there)? */
const bodyCovers = (f, c) => c.x === f.x && c.z === f.z && (c.y === f.y || c.y === f.y + 1);

/** Feet cells around a task cell, nearest first: above it for placing (the work is below), beside and above for clearing. */
function stationsAround(c, reach, down) {
    const out = [], R = Math.floor(reach);
    for (let dy = -3; dy <= 6; dy++) for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const d = Math.hypot(dx, dz);
        if (d > reach) continue;
        out.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz, s: d * 0.5 + Math.abs(dy - (down ? 0 : 1)) });
    }
    return out.sort((a, b) => a.s - b.s);
}

module.exports = { BuildJob, REACH, STAGE_OF };
