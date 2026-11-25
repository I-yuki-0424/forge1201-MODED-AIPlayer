'use strict';
// Simulator parity recorder (TASK-20261125-078, docs/implemented/SIM-PARITY-v1.md). Loaded with `node --require` BEFORE anything else, it wraps
// the action layer's `execute` (src/skills/index.js) and the runner's `run` (src/skills/runner.js, for the moves that call it directly), and
// writes one JSONL file per bot: the blocks around the bot as the server sent them (chunk snapshots, then every block update), and for every
// command its arguments, the bot's state before, and the outcome the server answered (ok / reason, ticks, phases, position, inventory).
// `forgeaip-sim replay` (tools/sim/src/replay.rs) runs the same commands on the same blocks in the simulator and compares them.
//
//   scripts/t26/run.sh N place_a.js NODE_ARGS=--require=./scripts/sim/record.js [SIMREC_DIR=/out/simrec/<run>] [SIMREC_TRACE=1] [SIMREC_R=2]
//
// It changes nothing the bot does: it only reads the bot's own client state (which the server's packets keep current) and the results the
// commands return. The format is the contract with the replayer and with the tick-level traces of TASK-076 (same `hello` / `st` / `chunk` /
// `blk` lines; see the doc). Version: FORMAT below; a change of meaning bumps it.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FORMAT = 1;
const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null);
const DETAIL_CAP = 2000;

/** Enchantments as [[name, level]] from every shape prismarine-item gives (1.20.1 [{name, lvl}]; 1.20.5+ components {enchantments: [{id, level}]} or
 *  {levels: {name: level}}; the same normalisation as src/transport/fabric_bot.js normEnchants). */
function enchantsOf(e, registry) {
    const name = (id) => (typeof id === 'string' ? id.replace(/^minecraft:/, '') : ((registry && registry.enchantments && registry.enchantments[id]) || {}).name || String(id));
    if (Array.isArray(e)) return e.map((x) => [name(x.name), x.lvl]);
    if (!e || typeof e !== 'object') return [];
    if (Array.isArray(e.enchantments)) return e.enchantments.map((x) => [name(x.id), x.level]);
    if (e.levels && typeof e.levels === 'object') return Object.entries(e.levels).map(([k, v]) => [name(k), v]);
    return [];
}

/** The bot's state as the client holds it (the server's packets keep it current): what the replayer starts from and compares against. */
function botState(bot) {
    const e = bot.entity || {}, p = e.position || {}, v = e.velocity || {};
    const inv = [];
    const slots = (bot.inventory && bot.inventory.slots) || [];
    for (let i = 0; i < slots.length; i++) {
        const it = slots[i];
        if (!it) continue;
        // [slot, name, count, damage?, enchantments?]: what a replay must give back (the T26 kits carry Efficiency 255 and Unbreakable)
        const row = [i, it.name, it.count];
        let dmg = 0, ench = null;
        try { if (typeof it.durabilityUsed === 'number') dmg = it.durabilityUsed; } catch (_) { /* no durability */ }
        try { const e = enchantsOf(it.enchants, bot.registry); if (e.length) ench = e; } catch (_) { /* components this version's reader does not know */ }
        let unb = false;
        try { unb = !!(it.componentMap && it.componentMap.has('unbreakable')); } catch (_) { /* pre-component versions: NBT, not read here */ }
        if (unb) (ench = ench || []).push(['unbreakable', 1]);           // a pseudo-enchantment: the component `unbreakable={}`
        if (dmg > 0 || ench) row.push(dmg);
        if (ench) row.push(ench);
        inv.push(row);
    }
    return {
        pos: [r3(p.x), r3(p.y), r3(p.z)], vel: [r3(v.x), r3(v.y), r3(v.z)], yaw: r3(e.yaw), pitch: r3(e.pitch), ground: !!e.onGround,
        hp: r3(bot.health), food: r3(bot.food), sat: r3(bot.foodSaturation), air: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null,
        slot: typeof bot.quickBarSlot === 'number' ? bot.quickBarSlot : null, inv,
        dim: (bot.game && bot.game.dimension) || null,
    };
}

/** Dense state ids of one chunk column, y-major then z then x (index = ((y - minY) * 16 + z) * 16 + x), deflated, base64. */
function columnCells(column, minY, height) {
    const out = new Uint16Array(16 * 16 * height);
    const p = { x: 0, y: 0, z: 0 };
    let i = 0;
    for (let y = minY; y < minY + height; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        p.x = x; p.y = y; p.z = z;
        out[i++] = column.getBlockStateId(p) || 0;
    }
    return out;
}

/** Per bot: one file, the chunks already sent, the state ids already named. */
class BotRec {
    constructor(bot, dir, opts) {
        this.bot = bot; this.opts = opts; this.name = bot.username || `bot${Date.now()}`;
        this.file = path.join(dir, `${this.name}.jsonl`);
        this.fd = fs.openSync(this.file, 'a');
        this.buf = []; this.bytes = 0;
        this.chunks = new Set(); this.named = new Set(); this.tick = 0; this.seq = 0;
        this.ms0 = Date.now();
        this.blockCls = null;
        this.line({ t: 'hello', format: FORMAT, recorder: 'scripts/sim/record.js', bot: this.name, version: bot.version || null,
            minY: bot.game ? bot.game.minY : null, height: bot.game ? bot.game.height : null, dim: bot.game ? bot.game.dimension : null,
            difficulty: bot.game ? bot.game.difficulty || null : null, gameMode: bot.game ? bot.game.gameMode || null : null, temp: process.env.TEMP_BLOCK || null,
            // which bot implementation ran (TASK-076's native physics / inventory / dig, or mineflayer's): a corpus must not mix the two
            native: { physics: process.env.NATIVE_PHYSICS ?? null, inventory: process.env.NATIVE_INVENTORY ?? null, dig: process.env.NATIVE_DIG ?? null },
            world: process.env.T26_WORLD || process.env.TEST_WORLD || null, run: process.env.RUN || null, speed: Number(process.env.GAME_SPEED || 1), ms: this.ms0 });
        this._onTick = () => { this.tick++; };
        this._onBlock = (oldB, newB) => {
            const b = newB || oldB; if (!b || !b.position) return;
            const key = `${b.position.x >> 4},${b.position.z >> 4}`;
            if (!this.chunks.has(key)) return;                                    // only blocks of chunks the replayer has
            const s = newB ? newB.stateId : 0;
            this.name_(s);
            this.line({ t: 'blk', ms: Date.now(), tick: this.tick, p: [b.position.x, b.position.y, b.position.z], s });
        };
        this._onLoad = (pos) => {                                                    // a chunk sent again replaces the copy: take it again
            const key = `${pos.x >> 4},${pos.z >> 4}`;
            if (this.chunks.has(key)) { this.chunks.delete(key); this.snap(pos.x >> 4, pos.z >> 4); }
        };
        this._onSpawn = () => {                                                       // respawn or a new dimension: a new world for the replayer
            this.chunks.clear();
            this.line({ t: 'spawn', ms: Date.now(), tick: this.tick, dim: bot.game ? bot.game.dimension : null, minY: bot.game ? bot.game.minY : null, height: bot.game ? bot.game.height : null, state: botState(bot) });
        };
        this._onDeath = () => this.line({ t: 'death', ms: Date.now(), tick: this.tick });
        bot.on('physicsTick', this._onTick);
        bot.on('blockUpdate', this._onBlock);
        bot.on('spawn', this._onSpawn);
        bot.on('death', this._onDeath);
        if (bot.world && bot.world.on) bot.world.on('chunkColumnLoad', this._onLoad);
    }

    line(o) {
        const s = JSON.stringify(o) + '\n';
        this.buf.push(s); this.bytes += s.length;
        if (this.bytes > 1 << 16) this.flush();
    }
    flush() {
        if (!this.buf.length) return;
        try { fs.writeSync(this.fd, this.buf.join('')); } catch (_) { /* a full disk must not stop the test */ }
        this.buf = []; this.bytes = 0;
    }

    /** Name a state id once per file: block name and properties (from the bot's own registry, so per version). */
    name_(id) {
        if (this.named.has(id)) return;
        this.named.add(id);
        const reg = this.bot.registry, b = reg && reg.blocksByStateId && reg.blocksByStateId[id];
        let props = {};
        try {
            if (!this.blockCls) this.blockCls = require('prismarine-block')(reg);
            props = this.blockCls.fromStateId(id, 0).getProperties() || {};
        } catch (_) { /* properties are an extra; the name is what the replayer needs */ }
        this.line({ t: 'st', id, n: b ? b.name : null, p: props });
    }

    /** Snapshot chunk (cx, cz) if the client has it and it is not taken yet. */
    snap(cx, cz) {
        const key = `${cx},${cz}`;
        if (this.chunks.has(key)) return true;
        const w = this.bot.world, col = w && w.getColumn ? w.getColumn(cx, cz) : null;
        if (!col) return false;
        const minY = this.bot.game.minY, height = this.bot.game.height;
        const cells = columnCells(col, minY, height);
        const seen = new Set(cells);
        for (const id of seen) this.name_(id);
        this.chunks.add(key);
        this.line({ t: 'chunk', ms: Date.now(), tick: this.tick, cx, cz, minY, height, enc: 'u16le-deflate-b64',
            cells: zlib.deflateSync(Buffer.from(cells.buffer), { level: 1 }).toString('base64') });
        return true;
    }

    /** The chunks around the bot and around a target cell of the command (radius SIMREC_R chunks). */
    cover(args) {
        const r = this.opts.r, p = this.bot.entity && this.bot.entity.position;
        const centres = [];
        if (p) centres.push([Math.floor(p.x) >> 4, Math.floor(p.z) >> 4]);
        if (args && Number.isInteger(args.x) && Number.isInteger(args.z)) centres.push([args.x >> 4, args.z >> 4]);
        for (const [cx, cz] of centres) for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) this.snap(cx + dx, cz + dz);
    }

    begin(layer, name, args, opts) {
        const c0 = Date.now();
        this.cover(args);
        const recMs = Date.now() - c0;                                                  // the event-loop time the snapshots took (the recorder's own cost)
        const id = ++this.seq;
        // `ref`: the id of the command this one re-plays (scripts/sim/play.js sets bot.__simrecRef), so two runs pair up command by command
        const ref = this.bot.__simrecRef === undefined ? undefined : this.bot.__simrecRef;
        // the walk planner's per-bot settings (src/skills/options.js planNodes, src/skills/world.js maxDrop and noVines): the work layer lowers the search to
        // 6,000 nodes and makes vines air, and the replay must plan with the same
        let env = null;
        try { const so = require(path.join(this.opts.root, 'src/skills/options.js')).get(this.bot); env = { planNodes: so.planNodes, maxDrop: this.bot.__maxDrop || 0, noVines: !!this.bot.__noVines }; } catch (_) { /* options unknown */ }
        // floors the planner must not stand on (world.js avoidFloor: another bot's scaffolding; a function, so asked here for the solid cells around the bot)
        try {
            const af = this.bot.__avoidFloor, p = this.bot.entity.position;
            if (env && typeof af === 'function') {
                const avoid = [], w = this.bot.world, v = { x: 0, y: 0, z: 0 };
                for (let dx = -8; dx <= 8; dx++) for (let dz = -8; dz <= 8; dz++) for (let dy = -5; dy <= 4; dy++) {
                    const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy, z = Math.floor(p.z) + dz;
                    v.x = x; v.y = y; v.z = z;
                    if (w.getBlockStateId(v) && af(x, y, z)) avoid.push([x, y, z]);
                }
                if (avoid.length) env.avoid = avoid;
            }
        } catch (_) { /* nothing to avoid */ }
        this.line({ t: 'cmd', id, ref, layer, name, args: args || {}, atomic: !!(opts && opts.atomic), maxTicks: (opts && opts.maxTicks) || null, env, ...(recMs ? { recMs } : {}),
            ms: Date.now(), tick: this.tick, before: botState(this.bot) });
        return id;
    }

    end(id, res, err) {
        const o = { t: 'res', id, ms: Date.now(), tick: this.tick };
        if (err) Object.assign(o, { ok: false, reason: 'internal', detail: { error: String(err && err.message || err).slice(0, 300) } });
        else {
            let detail = res && res.detail; try { const s = JSON.stringify(detail); if (s && s.length > DETAIL_CAP) detail = { truncated: s.slice(0, DETAIL_CAP) }; } catch (_) { detail = null; }
            Object.assign(o, { ok: !!(res && res.ok), reason: res && res.ok ? 'ok' : (res && res.reason) || null, detail, ticks: res ? res.ticks : null, wallMs: res ? res.ms : null, phases: res ? res.phases : null });
            if (this.opts.trace && res && res.trace) o.trace = res.trace;
        }
        o.after = botState(this.bot);
        this.line(o);
        this.flush();
    }

    close() {
        this.flush();
        try { fs.closeSync(this.fd); } catch (_) { /* already closed */ }
    }
}

/** Install the recorder into the action layer of this process. Must run before src/skills is required by anyone else. */
function install({ dir = process.env.SIMREC_DIR || path.join('/out/simrec', process.env.RUN || `r${Date.now().toString(36)}`), r = Number(process.env.SIMREC_R || 2), trace = process.env.SIMREC_TRACE === '1', root = path.join(__dirname, '..', '..') } = {}) {
    const runnerPath = require.resolve(path.join(root, 'src/skills/runner.js')), indexPath = require.resolve(path.join(root, 'src/skills/index.js'));
    if (require.cache[indexPath]) throw new Error('scripts/sim/record.js: src/skills was loaded before the recorder (load it with node --require)');
    fs.mkdirSync(dir, { recursive: true });
    const opts = { r, trace, root }, recs = new Map(), busy = new WeakMap();
    const recOf = (bot) => {
        if (!bot || !bot.entity) return null;
        let rec = recs.get(bot);
        if (!rec) { try { rec = new BotRec(bot, dir, opts); recs.set(bot, rec); } catch (e) { console.error(`[simrec] ${e.message}`); return null; } }
        return rec;
    };
    const wrap = (layer, inner, nameOf) => async function recorded(bot, a, args, o) {
        // A command run inside a recorded one (execute -> runner.run) is part of it, not a second record.
        const depth = busy.get(bot) || 0, rec = depth ? null : recOf(bot);
        if (!rec) return inner.apply(this, arguments);
        let id = null;
        try { id = rec.begin(layer, nameOf(a), args, o); } catch (e) { console.error(`[simrec] begin: ${e.message}`); }
        busy.set(bot, depth + 1);
        try {
            const res = await inner.apply(this, arguments);
            if (id !== null) try { rec.end(id, res, null); } catch (e) { console.error(`[simrec] end: ${e.message}`); }
            return res;
        } catch (err) {
            if (id !== null) try { rec.end(id, null, err); } catch (_) { /* recorder must not change the outcome */ }
            throw err;
        } finally { busy.set(bot, depth); }
    };
    // A runner-level call is named after the work layer's move it belongs to (src/work/bot/moves.js MOVES: `move:bridge`, `move:pillar` ...), which
    // scripts/sim/play.js runs again with runMove; anything else as `run:<function name>`.
    const movesPath = path.join(root, 'src/work/bot/moves.js');
    const runName = (fn) => {
        const m = require.cache[movesPath] && require.cache[movesPath].exports.MOVES;
        if (m) for (const [k, v] of Object.entries(m)) if (v.fn === fn) return `move:${k}`;
        return `run:${(fn && fn.name) || 'anonymous'}`;
    };
    const runner = require(runnerPath);
    runner.run = wrap('run', runner.run, runName);
    const index = require(indexPath);
    index.execute = wrap('execute', index.execute, (name) => name);
    const closeAll = () => { for (const rec of recs.values()) rec.close(); };
    process.on('exit', closeAll);
    console.log(`[simrec] recording to ${dir} (format ${FORMAT}, radius ${r} chunks${trace ? ', per-tick traces' : ''})`);
    return { dir, recs, closeAll };
}

module.exports = { install, botState, columnCells, enchantsOf, BotRec, FORMAT };
// Loaded with --require (no parent module that is a test): install at once.
if (require.main !== module && module.parent && module.parent.id === 'internal/preload') install();
