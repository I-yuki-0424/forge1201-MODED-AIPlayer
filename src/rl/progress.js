'use strict';
// Progress events for reward v2, all graded by the server (docs/proposed/RL-TRAINING-v2.md):
//   killed / mined   deltas of the player's statistics (the client asks with client_command 1, as the Statistics screen does)
//   stat             the same for crafted / used / picked_up (item statistics; reward v5's progress list, env v3.0)
//   advancement      an advancement whose requirements the server reports complete (advancements packet)
//   dawn             the day counter advanced after a night seen (deaths in it are the reward's business, v5); slept = in bed
//   death            the bot died (once per life: revive() re-arms it after the respawn)
// Ids in the statistics packet are registry ids: they are named with the handshake's registry sync where Forge sent it,
// else with vanilla minecraft-data (the order vanilla registers them).
const STAT_TYPES = ['minecraft:mined', 'minecraft:crafted', 'minecraft:used', 'minecraft:broken', 'minecraft:picked_up',
    'minecraft:dropped', 'minecraft:killed', 'minecraft:killed_by', 'minecraft:custom'];
const ITEM_STATS = new Set(['minecraft:crafted', 'minecraft:used', 'minecraft:picked_up']);
const NIGHT_START = 12542, NIGHT_END = 23460;   // ticks of the day in which a bed can be used

// src/transport/forge_bot.js leaves the advancements packet unparsed (restBuffer: it desynced on modded servers in 2026-03).
// Here it is parsed from the raw bytes with the unmodified 1.20 schema, guarded: a packet that does not parse is counted
// (tracker.advErrors) and skipped, never fatal. Verified on the Create server 2026-11-01 (grant, progress and revoke).
let advParser = null;
function parseAdvancements(buf) {
    if (!advParser) {
        const fs = require('fs'), path = require('path');
        const { ProtoDefCompiler } = require('protodef').Compiler;
        const file = path.join(path.dirname(require.resolve('minecraft-data')), 'minecraft-data/data/pc/1.20/protocol.json');
        const c = new ProtoDefCompiler();
        c.addTypes(require('minecraft-protocol/src/datatypes/compiler-minecraft'));
        c.addProtocol(JSON.parse(fs.readFileSync(file, 'utf8')), ['play', 'toClient']);
        require('prismarine-nbt').addTypesToCompiler('big', c);
        advParser = c.compileProtoDefSync();
    }
    const r = advParser.read(buf, 0, 'packet_advancements', {});
    if (r.size !== buf.length) throw new Error(`advancements: parsed ${r.size} of ${buf.length} bytes`);
    return r.value;
}

function inverse(sync, name) {
    const m = sync && sync.get(name);
    return m ? new Map([...m].map(([k, v]) => [v, k])) : null;
}

/** Requirement groups satisfied: every group has at least one criterion with a date. */
function complete(requirements, criteria) {
    return requirements.length > 0 && requirements.every((g) => g.some((c) => criteria.has(c)));
}

class ProgressTracker {
    constructor(bot, { advTable = require('../../modpack/forgeaip-create.advancements.json').advancements, statsTimeoutMs = 1500 } = {}) {
        this.bot = bot; this.advTable = advTable; this.statsTimeoutMs = statsTimeoutMs;
        const sync = bot.forgeRegistrySync;
        this.names = {
            type: inverse(sync, 'minecraft:stat_type'),
            block: inverse(sync, 'minecraft:block'),
            entity: inverse(sync, 'minecraft:entity_type'),
            item: inverse(sync, 'minecraft:item'),
        };
        this.requirements = new Map(); this.criteria = new Map(); this.granted = new Set();
        this.pending = []; this.statsWaiters = []; this.baseline = null; this.last = new Map();
        this.sleepStart = null; this.lastWake = null; this.sawNight = false; this.day = null; this.dead = false;
        const c = bot._client;
        this.advErrors = 0;
        c.on('advancements', (p) => {
            const raw = Buffer.isBuffer(p) ? p : p && Buffer.isBuffer(p.restBuffer) ? p.restBuffer : null;
            try { this._onAdvancements(raw ? parseAdvancements(raw) : p); } catch { this.advErrors++; }
        });
        c.on('statistics', (p) => { const w = this.statsWaiters; this.statsWaiters = []; for (const f of w) f(p.entries); });
        bot.on('time', () => this._onTime());
        bot.on('sleep', () => { this.sleepStart = Date.now(); });
        bot.on('wake', () => { if (this.sleepStart) this.lastWake = { t: Date.now(), ms: Date.now() - this.sleepStart }; this.sleepStart = null; });
        bot.on('death', () => { if (!this.dead) { this.dead = true; this.pending.push({ type: 'death' }); } });
    }

    statName(type, id) {
        const t = (this.names.type && this.names.type.get(type)) || STAT_TYPES[type];
        const reg = this.bot.registry;
        if (t === 'minecraft:mined') return [t, (this.names.block && this.names.block.get(id)) || (reg.blocks[id] && `minecraft:${reg.blocks[id].name}`)];
        if (t === 'minecraft:killed') return [t, (this.names.entity && this.names.entity.get(id)) || (reg.entities[id] && `minecraft:${reg.entities[id].name}`)];
        if (ITEM_STATS.has(t)) return [t, (this.names.item && this.names.item.get(id)) || (reg.items[id] && `minecraft:${reg.items[id].name}`)];
        return [t, null];
    }

    /** Ask the server for the statistics; resolves to Map('<type> <name>' -> value) of mined, killed, crafted, used and
     *  picked_up, or null on timeout. */
    async stats() {
        const entries = await new Promise((resolve) => {
            const timer = setTimeout(() => { this.statsWaiters = this.statsWaiters.filter((f) => f !== done); resolve(null); }, this.statsTimeoutMs);
            const done = (e) => { clearTimeout(timer); resolve(e); };
            this.statsWaiters.push(done);
            this.bot._client.write('client_command', { actionId: 1 });
        });
        if (!entries) return null;
        const out = new Map();
        for (const e of entries) {
            const [t, name] = this.statName(e.categoryId, e.statisticId);
            if (name && (t === 'minecraft:mined' || t === 'minecraft:killed' || ITEM_STATS.has(t))) out.set(`${t} ${name}`, e.value);
        }
        return out;
    }

    /** Start of an episode (after the harness revoked advancements): the current statistics become the baseline. */
    async begin() {
        this.pending = []; this.granted.clear(); this.dead = false; this.sawNight = false;
        this.day = this.bot.time ? this.bot.time.day : null; this.lastWake = null;
        // A lagging server can miss the first request (run train4: 'no reply' ended the run); ask up to 3 times.
        let s = null;
        for (let i = 0; i < 3 && !s; i++) s = await this.stats();
        if (!s) throw new Error('statistics: no reply from the server (3 requests)');
        this.last = s;
    }

    /** Events since the last call (statistics are re-read now). */
    async collect() {
        const s = await this.stats();
        if (s) {
            for (const [k, v] of s) {
                const d = v - (this.last.get(k) || 0);
                if (d <= 0) continue;
                const [t, name] = k.split(' ');
                this.pending.push(t === 'minecraft:mined' ? { type: 'mined', block: name, n: d } : t === 'minecraft:killed' ? { type: 'killed', entity: name, n: d }
                    : { type: 'stat', stat: t, name, n: d });
            }
            this.last = s;
        }
        const out = this.pending; this.pending = [];
        return { events: out, statsOk: !!s };
    }

    _onAdvancements(p) {
        if (p.reset) { this.requirements.clear(); this.criteria.clear(); }
        for (const a of p.advancementMapping || []) this.requirements.set(a.key, a.value.requirements);
        for (const id of p.identifiers || []) { this.requirements.delete(id); this.criteria.delete(id); }
        for (const pr of p.progressMapping || []) {
            const set = new Set(pr.value.filter((c) => c.criterionProgress !== undefined && c.criterionProgress !== null).map((c) => c.criterionIdentifier));
            this.criteria.set(pr.key, set);
            const req = this.requirements.get(pr.key) || (this.advTable[pr.key] && this.advTable[pr.key].requirements) || [];
            if (complete(req, set)) {
                if (!this.granted.has(pr.key) && this.advTable[pr.key]) { this.granted.add(pr.key); this.pending.push({ type: 'advancement', id: pr.key }); }
            } else this.granted.delete(pr.key);   // revoked (episode reset)
        }
    }

    /** After the respawn (an episode goes on past a death, env v3.0): the next death is reported again. */
    revive() { this.dead = false; }

    _onTime() {
        const t = this.bot.time;
        if (!t) return;
        if (t.timeOfDay >= NIGHT_START && t.timeOfDay < NIGHT_END) this.sawNight = true;
        if (this.day !== null && t.day > this.day && this.sawNight) {
            const w = this.lastWake, inBed = this.bot.isSleeping;
            const slept = (inBed && this.sleepStart && Date.now() - this.sleepStart >= 4500) || (!!w && Date.now() - w.t < 5000 && w.ms >= 4500);
            this.pending.push({ type: 'dawn', slept: !!slept });
            this.sawNight = false;
        }
        this.day = t.day;
    }
}

module.exports = { ProgressTracker, complete, parseAdvancements, STAT_TYPES, NIGHT_START, NIGHT_END };
