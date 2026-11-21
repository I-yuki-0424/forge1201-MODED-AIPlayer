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
const { seen, eyeOf, boxDist } = require('./world');
const { View, feet } = require('./move');
const P = require('./place');

const REACH = 4.4;                 // eye to the cell's box (a vanilla client picks within 4.5)
const WINDOW = 2;                  // layers above the lowest open one that may be placed at the same time
const MAX_FAILS = 8;               // tries of one cell before it is parked (reported, not tried again until the next round)
const BATCH = 64;                  // tasks per claim (everything within reach of the stance: walking was the largest share of the time, live 2026-11-22)
const ROUNDS = 3;                  // extra rounds for parked cells before the build ends with them reported
const STALL_MS = 40000;            // nothing ready for anybody this long while work is left: the ordering rules are relaxed (a dependency that cannot be met)
const STAGE_OF = { seal: 'prepare', fill: 'prepare', clear: 'prepare', place: 'place', fix: 'place', pour: 'late', ignite: 'late', untemp: 'cleanup' };
const ORDER = ['prepare', 'place', 'late', 'cleanup'];
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
        this.noPath = new Map();           // name -> walks in a row that found no way
        this.skips = new Map();            // task -> times skipped
        this.noStance = new Map();         // task -> when a look first found no stance
        this.surveying = null;
        this.rounds = 0;
        this.history = [];
        this.started = Date.now();
        this.done = false;
        this.result = null;
        this.available = opts.available || null;
        this.sealItem = opts.sealItem || 'smooth_stone';
        this.lit = new Set();
        this.temps = new Set();            // temporary blocks placed outside the box ('x,y,z')
        this.tempItem = opts.tempItem || null;
        this.time = { walk: 0, dig: 0, place: 0, trip: 0, idle: 0, claim: 0 };
        this.stats = { placed: 0, cleared: 0, sealed: 0, filled: 0, fixed: 0, poured: 0, lit: 0, untemp: 0, failed: 0, surveys: 0, escapes: 0, trips: 0 };
    }

    // ---- surveys ---------------------------------------------------------------------------------------------------------------------------------------------------------

    /** Survey with `bot`'s view; sets the stage from what is left. One bot at a time; the others wait for it. */
    async resurvey(bot, why) {
        if (this.surveying) return this.surveying;
        this.surveying = (async () => {
            const sv = await survey(this.t, bot, { lit: new Set() });
            this.stats.surveys++;
            if (sv.unknown) { this.log(`survey: ${sv.unknown} cells not loaded for ${bot.username}`); }
            const tasks = new Map();
            // fluids the blueprint has are poured at the end, when their basin stands: while blocks are still to be placed or cleared, a fluid in the box (even one where the blueprint
            // has it, as the world made it) is filled, or it runs into every cell that is opened next to it (live 2026-11-21 run n5: clearing next to natural lava waited for ever)
            // (once the late stage has poured, fluids stay: a block put back afterwards next to them is placed into a finished basin)
            if (!this.pouredOnce && sv.tasks.some((tk) => STAGE_OF[tk.kind] === 'prepare' || STAGE_OF[tk.kind] === 'place')) for (const tk of sv.kept) sv.tasks.push(tk);
            // temporary blocks outside the box (pillars, bridges) that still stand: taken away at the end
            for (const k of this.temps) { const [x, y, z] = k.split(',').map(Number); if (this.t.inside(x, y, z)) { this.temps.delete(k); continue; } const h = seen(bot, { x, y, z }); if (!h) continue; if (h.name !== this.tempItem) { this.temps.delete(k); continue; } sv.tasks.push({ k, kind: 'untemp', i: -1, x, y, z }); }
            for (const tk of sv.tasks) {
                if (this.parked.has(tk.k)) continue;
                if (tk.kind !== 'seal' && tk.kind !== 'ignite' && this.available && !this._itemOk(tk)) { this.parked.set(tk.k, `missing_item ${this._itemOf(tk)}`); continue; }
                tasks.set(tk.k, tk);
            }
            this.tasks = tasks;
            this.fluidLeft = [...tasks.values()].some((tk) => tk.kind === 'fill' || tk.kind === 'seal');
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

    _itemOf(tk) { if (tk.kind === 'fill' || tk.kind === 'seal') return this.tempItem || this.sealItem; if (tk.kind === 'ignite') return 'flint_and_steel'; const r = tk.i >= 0 ? this.t.recipeOf(tk) : null; return r && r.item; }
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

    /** The lowest layer that still has blocks to place (the window starts there), and the highest that still has blocks to clear. */
    _frontier() {
        let f = Infinity, c = -Infinity;
        for (const tk of this.tasks.values()) {
            if (this.parked.has(tk.k)) continue;
            if ((tk.kind === 'place' || tk.kind === 'fix') && tk.y < f) f = tk.y;
            if (tk.kind === 'clear' && tk.y > c) c = tk.y;
        }
        this.frontier = f; this.clearTop = c;
    }

    // ---- what may be done now --------------------------------------------------------------------------------------------------------------------------------------------

    /** Is task `tk` ready in `bot`'s view of the world? (`pending`: cells this bot has just sent a placement for and not read back yet: they count as standing.) */
    ready(tk, bot, now, pending = null, soft = false) {
        if (this.parked.has(tk.k) || (this.cool.get(tk.k) || 0) > now) return false;
        if (STAGE_OF[tk.kind] !== this.stage) {
            // placing overlaps clearing: a block goes in as soon as its own neighbourhood is cleared (a few hard cells anywhere held the whole build in the prepare stage, live 2026-11-22)
            if (!(this.stage === 'prepare' && (tk.kind === 'place' || tk.kind === 'fix') && this._clearAround(tk))) return false;
        }
        if (this.relaxed) return true;
        if (tk.kind === 'clear') {
            // top-down, layer by layer (the crew stands on the floor it digs: a column cleared ahead of its neighbours is a shaft whose lower cells no eye sees, live 2026-11-22);
            // never next to a fluid (it would run in)
            // the nine cells above first (no shaft runs ahead of its neighbours; a local rule, so one stuck cell holds only what is under it)
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const up = this.tasks.get(key(tk.x + dx, tk.y + 1, tk.z + dz)); if (up && up.kind === 'clear' && !this.parked.has(up.k)) return false; }
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

    /** Is the cell of task tk already what the task would make it? */
    _already(tk, bot) {
        const h = seen(bot, tk);
        if (!h) return false;
        if (tk.kind === 'clear' || tk.kind === 'untemp') return S.AIR.has(h.name);
        if (tk.kind === 'seal' || tk.kind === 'fill') return h.name !== 'water' && h.name !== 'lava' && h.props.waterlogged !== 'true' && !/^(seagrass|tall_seagrass|kelp|kelp_plant|bubble_column)$/.test(h.name);
        if (tk.kind === 'place' && tk.i >= 0) { const w = this.t.wantOf(tk); return S.matches(w, h); }
        return false;
    }

    /** No clearing, filling or sealing left in the cell, its neighbours and the three layers above them (then it can be built while the rest is still cleared). */
    _clearAround(tk) {
        for (let dy = -1; dy <= 3; dy++) for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const o = this.tasks.get(key(tk.x + dx, tk.y + dy, tk.z + dz));
            if (o && (o.kind === 'clear' || o.kind === 'fill' || o.kind === 'seal') && !this.parked.has(o.k)) return false;
        }
        return !this.fluidLeft;
    }

    /** Why task `tk` is not ready (for the stall log): the first rule that holds it. */
    whyNot(tk, bot, now) {
        if (this.parked.has(tk.k)) return 'parked';
        if ((this.cool.get(tk.k) || 0) > now) return 'cooling';
        if (STAGE_OF[tk.kind] !== this.stage && !(this.stage === 'prepare' && (tk.kind === 'place' || tk.kind === 'fix') && this._clearAround(tk))) return this.stage === 'prepare' && (tk.kind === 'place' || tk.kind === 'fix') ? (this.fluidLeft ? 'fluids left' : 'clearing around it') : `stage ${STAGE_OF[tk.kind]}`;
        if ((tk.kind === 'place' || tk.kind === 'fix') && tk.y > this.frontier + this.o.window) return `above the window (frontier ${this.frontier})`;
        const r = tk.i >= 0 ? this.t.recipeOf(tk) : null;
        if (tk.kind === 'place' && r) for (const d of r.deps) {
            const x = tk.x + d[0], y = tk.y + d[1], z = tk.z + d[2], want = this.t.at(x, y, z), h = seen(bot, { x, y, z });
            if (!want || !h || !S.matches(want, h)) return `waits for ${x},${y},${z} ${want ? S.str(want.name, S.decidedProps(want.name, want.props)) : '?'} (has ${h ? S.str(h.name, S.decidedProps(h.name, h.props)) : '?'}${this.parked.has(key(x, y, z)) ? ', parked' : ''})`;
        }
        if (tk.kind === 'clear') {
            for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) { const up = this.tasks.get(key(tk.x + dx, tk.y + 1, tk.z + dz)); if (up && up.kind === 'clear') return 'under a cell to clear'; }
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) { const h = seen(bot, { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz }); if (h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true')) return `next to ${h.name} at ${tk.x + dx},${tk.y + dy},${tk.z + dz}`; }
        }
        return 'ready';
    }

    /** Cells a station must not take: the bodies of the other bots, and cells that will hold a block soon (a body in a cell blocks its placement). */
    standBlocked(name) {
        const bodies = new Set();
        for (const [n, b] of this.bots) if (n !== name && b.station) for (const c of b.station) bodies.add(key(c.x, c.y, c.z));
        const top = this.frontier + this.o.window + 1, t = this.t, stage = this.stage;
        return (x, y, z) => {
            if (bodies.has(key(x, y, z))) return true;
            if (!t.inside(x, y, z)) return false;
            const i = t.idx(x, y, z);
            if (t.isAir(i)) return false;
            return stage === 'late' || (stage === 'place' && y <= top);
        };
    }

    // ---- claims --------------------------------------------------------------------------------------------------------------------------------------------------------------

    /**
     * A station and the tasks `bot` can do from it: { station: {x,y,z} (feet cell; the mover gets there, on a pillar when nothing is under it), tasks: [{...tk, way}] }, or
     * { need: {item: n} } when the ready work near the bot needs items it does not carry, or null (nothing ready). `has(item)`: the count the bot carries.
     * The seed is the lowest (placing) / highest (clearing) ready task near the bot and away from the others; the station is one from which a survival player's click (place.js)
     * or dig reaches the seed, the one that reaches the most other ready tasks wins.
     */
    claim(bot, name, now = Date.now(), has = () => Infinity) {
        const me = feet(bot), others = [...this.bots.entries()].filter(([n, b]) => n !== name && b.station).map(([, b]) => b.station[0]);
        const ready = [], G = 8; let scanned = 0;
        const keys = [...this.buckets.keys()].map((k) => { const [x, y, z] = k.split(',').map(Number); return { k, d: Math.hypot(x * G + G / 2 - me.x, (y * G + G / 2 - me.y) * 1.5, z * G + G / 2 - me.z) }; }).sort((a, b) => a.d - b.d);
        const lo = this.stage === 'place' ? this.frontier : -Infinity, hi = this.stage === 'place' ? this.frontier + this.o.window : Infinity;
        for (const { k } of keys) {
            const [, by] = k.split(',').map(Number);
            if (by * G > hi || by * G + G - 1 < lo) continue;
            for (const tk of this.buckets.get(k)) {
                scanned++;
                if (!this.tasks.has(tk.k) || this.claims.has(tk.k)) continue;
                // already as it should be (dug on someone's way, leaves that decayed, a block another bot put there): done, not offered (a clear task on air found no stance and was parked, live 2026-11-22)
                if (this._already(tk, bot)) { this.tasks.delete(tk.k); this._lowered(tk); continue; }
                if (this.ready(tk, bot, now)) ready.push(tk);
            }
            if (ready.length >= 300 || scanned >= 6000) break;
        }
        if (!ready.length) {
            if (!this.claims.size && this.tasks.size && !this.relaxed) {
                if (!this.stallSince) this.stallSince = now;
                else if (now - this.stallSince > STALL_MS) {
                    this.relaxed = true;
                    const why = {}; const ex = [];
                    for (const tk of this.tasks.values()) { const w = this.whyNot(tk, bot, now); const k = w.replace(/ \d.*$/, '').replace(/waits for .*/, 'waits'); why[k] = (why[k] || 0) + 1; if (ex.length < 6 && /waits/.test(w)) ex.push(`${tk.k} ${tk.i >= 0 ? S.bare(this.t.wantOf(tk).name) : tk.kind} ${w}`); }
                    this.log(`stall in ${this.stage} (${this.tasks.size} tasks, none ready for ${Math.round((now - this.stallSince) / 1000)} s): order rules relaxed until the next survey; why ${JSON.stringify(why)}; e.g. ${ex.join(' | ')}`);
                }
            }
            return null;
        }
        this.stallSince = 0;
        // what the bot can do with what it carries; the rest says what to fetch
        const item = (tk) => this._itemOf(tk);
        // never the block a bot stands on (in the Nether a bot fell into the lava when another cleared its floor, live 2026-11-21)
        const floors = new Set([...this.bots.values()].map((b) => b.pos && key(b.pos.x, b.pos.y - 1, b.pos.z)).concat([...this.bots.values()].filter((b) => b.station).map((b) => key(b.station[0].x, b.station[0].y - 1, b.station[0].z))));
        floors.add(key(me.x, me.y - 1, me.z));
        const doable = ready.filter((tk) => { if ((tk.kind === 'clear' || tk.kind === 'untemp') && floors.has(tk.k)) return false; const it = item(tk); return !it || tk.kind === 'clear' || tk.kind === 'fix' || tk.kind === 'untemp' || has(it) > 0; });
        if (!doable.length) {
            // the work left is under bots' feet: the one standing on it steps off (idle bots stood on the last cells to clear for half an hour, live 2026-11-22 sI w2)
            if (ready.some((tk) => (tk.kind === 'clear' || tk.kind === 'untemp') && tk.k === key(me.x, me.y - 1, me.z))) return { moveOff: true };
            if (ready.every((tk) => tk.kind === 'clear' || tk.kind === 'untemp')) return null;
            const need = {}; for (const tk of ready.slice(0, 200)) { if (tk.kind === 'fix' || tk.kind === 'clear') continue; const it = item(tk); if (it) need[it] = (need[it] || 0) + 1; }
            return { need };
        }
        const down = this.stage === 'prepare';
        const crowd = (tk) => others.reduce((s, o) => s + (Math.hypot(o.x - tk.x, o.z - tk.z, (o.y - tk.y) / 2) < 6 ? 1 : 0), 0);
        const seedScore = (tk) => (tk.kind === 'place' || tk.kind === 'fix' ? 2000 + tk.y * 3 : (down ? -tk.y : tk.y) * 3) + Math.hypot(tk.x - me.x, tk.y - me.y, tk.z - me.z) * 0.25 + crowd(tk) * 25 + (tk.kind === 'seal' || tk.kind === 'fill' ? -1000 : 0);
        doable.sort((a, b) => seedScore(a) - seedScore(b));
        const view = new View(bot, { canDig: () => false }), blocked = this.standBlocked(name);
        // a spatial index of the doable tasks: a stance is first ranked by how many it has within reach (cheap); the click search (place.ways: rays and the vanilla model) runs only for
        // the best few (live 2026-11-21 sv5: the search for every stance and task blocked the process 4.5 s per claim)
        const grid = new Map(), g = (v) => Math.floor(v / 4);
        for (const tk of doable) { const kk = `${g(tk.x)},${g(tk.y)},${g(tk.z)}`; (grid.get(kk) || grid.set(kk, []).get(kk)).push(tk); }
        const near = (eye) => { const out = []; for (let gx = g(eye.x - 5); gx <= g(eye.x + 5); gx++) for (let gy = g(eye.y - 5); gy <= g(eye.y + 5); gy++) for (let gz = g(eye.z - 5); gz <= g(eye.z + 5); gz++) { const l = grid.get(`${gx},${gy},${gz}`); if (l) for (const tk of l) if (boxDist(eye, tk) <= this.o.reach) out.push(tk); } return out; };
        for (const seed of doable.slice(0, 3)) {
            let best = null;
            const cands = [], rej = { blocked: 0, solid: 0, unsupported: 0, far: 0, way: 0 };
            for (const f of stationsAround(seed, this.o.reach, down)) {
                if (cands.length >= 40) break;
                if (blocked(f.x, f.y, f.z) || blocked(f.x, f.y + 1, f.z) || bodyCovers(f, seed)) { rej.blocked++; continue; }
                // clearing: a stance may be inside rock that is to be cleared anyway (a box sunk in rock has no open cell near its top layer); the walk digs its way in
                const dug = !view.fits(f.x, f.y, f.z);
                if (dug && !(down && [f.y, f.y + 1].every((y) => view.free(f.x, y, f.z) || (this.tasks.get(key(f.x, y, f.z)) || {}).kind === 'clear'))) { rej.solid++; continue; }
                const wet = view.kind(f.x, f.y, f.z) === 'water';
                const standing = wet || dug || view.stands(f.x, f.y - 1, f.z);
                let h = 0;
                if (!standing) {
                    h = 1; while (h <= 65 && view.free(f.x, f.y - 1 - h, f.z) && !view.stands(f.x, f.y - 1 - h, f.z)) h++;
                    if (h > 64 || !view.stands(f.x, f.y - 1 - h, f.z)) {
                        // nothing to pillar from (a box over a cavern, over the Nether's lava sea): a bridge of temporary blocks from ground at the same height, at most 24 cells away
                        const br = this._bridgeFrom(view, f);
                        if (!br) { rej.unsupported++; continue; }
                        h = 4 + br;
                    }
                }
                const eye = eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 });
                if (boxDist(eye, seed) > this.o.reach) { rej.far++; continue; }
                const reach = near(eye).filter((tk) => !bodyCovers(f, tk));
                cands.push({ f, standing, dug, reach, score: reach.length - Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z) * 0.08 - (standing ? 0 : 10 + 3 * h) - (dug ? 4 : 0) });
            }
            cands.sort((a, b) => b.score - a.score);
            for (const c of cands.slice(0, 5)) {
                const world = this._world(bot, c.standing ? null : c.f, c.dug ? c.f : null);
                const way = this._way(world, seed, c.f);
                if (!way) { rej.way++; continue; }
                const batch = [{ ...seed, way }];
                for (const tk of c.reach) { if (tk === seed || batch.length >= BATCH) continue; const w = this._way(world, tk, c.f); if (w) batch.push({ ...tk, way: w }); }
                best = { f: c.f, batch };
                break;
            }
            if (!best) {
                this.cool.set(seed.k, now + 6000);
                // a task no stance reaches is parked after a few looks (it waits for the next round, when the build has changed what can be reached): a handful of hidden cells
                // held the whole build in the prepare stage (live 2026-11-22 sv8)
                const ns = this.noStance.get(seed.k) || now; this.noStance.set(seed.k, ns);
                if (now - ns > 120000) { this.parked.set(seed.k, `no stance (${cands.length} in range)`); this.tasks.delete(seed.k); this.log(`parked ${seed.kind} ${seed.k} (${seed.i >= 0 ? S.bare(this.t.wantOf(seed).name) : 'outside'}): no stance reaches it (${cands.length} stances in range; rejected ${JSON.stringify(rej)}; the cell holds ${(seen(bot, seed) || {}).name})`); this._frontier(); }
                continue;
            }
            const tasks = best.batch.sort((a, b) => ((a.kind === 'clear') !== (b.kind === 'clear') ? (a.kind === 'clear' ? -1 : 1) : 0) || (a.kind === 'clear' ? b.y - a.y : a.y - b.y) || a.x - b.x || a.z - b.z);
            for (const tk of tasks) this.claims.set(tk.k, name);
            this.bots.set(name, { station: [best.f, { x: best.f.x, y: best.f.y + 1, z: best.f.z }], pos: me });
            for (const tk of tasks) if ((tk.kind === 'clear' || tk.kind === 'untemp') && tk.x === best.f.x && tk.z === best.f.z && tk.y === best.f.y - 1) tk.way = null;      // its own floor: not from there
            return { station: best.f, tasks };
        }
        if (now - (this.diagAt || 0) > 30000) {
            this.diagAt = now;
            const why = {}; let n = 0;
            for (const tk of this.tasks.values()) { if (n++ > 4000) break; const w = this.whyNot(tk, bot, now).replace(/ \d.*$/, '').replace(/waits for .*/, 'waits for a dependency').replace(/next to .*/, 'next to a fluid'); why[w] = (why[w] || 0) + 1; }
            this.log(`claim by ${name}: ${ready.length} ready, ${doable.length} doable with what it carries, no stance for the first ${Math.min(3, doable.length)} (${doable.slice(0, 3).map((t) => `${t.kind} ${t.k}`).join(', ')}); the others: ${JSON.stringify(why)}; frontier ${this.frontier}`);
        }
        return null;
    }

    /** How far (cells) a stance in the air is from ground at its own height that a bridge can start from, in a straight line over free cells; null when none within 24. */
    _bridgeFrom(view, f) {
        for (let k = 1; k <= 24; k++) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const x = f.x + dx * k, z = f.z + dz * k;
            if (view.stands(x, f.y - 1, z) && view.fits(x, f.y, z)) {
                let ok = true;
                for (let j = 1; j < k && ok; j++) { const xx = f.x + dx * j, zz = f.z + dz * j; if (!view.fits(xx, f.y, zz) || view.kind(xx, f.y - 1, zz) !== 'free') ok = false; }
                if (ok) return k;
            }
        }
        return null;
    }

    /** The world for click search: the bot's view, plus a pillar's top block under a stance that stands on nothing yet. */
    _world(bot, pillarAt, bodyAt = null) {
        const over = new Map();
        if (bodyAt) { over.set(`${bodyAt.x},${bodyAt.y},${bodyAt.z}`, P.AIR); over.set(`${bodyAt.x},${bodyAt.y + 1},${bodyAt.z}`, P.AIR); }
        if (pillarAt) over.set(`${pillarAt.x},${pillarAt.y - 1},${pillarAt.z}`, { name: this.tempItem || 'dirt', props: {}, shapes: [[0, 0, 0, 1, 1, 1]] });
        return P.botWorld(bot, over);
    }

    /** How a task is done from stance f: a click (place.ways) for blocks, a face in sight for digging, or true for work that brings its own aim. Null: not from here. */
    _way(world, tk, f) {
        const k = tk.kind;
        if (k === 'clear' || k === 'untemp') { const c = P.clickable(world, tk, f); return c || null; }
        if (k === 'fix') { const c = P.clickable(world, tk, f); return c ? { click: c } : null; }
        if (k === 'seal' || k === 'fill') { const it = this.tempItem; if (!it) return null; return P.ways(world, tk, { name: it, props: {} }, it, [f], { max: 1 })[0] || null; }
        if (k === 'place') {
            const r = this.t.recipeOf(tk); if (!r || !r.item) return null;
            return P.ways(world, tk, this.t.wantOf(tk), r.item, [f], { max: 1 })[0] || null;
        }
        if (k === 'ignite') { const at = tk.portal ? tk.portal.light : { x: tk.x, y: tk.y - 1, z: tk.z }; const c = P.clickable(world, at, f, { faces: ['up'] }); return c ? { light: at, click: c } : null; }
        if (k === 'pour') return true;
        return null;
    }

    /** The bot is done with its claim: what held, what did not. */
    report(name, results, now = Date.now()) {
        for (const { tk, ok, why } of results) {
            this.claims.delete(tk.k);
            if (ok) { this.tasks.delete(tk.k); this.stats[{ seal: 'sealed', fill: 'filled', clear: 'cleared', place: 'placed', fix: 'fixed', pour: 'poured', ignite: 'lit', untemp: 'untemp' }[tk.kind]]++; if (tk.kind === 'untemp') this.temps.delete(tk.k); if (tk.kind === 'fill' || tk.kind === 'seal') this.fluidLeft = [...this.tasks.values()].some((q) => q.kind === 'fill' || q.kind === 'seal'); if (tk.kind === 'place' || tk.kind === 'fix' || tk.kind === 'clear') this._lowered(tk); continue; }
            if (why === 'skipped') {
                // skipped over and over (out of reach, its own floor, no item at hand) counts as a failure in the end: a task skipped for ever held a stage (live 2026-11-22)
                const sk = (this.skips.get(tk.k) || 0) + 1; this.skips.set(tk.k, sk);
                this.cool.set(tk.k, now + 1500);
                if (sk % 20 !== 0) continue;
            }
            if (STAGE_OF[tk.kind] === 'late') this.log(`${name}: ${tk.kind} ${tk.k} failed: ${why}`);
            const n = (this.fails.get(tk.k) || 0) + 1; this.fails.set(tk.k, n); this.stats.failed++;
            this.cool.set(tk.k, now + 2000 * Math.min(n, 5));
            if (n >= MAX_FAILS) { this.parked.set(tk.k, why || 'failed'); this.tasks.delete(tk.k); this.log(`parked ${tk.kind} ${tk.k} after ${n} tries: ${why}`); this._frontier(); }
        }
    }
    release(name, tasks) { for (const tk of tasks) if (this.claims.get(tk.k) === name) this.claims.delete(tk.k); }
    leave(name) { for (const [k, n] of this.claims) if (n === name) this.claims.delete(k); this.bots.delete(name); }
    _lowered(tk) { if (tk.y === this.frontier || tk.y === this.clearTop) this._frontier(); }

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
        return { stage: this.done ? 'done' : this.stage, time: Object.fromEntries(Object.entries(this.time).map(([k, v]) => [k, Math.round(v / 1000)])), work: by, claimed: this.claims.size, parked: this.parked.size, right: last ? last.right : 0, total: this.t.n, stats: this.stats, frontier: Number.isFinite(this.frontier) ? this.frontier - this.t.box.y : null, result: this.result };
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
