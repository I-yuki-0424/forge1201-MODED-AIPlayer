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
const SV = require('./survey');
const { survey } = SV;
const { seen, eyeOf, boxDist } = require('./world');
const { View, feet } = require('./move');
const P = require('./place');

const REACH = 4.4;                 // eye to the cell's box (a vanilla client picks within 4.5)
const WINDOW = 2;                  // layers above the lowest open one that may be placed at the same time
const MAX_FAILS = 8;               // tries of one cell before it is parked (reported, not tried again until the next round)
const BATCH = 64;                  // tasks per claim (everything within reach of the stance: walking was the largest share of the time, live 2026-11-22)
const ROUNDS = 3;                  // extra rounds for parked cells before the build ends with them reported
const STALL_MS = 40000;            // nothing ready for anybody this long while work is left: the ordering rules are relaxed (a dependency that cannot be met)
const STAGE_OF = { seal: 'prepare', fill: 'prepare', clear: 'prepare', place: 'place', fix: 'place', scaffold: 'place', pour: 'late', ignite: 'late', untemp: 'cleanup' };
const ORDER = ['prepare', 'place', 'late', 'cleanup'];
const key = (x, y, z) => `${x},${y},${z}`;
// natural ground a stance may be dug into (outside the box)
const TERRAIN = /^(dirt|grass_block|coarse_dirt|podzol|rooted_dirt|mud|clay|stone|deepslate|cobblestone|andesite|diorite|granite|tuff|calcite|gravel|sand|red_sand|sandstone|red_sandstone|terracotta|[a-z_]+_terracotta|netherrack|basalt|blackstone|soul_sand|soul_soil|crimson_nylium|warped_nylium|snow_block|moss_block|[a-z_]*_ore|end_stone|smooth_basalt|dripstone_block)$/;
// blocks that are full cubes (the click search may count one the claim places before as standing)
const FULL = /^(stone|smooth_stone|cobblestone|stone_bricks|glass|dirt|netherrack|obsidian|blackstone|basalt|polished_.*|.*_planks|.*_concrete|.*_terracotta|.*_wool|redstone_block|iron_block|gold_block|diamond_block|emerald_block|lapis_block|coal_block|quartz_block|.*_stained_glass|tinted_glass|sandstone|end_stone|purpur_block|deepslate.*|tuff|calcite|andesite|diorite|granite|bricks|mud_bricks|.*_log|.*_wood)$/;

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
        this.temps = new Map();            // temporary blocks a mover placed ('x,y,z' -> { how: pillar | bridge | temp, by, name, t }); scaffolds (supports for a placement) are apart
        this.untemps = new Set();          // their untemp tasks: offered in every stage, not only at the end (thousands stood on the site, owner 2026-11-23 problem 2)
        this.sector = new Map();           // bot -> its share of the box's ground plan (a pit's lane: the same bot works the same piece, owner 2026-11-23 problem 3)
        this.tempItem = opts.tempItem || null;
        this.time = { walk: 0, dig: 0, place: 0, trip: 0, idle: 0, claim: 0 };
        this.stats = { placed: 0, cleared: 0, scaffolds: 0, sealed: 0, filled: 0, fixed: 0, poured: 0, lit: 0, untemp: 0, failed: 0, surveys: 0, escapes: 0, trips: 0 };
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
            // (inside the box only where the cell is to be empty: elsewhere the survey's own clear-then-place task has it)
            for (const [k, m] of this.temps) { const [x, y, z] = k.split(',').map(Number); if (this.t.inside(x, y, z) && !this.t.isAir(this.t.idx(x, y, z))) { this.temps.delete(k); continue; } const h = seen(bot, { x, y, z }); if (!h) continue; if (h.name !== (m.name || this.tempItem)) { this.temps.delete(k); continue; } sv.tasks.push({ k, kind: 'untemp', i: -1, x, y, z }); }
            for (const tk of sv.tasks) {
                if (this.parked.has(tk.k)) continue;
                if (tk.kind !== 'seal' && tk.kind !== 'ignite' && this.available && !this._itemOk(tk)) { this.parked.set(tk.k, `missing_item ${this._itemOf(tk)}`); continue; }
                tasks.set(tk.k, tk);
            }
            this.tasks = tasks;
            this.untemps = new Set([...tasks.values()].filter((tk) => tk.kind === 'untemp'));
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

    _itemOf(tk) { if (tk.kind === 'fill' || tk.kind === 'seal' || tk.kind === 'scaffold') return this.tempItem || this.sealItem; if (tk.kind === 'ignite') return 'flint_and_steel'; const r = tk.i >= 0 ? this.t.recipeOf(tk) : null; return r && r.item; }
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
        let f = Infinity, c = -Infinity; const now = Date.now();
        for (const tk of this.tasks.values()) {
            if (this.parked.has(tk.k)) continue;
            // a cell no stance has reached for 15 s does not hold the window (four unreachable cells in the lowest layer left eight bots idle with 7 500 blocks above, live
            // 2026-11-23 fy1 w2); it is still offered and tried, and parked after two minutes
            const ns = this.noStance.get(tk.k); if (ns && now - ns > 15000 && (tk.kind === 'place' || tk.kind === 'fix')) continue;
            if ((tk.kind === 'place' || tk.kind === 'fix') && tk.y < f) f = tk.y;
            if (tk.kind === 'clear' && tk.y > c) c = tk.y;
        }
        this.frontier = f; this.clearTop = c;
    }

    // ---- what may be done now --------------------------------------------------------------------------------------------------------------------------------------------

    /** Is task `tk` ready in `bot`'s view of the world? (`pending`: cells this bot has just sent a placement for and not read back yet: they count as standing.) */
    ready(tk, bot, now, pending = null, soft = false) {
        if (this.parked.has(tk.k) || (this.cool.get(tk.k) || 0) > now) return false;
        if (tk.kind === 'untemp') return !this.tasks.has(key(tk.x, tk.y + 1, tk.z)) || this.tasks.get(key(tk.x, tk.y + 1, tk.z)).kind !== 'untemp';      // any stage; the top of a stack first
        // a wrong block dug out of a cell to place (kind clear, `after` place) belongs to the place stage: it was never ready there and held the crew idle for good (live 2026-11-23 fx1 w1)
        if (STAGE_OF[tk.kind] !== this.stage && !(tk.after && STAGE_OF[tk.after] === this.stage)) {
            // placing overlaps clearing: a block goes in as soon as its own neighbourhood is cleared (a few hard cells anywhere held the whole build in the prepare stage, live 2026-11-22)
            if (!(this.stage === 'prepare' && (tk.kind === 'place' || tk.kind === 'fix' || tk.kind === 'scaffold') && this._clearAround(tk))) return false;
        }
        if (this.relaxed) return true;
        if (tk.kind === 'scaffold') return true;
        if (tk.kind === 'clear') {
            // a scaffold stays while a block beside it still waits to be placed against it
            if (this.scaffolds && this.scaffolds.has(tk.k) && [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].some(([dx, dy, dz]) => { const o = this.tasks.get(key(tk.x + dx, tk.y + dy, tk.z + dz)); return o && o.kind === 'place'; })) return false;
            // natural leaves fall by themselves once the logs near them are gone (a player cuts the trunk, not the crown): they wait while a log stands within six
            const here = seen(bot, tk);
            if (here && /_leaves$/.test(here.name) && here.props.persistent !== 'true' && this._logNear(bot, tk)) return false;
            // top-down, layer by layer (the crew stands on the floor it digs: a column cleared ahead of its neighbours is a shaft whose lower cells no eye sees, live 2026-11-22);
            // never next to a fluid (it would run in)
            // the nine cells above first (no shaft runs ahead of its neighbours; a local rule, so one stuck cell holds only what is under it)
            // natural leaves above do not count: they wait for the logs below them to go (they decay), so counting them locked trees for good (3 of 5 987 clear tasks ready,
            // live 2026-11-22 sL2)
            if (this._covered(tk, bot)) return false;
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
                const c = { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz }, h = seen(bot, c);
                if (h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true')) {
                    // a fluid nobody is to fill or seal: a task for it (the clearing beside it waited for good, live 2026-11-22 sR2 w5)
                    if (h.props.waterlogged !== 'true') this._fluidTask(c);
                    return false;
                }
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

    /** The fill and seal tasks by 8-cell grid square, rebuilt when the task map is replaced (a survey) or every 20 s (filled ones drop out by the identity check). */
    _fluidGrid() {
        const now = Date.now();
        if (this._fg && this._fgTasks === this.tasks && now - this._fgAt < 20000) return this._fg;
        const g = new Map();
        for (const o of this.tasks.values()) { if (o.kind !== 'fill' && o.kind !== 'seal') continue; const k = `${Math.floor(o.x / 8)},${Math.floor(o.y / 8)},${Math.floor(o.z / 8)}`; (g.get(k) || g.set(k, []).get(k)).push(o); }
        this._fg = g; this._fgTasks = this.tasks; this._fgAt = now;
        return g;
    }

    /** A fill (inside the box) or seal (outside) task for the fluid in cell c, unless there is one or it is parked. */
    _fluidTask(c) {
        const k = key(c.x, c.y, c.z);
        if (this.tasks.has(k) || this.parked.has(k)) return;
        const inside = this.t.inside(c.x, c.y, c.z);
        const t = { k, x: c.x, y: c.y, z: c.z, i: inside ? this.t.idx(c.x, c.y, c.z) : -1, kind: inside ? 'fill' : 'seal' };
        this.tasks.set(k, t);
        const bk = `${Math.floor(c.x / 8)},${Math.floor(c.y / 8)},${Math.floor(c.z / 8)}`; (this.buckets.get(bk) || this.buckets.set(bk, []).get(bk)).push(t);
        this.fluidLeft = true; this._fg = null;
    }

    /** A scaffold task in a cell beside tk that is to end up empty (below first), unless one is there already. */
    _scaffoldFor(tk) {
        for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            const c = { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz }, k = key(c.x, c.y, c.z);
            if (this.parked.has(k)) continue;
            if (this.tasks.has(k)) { if (this.tasks.get(k).kind === 'scaffold') return false; continue; }
            if (this.t.inside(c.x, c.y, c.z) && !this.t.isAir(this.t.idx(c.x, c.y, c.z))) continue;
            const s = { k, x: c.x, y: c.y, z: c.z, i: -1, kind: 'scaffold' };
            this.tasks.set(k, s);
            const bk = `${Math.floor(c.x / 8)},${Math.floor(c.y / 8)},${Math.floor(c.z / 8)}`; (this.buckets.get(bk) || this.buckets.set(bk, []).get(bk)).push(s);
            this.log(`scaffold at ${k} for ${tk.kind} ${tk.k} (${S.bare(this.t.wantOf(tk).name)})`);
            return true;
        }
        return false;
    }

    /** Is a clear task still in one of the nine cells above clear task tk (natural leaves do not count; whether a task's cell is leaves is looked up once)? Cheap: map lookups. */
    _covered(tk, bot) {
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
            const up = this.tasks.get(key(tk.x + dx, tk.y + 1, tk.z + dz));
            if (!up || up.kind !== 'clear' || this.parked.has(up.k)) continue;
            if (up.leaf === undefined) { const uh = seen(bot, up); up.leaf = !!uh && /_leaves$/.test(uh.name) && uh.props.persistent !== 'true'; }
            if (up.leaf) continue;
            return true;
        }
        return false;
    }

    /** A log within six cells (leaves near one do not decay). */
    _logNear(bot, c) {
        for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) for (let dz = -6; dz <= 6; dz++) {
            if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 6) continue;
            const h = seen(bot, { x: c.x + dx, y: c.y + dy, z: c.z + dz });
            if (h && /(_log|_wood|_stem|mangrove_roots)$/.test(h.name) && (this.tasks.get(key(c.x + dx, c.y + dy, c.z + dz)) || {}).kind === 'clear') return true;      // only a log that is to go (one outside the box stays: its leaves would wait for ever)
        }
        return false;
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
        // fluids still to fill or seal within four cells (a global "fluids left" held every block of the box for one fill nobody could reach, live 2026-11-22); through a grid of
        // the fluid tasks (looking up 300 cells for every task made each claim take 450 ms, live 2026-11-22 sZ)
        const fg = this._fluidGrid();
        if (fg.size) {
            const G = 8, gx = Math.floor(tk.x / G), gy = Math.floor(tk.y / G), gz = Math.floor(tk.z / G);
            for (let ax = gx - 1; ax <= gx + 1; ax++) for (let ay = gy - 1; ay <= gy + 1; ay++) for (let az = gz - 1; az <= gz + 1; az++) {
                const l = fg.get(`${ax},${ay},${az}`); if (!l) continue;
                for (const o of l) if (this.tasks.get(o.k) === o && (o.kind === 'fill' || o.kind === 'seal') && Math.abs(o.x - tk.x) <= 4 && Math.abs(o.y - tk.y) <= 4 && Math.abs(o.z - tk.z) <= 4 && Math.abs(o.x - tk.x) + Math.abs(o.y - tk.y) + Math.abs(o.z - tk.z) <= 6) return false;
            }
        }
        return true;
    }

    /** Why task `tk` is not ready (for the stall log): the first rule that holds it. */
    whyNot(tk, bot, now) {
        if (this.parked.has(tk.k)) return 'parked';
        if ((this.cool.get(tk.k) || 0) > now) return 'cooling';
        if (STAGE_OF[tk.kind] !== this.stage && !(this.stage === 'prepare' && (tk.kind === 'place' || tk.kind === 'fix') && this._clearAround(tk))) return this.stage === 'prepare' && (tk.kind === 'place' || tk.kind === 'fix') ? 'clearing or fluids around it' : `stage ${STAGE_OF[tk.kind]}`;
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

    /**
     * Cells a station must not take: the bodies of the other bots, the cells of tasks other bots hold now (they are about to be filled), and in the late stage the cells that will hold
     * a block. A target cell that is not claimed yet may be stood in: a player stands on the floor it builds (forbidding every target cell of the window left the inside of a 48x48
     * floor out of reach for good, live 2026-11-22); a block whose cell a body occupies waits until it moves.
     */
    standBlocked(name) {
        const busy = new Set();
        for (const [n, b] of this.bots) if (n !== name && b.station) for (const c of b.station) busy.add(key(c.x, c.y, c.z));
        for (const [k, n] of this.claims) if (n !== name) busy.add(k);
        const t = this.t, stage = this.stage;
        return (x, y, z) => {
            if (busy.has(key(x, y, z))) return true;
            if (stage !== 'late' || !t.inside(x, y, z)) return false;
            return !t.isAir(t.idx(x, y, z));
        };
    }

    // ---- temporary blocks -----------------------------------------------------------------------------------------------------------------------------------------------------

    /** A mover placed a temporary block (a pillar or bridge for walking; its own pillar it digs down itself when it leaves, the rest becomes an untemp task once nobody uses it). */
    addTemp(c, how, by, name) { if (this.t.inside(c.x, c.y, c.z) && !this.t.isAir(this.t.idx(c.x, c.y, c.z))) return; this.temps.set(key(c.x, c.y, c.z), { how, by, name, t: Date.now() }); }
    dropTemp(c) { const k = key(c.x, c.y, c.z); this.temps.delete(k); const tk = this.tasks.get(k); if (tk && tk.kind === 'untemp') { this.tasks.delete(k); this.untemps.delete(tk); } }

    /**
     * Temporary blocks nobody stands on or above any more (no bot's body, stance or claim in their column) become untemp tasks after a few seconds, in any stage: walking blocks are not
     * kept (owner 2026-11-23: pillars and bridges for moving need no reuse). Scaffolds, the supports a placement needs, are not temps and stay while a block waits against them.
     */
    _offerTemps(now, bot = null) {
        if (now - (this._offerAt || 0) < 3000 || !this.temps.size) return;
        this._offerAt = now;
        const cols = []; for (const b of this.bots.values()) { if (b.pos) cols.push(b.pos); if (b.station) cols.push(b.station[0]); }
        if (bot) for (const p of Object.values(bot.players || {})) if (p && p.entity && this.bots.has(p.username)) { const q = p.entity.position; cols.push({ x: Math.floor(q.x), y: Math.floor(q.y + 0.16), z: Math.floor(q.z) }); }
        for (const [k, m] of this.temps) {
            if (this.tasks.has(k) || now - m.t < 8000) continue;
            const [x, y, z] = k.split(',').map(Number);
            if (cols.some((p) => Math.abs(p.x - x) <= 0 && Math.abs(p.z - z) <= 0 && p.y > y && p.y <= y + 80)) continue;
            const tk = { k, kind: 'untemp', i: -1, x, y, z };
            this.tasks.set(k, tk); this.untemps.add(tk);
        }
    }

    /** Park the place tasks that need items the supply is out of (tried again next round). */
    parkItems(items) {
        const set = new Set(items); let n = 0;
        for (const tk of [...this.tasks.values()]) if (tk.kind === 'place' && set.has(this._itemOf(tk)) && !this.claims.has(tk.k)) { this.parked.set(tk.k, `missing_item ${this._itemOf(tk)}`); this.tasks.delete(tk.k); n++; }
        if (n) { this.log(`parked ${n} cells: the supply is out of ${items.join(', ')}`); this._frontier(); }
    }

    /** A stance `name` found no way to: not offered to it again for three minutes. */
    avoid(name, f) { const m = this.bad || (this.bad = new Map()); let s = m.get(name); if (!s) m.set(name, (s = new Map())); s.set(key(f.x, f.y, f.z), Date.now() + 180000); }
    avoided(name, f) { const s = this.bad && this.bad.get(name); if (!s) return false; const k = key(f.x, f.y, f.z), t = s.get(k); if (!t) return false; if (t < Date.now()) { s.delete(k); return false; } return true; }

    // ---- sectors -----------------------------------------------------------------------------------------------------------------------------------------------------------

    /**
     * The bot's sector: the box's ground plan cut into one piece per crew member (columns x rows, pieces as square as the box allows), given once in the order the bots first claim
     * (a bot keeps its piece; a piece whose bot is gone is helped like any other). Eight bots seeded by the lowest or highest cell anywhere crowded one corner of the box, several on
     * the same cell, and their stances moved a few cells at each claim (owner 2026-11-23, problems 3 and 9).
     */
    sectorOf(name) {
        if (!this.sector.has(name)) {
            const n = Math.max(this.bots.size, this.sector.size + 1, 1), b = this.t.box;
            if (!this._grid || this._grid.n < n) {
                let best = null;
                for (let c = 1; c <= n; c++) { const r = Math.ceil(n / c), a = (b.sx / c) / (b.sz / r), cost = Math.abs(Math.log(a)) + (c * r - n) * 0.8; if (!best || cost < best.cost) best = { c, r, cost }; }
                this._grid = { n, c: best.c, r: best.r };
            }
            const used = new Set(this.sector.values()), idx = [...Array(this._grid.c * this._grid.r).keys()].find((i) => !used.has(i)) ?? this.sector.size % (this._grid.c * this._grid.r);
            this.sector.set(name, idx);
        }
        const { c, r } = this._grid, i = this.sector.get(name), col = i % c, row = Math.floor(i / c) % r, b = this.t.box;
        return { x0: b.x + Math.floor(col * b.sx / c), x1: b.x + Math.floor((col + 1) * b.sx / c) - 1, z0: b.z + Math.floor(row * b.sz / r), z1: b.z + Math.floor((row + 1) * b.sz / r) - 1 };
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
        this._offerTemps(now, bot);
        const sec = this.sectorOf(name), inSec = (tk) => tk.x >= sec.x0 && tk.x <= sec.x1 && tk.z >= sec.z0 && tk.z <= sec.z1;
        // the bot's own sector first, nearest first within it; the rest of the box after it (helping where a sector is done or its bot is gone)
        const keys = [...this.buckets.keys()].map((k) => { const [x, y, z] = k.split(',').map(Number), mine = x * G + G - 1 >= sec.x0 && x * G <= sec.x1 && z * G + G - 1 >= sec.z0 && z * G <= sec.z1; return { k, d: Math.hypot(x * G + G / 2 - me.x, (y * G + G / 2 - me.y) * 1.5, z * G + G / 2 - me.z) + (mine ? 0 : 1000) }; }).sort((a, b) => a.d - b.d);
        // temporary blocks to take away near the bot, in any stage
        for (const tk of [...this.untemps]) {
            if (this.tasks.get(tk.k) !== tk) { this.untemps.delete(tk); continue; }
            if (this.claims.has(tk.k) || Math.hypot(tk.x - me.x, tk.y - me.y, tk.z - me.z) > 24) continue;
            if (this._already(tk, bot)) { this.tasks.delete(tk.k); this.untemps.delete(tk); this.temps.delete(tk.k); continue; }
            if (this.ready(tk, bot, now)) ready.push(tk);
        }
        const lo = this.stage === 'place' ? this.frontier : -Infinity, hi = this.stage === 'place' ? this.frontier + this.o.window : Infinity;
        const tScan = Date.now();
        for (const { k } of keys) {
            // the scan is synchronous: at most 60 ms of it per claim (eight bots claiming over 17 000 tasks blocked every bot's keep-alive for seconds, live 2026-11-23 fx3 profile)
            if (Date.now() - tScan > 60) break;
            const [, by] = k.split(',').map(Number);
            if (by * G > hi || by * G + G - 1 < lo) continue;
            // done tasks leave their bucket here (kept, 23 000 cleared cells filled the scan budget and a claim saw 5 ready tasks out of thousands, live 2026-11-22 sD2)
            const live = this.buckets.get(k).filter((tk) => this.tasks.get(tk.k) === tk);
            if (live.length) this.buckets.set(k, live); else { this.buckets.delete(k); continue; }
            for (const tk of live) {
                if (this.claims.has(tk.k) || tk.kind === 'untemp') continue;
                scanned++;
                // the cheap reasons first (map lookups only): most of a box to clear lies under cells still to clear, most of a box to build above the window; the costly
                // checks (the world's blocks) only for the rest (6 000 costly checks per claim saw 5 ready tasks out of 28 000, the ready top layer out of reach, live 2026-11-22 sM2)
                if (tk.kind === 'clear' && !this.relaxed && this.stage === 'prepare' && this._covered(tk, bot)) continue;
                if ((tk.kind === 'place' || tk.kind === 'fix') && !this.relaxed && this.stage === 'place' && tk.y > this.frontier + this.o.window) continue;
                // already as it should be (dug on someone's way, leaves that decayed, a block another bot put there): done, not offered (a clear task on air found no stance and was parked, live 2026-11-22)
                if (tk.after) { const h = seen(bot, tk); if (h && S.AIR.has(h.name)) { tk.kind = tk.after; delete tk.after; } }
                if (this._already(tk, bot)) { this.tasks.delete(tk.k); this._lowered(tk); continue; }
                // a wrong block where one is to be placed (rubble left, a block pushed or dropped there): dug out first, then placed (nobody removed it and the cell was parked, live 2026-11-22 sW w2)
                if (tk.kind === 'place') { const h = seen(bot, tk); if (h && !S.AIR.has(h.name) && !SV.FLUID(h)) { tk.kind = 'clear'; tk.after = 'place'; } }          // grass, snow too: the ray of a click stops in them (parked smooth stone on short grass, live 2026-11-22 sN2 w3)
                if (this.ready(tk, bot, now)) ready.push(tk);
            }
            if (ready.length >= 300 || scanned >= 60000) break;
        }
        if (!ready.length) {
            this.nothingWhy = `nothing ready in stage ${this.stage} (${this.tasks.size} tasks, ${this.claims.size} claimed by others, frontier ${Number.isFinite(this.frontier) ? this.frontier : '-'}, parked ${this.parked.size})`;
            this._stall(bot, now);
            return null;
        }
        // what the bot can do with what it carries; the rest says what to fetch
        const item = (tk) => this._itemOf(tk);
        // never the block a bot stands on (in the Nether a bot fell into the lava when another cleared its floor, live 2026-11-21)
        const floors = new Set([...this.bots.values()].map((b) => b.pos && key(b.pos.x, b.pos.y - 1, b.pos.z)).concat([...this.bots.values()].filter((b) => b.station).map((b) => key(b.station[0].x, b.station[0].y - 1, b.station[0].z))));
        floors.add(key(me.x, me.y - 1, me.z));
        const doable = ready.filter((tk) => { if ((tk.kind === 'clear' || tk.kind === 'untemp') && floors.has(tk.k)) return false; const it = item(tk); return !it || tk.kind === 'clear' || tk.kind === 'fix' || tk.kind === 'untemp' || has(it) > 0; });
        if (!doable.length) {
            // the work left is under bots' feet: the one standing on it steps off (idle bots stood on the last cells to clear for half an hour, live 2026-11-22 sI w2)
            if (ready.some((tk) => (tk.kind === 'clear' || tk.kind === 'untemp') && tk.k === key(me.x, me.y - 1, me.z))) return { moveOff: true };
            // only cells under bots' feet are ready (temporary blocks they stand on): as good as nothing ready, so the stall rule still applies
            if (ready.every((tk) => tk.kind === 'clear' || tk.kind === 'untemp')) { this.nothingWhy = `only cells under bots' feet are ready (${ready.length})`; this._stall(bot, now); return null; }
            const need = {}; for (const tk of ready.slice(0, 200)) { if (tk.kind === 'fix' || tk.kind === 'clear') continue; const it = item(tk); if (it) need[it] = (need[it] || 0) + 1; }
            return { need };
        }
        const down = this.stage === 'prepare';
        const crowd = (tk) => others.reduce((s, o) => s + (Math.hypot(o.x - tk.x, o.z - tk.z, (o.y - tk.y) / 2) < 6 ? 1 : 0), 0);
        // own sector first (400 outweighs any height or distance), then the layer (top-down clearing, bottom-up placing), then nearness: a bot works on where it is; a second bot
        // within six cells costs as much as ten layers; temporary blocks near the bot go first (they are in someone's way)
        const seedScore = (tk) => {
            const d = Math.hypot(tk.x - me.x, tk.y - me.y, tk.z - me.z);
            if (tk.kind === 'untemp') return d <= 6 ? 1500 + d : 2600 + d * 2;          // after the real work unless right beside the bot (at -3000 the crew gathered on every leftover pillar, owner 2026-11-23)
            return (tk.kind === 'place' || tk.kind === 'fix' ? 2000 + tk.y * 3 : (down ? -tk.y : tk.y) * 2) + d * 0.6 + crowd(tk) * 30 + (inSec(tk) ? 0 : 400) + (tk.kind === 'seal' || tk.kind === 'fill' ? -1000 : 0);
        };
        doable.sort((a, b) => seedScore(a) - seedScore(b));
        const view = new View(bot, { canDig: () => false }), blocked = this.standBlocked(name);
        // the cells this bot can reach, when a search from where it stands found them all (move.js plan region): only stances among them
        const R = this.reachOf && this.reachOf.get(name), inReach = R && R.from === key(me.x, me.y, me.z) ? (f) => R.cells.has(key(f.x, f.y, f.z)) : null;
        // a spatial index of the doable tasks: a stance is first ranked by how many it has within reach (cheap); the click search (place.ways: rays and the vanilla model) runs only for
        // the best few (live 2026-11-21 sv5: the search for every stance and task blocked the process 4.5 s per claim)
        const grid = new Map(), g = (v) => Math.floor(v / 4);
        for (const tk of doable) { const kk = `${g(tk.x)},${g(tk.y)},${g(tk.z)}`; (grid.get(kk) || grid.set(kk, []).get(kk)).push(tk); }
        const near = (eye) => { const out = []; for (let gx = g(eye.x - 5); gx <= g(eye.x + 5); gx++) for (let gy = g(eye.y - 5); gy <= g(eye.y + 5); gy++) for (let gz = g(eye.z - 5); gz <= g(eye.z + 5); gz++) { const l = grid.get(`${gx},${gy},${gz}`); if (l) for (const tk of l) if (boxDist(eye, tk) <= this.o.reach) out.push(tk); } return out; };
        // seeds until one has a stance, within a quarter second (three seeds and five stances each left bots idle with hundreds of ready tasks: the best-ranked stances were inside
        // rock, where the line of sight is blocked, live 2026-11-22 sV)
        const t0 = Date.now(); let outOfReach = 0;
        for (const seed of doable.slice(0, 12)) {
            if (Date.now() - t0 > 250) break;
            let best = null;
            const cands = [], rej = { blocked: 0, lava: 0, solid: 0, unsupported: 0, far: 0, way: 0, nothingToClick: 0 };
            // a block to place with nothing beside it (a part of the build in the air): it is clicked onto the top of the pillar the bot stands on, so only stances whose pillar
            // top touches the cell can do it (ranked by pillar height, they never made the first twelve: 4 495 cells parked, live 2026-11-22 sB2 w2)
            const AIRY = (h) => !h || S.AIR.has(h.name) || h.name === 'water' || h.name === 'lava';
            const lonely = (seed.kind === 'place' || seed.kind === 'scaffold') && [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].every(([dx, dy, dz]) => AIRY(seen(bot, { x: seed.x + dx, y: seed.y + dy, z: seed.z + dz })));
            for (const f of stationsAround(seed, this.o.reach, down)) {
                if (cands.length >= 40) break;
                if (blocked(f.x, f.y, f.z) || blocked(f.x, f.y + 1, f.z) || bodyCovers(f, seed) || this.avoided(name, f)) { rej.blocked++; continue; }
                if (inReach && !inReach(f)) { rej.unreachable = (rej.unreachable || 0) + 1; outOfReach++; continue; }
                if (view.nearLava(f.x, f.y, f.z)) { rej.lava++; continue; }                 // the mover never goes there: offered, it cost a 4 s search each time
                // clearing: a stance may be inside rock that is to be cleared anyway (a box sunk in rock has no open cell near its top layer); the walk digs its way in
                const dug = !view.fits(f.x, f.y, f.z);
                // a stance dug into the ground: cells to clear anyway, or natural terrain outside the box (the edge cells of a box sunk in rock had no stance and everything
                // under them stayed unmined, owner 2026-11-23 list 3 problem 2); never a built cell; on a floor
                const diggableAt = (y) => { if (view.free(f.x, y, f.z) || (this.tasks.get(key(f.x, y, f.z)) || {}).kind === 'clear') return true; if (this.t.inside(f.x, y, f.z)) return false; const q = view.raw(f.x, y, f.z); return !!q && TERRAIN.test(q.name); };
                if (dug && !([f.y, f.y + 1].every(diggableAt) && (view.stands(f.x, f.y - 1, f.z) || view.kind(f.x, f.y - 1, f.z) === 'solid'))) { rej.solid++; continue; }
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
                    } else {
                        // a pillar only through cells a block can go into (a stance over built wire or torches had a pillar the server refused: owner 2026-11-23 problem 1)
                        let okp = true; for (let j = 1; j <= h && okp; j++) if (!view.placeable(f.x, f.y - j, f.z)) okp = false;
                        if (!okp) { rej.unsupported++; continue; }
                    }
                }
                // a temporary block is taken away only from where the bot can stand now: a new pillar to reach an old one made pillars without end (owner 2026-11-23)
                if (seed.kind === 'untemp' && !standing) { rej.unsupported++; continue; }
                if (lonely && (standing || dug || wet || Math.abs(f.x - seed.x) + Math.abs(f.y - 1 - seed.y) + Math.abs(f.z - seed.z) !== 1)) { rej.nothingToClick++; continue; }
                const eye = eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 });
                if (boxDist(eye, seed) > this.o.reach) { rej.far++; continue; }
                const reach = near(eye).filter((tk) => !bodyCovers(f, tk));
                cands.push({ f, standing, dug, reach, score: reach.length - Math.hypot(f.x - me.x, f.y - me.y, f.z - me.z) * 0.08 - (standing ? 0 : 10 + 3 * h) - (dug ? 20 : 0) });
            }
            cands.sort((a, b) => b.score - a.score);
            for (const c of cands.slice(0, 12)) {
                const world = this._world(bot, c.standing ? null : c.f, c.dug ? c.f : null);
                const way = this._way(world, seed, c.f);
                if (!way) { rej.way++; continue; }
                const batch = [{ ...seed, way }];
                for (const tk of c.reach) { if (tk === seed || batch.length >= BATCH) continue; const w = this._way(world, tk, c.f); if (w) batch.push({ ...tk, way: w }); }
                if (down && seed.kind === 'clear') this._deepen(bot, world, c.f, batch, floors);
                if (seed.kind === 'place') this._widen(bot, world, c.f, batch, has, now);
                best = { f: c.f, batch };
                break;
            }
            if (!best) {
                this.cool.set(seed.k, now + 6000);
                // a block in the air whose own orientation no pillar edge gives (a chest faces the player): a scaffold block beside it first, in a cell that stays empty in the
                // end, below it if that can be; the block then goes against the scaffold from any side (Nether chests over the lava sea were parked, live 2026-11-22 sG2 w6)
                if (lonely && seed.kind === 'place' && this._scaffoldFor(seed)) { this.noStance.delete(seed.k); continue; }
                // a task no stance reaches is parked after a few looks (it waits for the next round, when the build has changed what can be reached): a handful of hidden cells
                // held the whole build in the prepare stage (live 2026-11-22 sv8)
                const ns = this.noStance.get(seed.k) || now; this.noStance.set(seed.k, ns);
                if (now - ns > 60000) { this.parked.set(seed.k, `no stance (${cands.length} in range)`); this.tasks.delete(seed.k); this.log(`parked ${seed.kind} ${seed.k} (${seed.i >= 0 ? S.bare(this.t.wantOf(seed).name) : 'outside'}): no stance reaches it (${cands.length} stances in range; rejected ${JSON.stringify(rej)}; the cell holds ${(seen(bot, seed) || {}).name}; neighbours ${['up', 'down', 'north', 'south', 'west', 'east'].map((d, i) => { const o = [[0, 1, 0], [0, -1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]][i], h = seen(bot, { x: seed.x + o[0], y: seed.y + o[1], z: seed.z + o[2] }); return `${d}:${h ? S.bare(h.name) : '?'}`; }).join(' ')})`); this._frontier(); }
                continue;
            }
            this.lastClaimInfo = `scanned ${scanned}, ready ${ready.length}, doable ${doable.length}, seeds to here ${doable.indexOf(seed) + 1}, batch ${best.batch.length}, ${Date.now() - t0} ms in seeds`;
            // never the stance's own floor (it is not dug from on top of it)
            const tasks = best.batch.filter((tk) => !((tk.kind === 'clear' || tk.kind === 'untemp') && tk.x === best.f.x && tk.z === best.f.z && tk.y === best.f.y - 1)).sort((a, b) => ((a.kind === 'clear') !== (b.kind === 'clear') ? (a.kind === 'clear' ? -1 : 1) : 0) || (a.kind === 'clear' ? b.y - a.y : a.y - b.y) || a.x - b.x || a.z - b.z);
            if (!tasks.length) { this.cool.set(seed.k, now + 3000); continue; }
            this.stallSince = 0;
            for (const tk of tasks) this.claims.set(tk.k, name);
            this.bots.set(name, { station: [best.f, { x: best.f.x, y: best.f.y + 1, z: best.f.z }], pos: me });
            return { station: best.f, tasks };
        }
        if (now - (this._frontierAt || 0) > 5000) { this._frontierAt = now; this._frontier(); }
        this._stall(bot, now);            // ready work that no stance reaches counts as nothing ready for the stall rule (a single unreachable cell kept a crew idle)
        // ready work there is, but only out of the bot's reach: it is in a pocket (drive.js takes it out)
        if (inReach && outOfReach) (this.pocketed || (this.pocketed = new Set())).add(name);
        this.lastClaimInfo = `no stance: scanned ${scanned}, ready ${ready.length}, doable ${doable.length}, ${Date.now() - t0} ms in seeds`;
        // what can be done with what it carries reaches nowhere, but ready work waits for items: fetch them (a crew stood idle with ready blocks and empty packs, live 2026-11-22)
        { const need = {}; for (const tk of ready) { if (doable.includes(tk)) continue; const it = item(tk); if (it) need[it] = (need[it] || 0) + 1; } if (Object.keys(need).length) return { need }; }
        if (now - (this.diagAt || 0) > 30000) {
            this.diagAt = now;
            // every task by the cheap reasons, the costly reason for the first 4000 of the rest
            const why = { claimed: 0, 'under a cell to clear': 0, 'above the window': 0 }; let n = 0;
            for (const tk of this.tasks.values()) {
                if (this.claims.has(tk.k)) { why.claimed++; continue; }
                if (tk.kind === 'clear' && this._covered(tk, bot)) { why['under a cell to clear']++; continue; }
                if ((tk.kind === 'place' || tk.kind === 'fix') && this.stage === 'place' && tk.y > this.frontier + this.o.window) { why['above the window']++; continue; }
                if (n++ > 4000) { why['not looked at'] = (why['not looked at'] || 0) + 1; continue; }
                const w = this.whyNot(tk, bot, now).replace(/ \d.*$/, '').replace(/waits for .*/, 'waits for a dependency').replace(/next to .*/, 'next to a fluid'); why[w] = (why[w] || 0) + 1;
            }
            this.log(`claim by ${name}: ${ready.length} ready, ${doable.length} doable with what it carries, no stance for the first ${Math.min(12, doable.length)} (${doable.slice(0, 3).map((t) => `${t.kind} ${t.k}`).join(', ')}); the others: ${JSON.stringify(why)}; frontier ${this.frontier}`);
        }
        return null;
    }

    /** Nothing ready for anybody for STALL_MS while work is left: the ordering rules are relaxed until the next survey (a dependency that cannot be met). */
    _stall(bot, now) {
        if (!this.claims.size && this.tasks.size && !this.relaxed) {
            if (!this.stallSince) this.stallSince = now;
            else if (now - this.stallSince > STALL_MS) {
                this.relaxed = true;
                const why = {}; const ex = [];
                for (const tk of this.tasks.values()) { const w = this.whyNot(tk, bot, now); const k = w.replace(/ \d.*$/, '').replace(/waits for .*/, 'waits'); why[k] = (why[k] || 0) + 1; if (ex.length < 6 && /waits/.test(w)) ex.push(`${tk.k} ${tk.i >= 0 ? S.bare(this.t.wantOf(tk).name) : tk.kind} ${w}`); }
                this.log(`stall in ${this.stage} (${this.tasks.size} tasks, none ready for ${Math.round((now - this.stallSince) / 1000)} s): order rules relaxed until the next survey; why ${JSON.stringify(why)}; e.g. ${ex.join(' | ')}`);
            }
        }
    }

    /**
     * Placing from one stance as a player does it: every block in reach whose supports stand or are in the claim before it (bottom-up), not only the ones that were ready when the
     * claim began. One block per stance was the rule in layers of thin parts (owner 2026-11-23). The claim's own blocks count as standing for the click search when they are full cubes.
     */
    _widen(bot, world, f, batch, has, now) {
        const inB = new Set(batch.map((t) => t.k)), eye = eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }), cand = [];
        const cube = (tk) => { const w = this.t.wantOf(tk); if (w && FULL.test(S.bare(w.name))) world.over.set(tk.k, { name: S.bare(w.name), props: {}, shapes: [[0, 0, 0, 1, 1, 1]] }); };
        for (const t of batch) if (t.kind === 'place') cube(t);
        const top = this.relaxed ? Infinity : this.frontier + this.o.window;
        for (let dy = -5; dy <= 4; dy++) for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
            const x = f.x + dx, y = f.y + dy, z = f.z + dz, k = key(x, y, z), tk = this.tasks.get(k);
            if (!tk || tk.kind !== 'place' || tk.y > top || inB.has(k) || this.claims.has(k) || this.parked.has(k) || (this.cool.get(k) || 0) > now) continue;
            if (bodyCovers(f, tk) || boxDist(eye, tk) > this.o.reach) continue;
            const it = this._itemOf(tk); if (it && !(has(it) > 0)) continue;
            cand.push(tk);
        }
        cand.sort((a, b) => a.y - b.y || Math.hypot(a.x - f.x, a.z - f.z) - Math.hypot(b.x - f.x, b.z - f.z));
        let added = 0;
        for (let pass = 0; pass < 2; pass++) for (const tk of cand) {
            if (batch.length >= BATCH) break;
            if (inB.has(tk.k)) continue;
            const h = seen(bot, tk); if (!h || !(S.AIR.has(h.name) || SV.REPLACEABLE.test(h.name))) continue;
            if (!this.ready(tk, bot, now, inB)) continue;
            const w = this._way(world, tk, f);
            if (!w) continue;
            batch.push({ ...tk, way: w }); inB.add(tk.k); cube(tk); added++;
        }
        return added;
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
        const w = P.botWorld(bot, over); w.over = over;
        return w;
    }

    /**
     * Clearing from one stance as a player does it: everything within reach, top-down, not only the top layer that is ready now. A cell under cells to clear joins the claim when
     * every one of those is in the claim before it (they are dug first; the world for the sight test has them dug). The bot then works a block of the ground from one stance instead
     * of moving a few cells for each layer (owner 2026-11-23, problem 3). Never the column under its own feet or the floor of another bot; never next to a fluid; not natural leaves.
     */
    _deepen(bot, world, f, batch, floors) {
        const inB = new Set(batch.map((t) => t.k)), eye = eyeOf({ x: f.x + 0.5, y: f.y, z: f.z + 0.5 }), cand = [];
        for (const t of batch) if (t.kind === 'clear') world.over.set(t.k, P.AIR);
        for (let dy = 5; dy >= -1; dy--) for (let dx = -5; dx <= 5; dx++) for (let dz = -5; dz <= 5; dz++) {
            const x = f.x + dx, y = f.y + dy, z = f.z + dz, k = key(x, y, z), tk = this.tasks.get(k);
            if (!tk || tk.kind !== 'clear' || tk.after || inB.has(k) || this.claims.has(k) || this.parked.has(k) || floors.has(k)) continue;
            // never below the floor, and not the floor ring around the stance (bots dug the ground out around themselves and stood on a lone column, owner 2026-11-23)
            if (y < f.y - 1 || (y === f.y - 1 && Math.abs(x - f.x) <= 1 && Math.abs(z - f.z) <= 1)) continue;
            if (bodyCovers(f, tk) || boxDist(eye, tk) > this.o.reach) continue;
            cand.push(tk);
        }
        cand.sort((a, b) => b.y - a.y);
        const WET = (h) => h && (h.name === 'water' || h.name === 'lava' || h.props.waterlogged === 'true');
        let added = 0;
        for (const tk of cand) {
            if (batch.length >= BATCH) break;
            let held = false;
            for (let ax = -1; ax <= 1 && !held; ax++) for (let az = -1; az <= 1; az++) { const up = this.tasks.get(key(tk.x + ax, tk.y + 1, tk.z + az)); if (up && up.kind === 'clear' && !this.parked.has(up.k) && !inB.has(up.k) && up.leaf !== true) { held = true; break; } }
            if (held) continue;
            const h = seen(bot, tk);
            if (!h || (/_leaves$/.test(h.name) && h.props.persistent !== 'true')) continue;
            if ([[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some(([dx, dy, dz]) => WET(seen(bot, { x: tk.x + dx, y: tk.y + dy, z: tk.z + dz })))) continue;
            const w = P.clickable(world, tk, f);
            if (!w) continue;
            batch.push({ ...tk, way: w }); inB.add(tk.k); world.over.set(tk.k, P.AIR); added++;
        }
        return added;
    }

    /** How a task is done from stance f: a click (place.ways) for blocks, a face in sight for digging, or true for work that brings its own aim. Null: not from here. */
    _way(world, tk, f) {
        const k = tk.kind;
        if (k === 'clear' || k === 'untemp') { const c = P.clickable(world, tk, f); return c || null; }
        if (k === 'fix') { const c = P.clickable(world, tk, f); return c ? { click: c } : null; }
        if (k === 'seal' || k === 'fill') { const it = this.tempItem; if (!it) return null; return P.ways(world, tk, { name: it, props: {} }, it, [f], { max: 1 })[0] || null; }
        if (k === 'place' || k === 'scaffold') {
            let want, item;
            if (k === 'scaffold') { item = this.tempItem; if (!item) return null; want = { name: item, props: {} }; }
            else { const r = this.t.recipeOf(tk); if (!r || !r.item) return null; want = this.t.wantOf(tk); item = r.item; }
            const w = P.ways(world, tk, want, item, [f], { max: 1 })[0];
            if (w) return w;
            // beside the top of the block it stands on (a cell in the air): leaning over the edge toward it
            const dx = tk.x - f.x, dz = tk.z - f.z;
            if (tk.y === f.y - 1 && Math.abs(dx) + Math.abs(dz) === 1) return P.ways(world, tk, want, item, [{ ...f, lean: [dx, dz] }], { max: 1 })[0] || null;
            return null;
        }
        if (k === 'ignite') { const at = tk.portal ? tk.portal.light : { x: tk.x, y: tk.y - 1, z: tk.z }; const c = P.clickable(world, at, f, { faces: ['up'] }); return c ? { light: at, click: c } : null; }
        if (k === 'pour') return true;
        return null;
    }

    /** The bot is done with its claim: what held, what did not. */
    report(name, results, now = Date.now()) {
        for (const { tk, ok, why } of results) {
            this.claims.delete(tk.k);
            if (ok && tk.after) { const o = this.tasks.get(tk.k); if (o) { o.kind = tk.after; delete o.after; this.cool.set(tk.k, now + 500); } this.stats.cleared++; continue; }
            if (ok) { this.tasks.delete(tk.k); this.stats[{ seal: 'sealed', fill: 'filled', clear: 'cleared', scaffold: 'scaffolds', place: 'placed', fix: 'fixed', pour: 'poured', ignite: 'lit', untemp: 'untemp' }[tk.kind]]++; if (tk.kind === 'untemp') this.temps.delete(tk.k); if (tk.kind === 'scaffold') { (this.scaffolds = this.scaffolds || new Set()).add(tk.k); if (!this.t.inside(tk.x, tk.y, tk.z)) this.temps.add(tk.k); } if (tk.kind === 'fill' || tk.kind === 'seal') this.fluidLeft = [...this.tasks.values()].some((q) => q.kind === 'fill' || q.kind === 'seal'); if (tk.kind === 'place' || tk.kind === 'fix' || tk.kind === 'clear') this._lowered(tk); continue; }
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
