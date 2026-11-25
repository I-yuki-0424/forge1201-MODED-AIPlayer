'use strict';
// The packet front end, prototype (TASK-20261125-078, docs/implemented/SIM-PARITY-v1.md section 6, backend B): the REAL bot code (mineflayer, the action layer,
// the work layer) runs against a server that lives in this process. Loaded with `node --require` before anything else, it
//   - hands every mineflayer bot a fake protocol client (`createBot({client})`): packets go in and out as objects, no socket, no codec;
//   - answers RCON (src/rl/rcon.js Rcon) with the handful of commands the harness and play.js use;
//   - keeps the world (the chunks of a recorded trace, TRACE=<dir>), the players' positions and packs, and applies the server rules a bot meets most:
//     movement accepted as the client sends it, digging (break progress >= 70 % of the vanilla time, as the server checks), placing (the item's
//     default block into a replaceable cell not inside a player), drops straight into the pack (the test worlds' auto-pickup), inventory slots.
//   - runs the clocks SIM_SPEED times faster (performance.now and the physics poll, as src/transport/time_scale.js does up to 10x).
// What it does not have (the list in the doc): block states from the look (stairs, logs and slabs are placed in their default state), block updates
// (falling blocks, fluids, plants losing their support), entities other than the players, light, mobs, hunger.
//   node --require ./scripts/sim/record.js --require ./scripts/sim/front.js scripts/sim/play.js  with TRACE=<run> CAPTURE=<capture.jsonl> SIM_SPEED=20
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { EventEmitter } = require('events');

const ROOT = path.join(__dirname, '..', '..');
const VERSION = process.env.MC_VERSION && /^\d+\.\d+/.test(process.env.MC_VERSION) ? process.env.MC_VERSION : '1.21.1';
const SPEED = Math.max(1, Math.min(50, Number(process.env.SIM_SPEED || 20)));
const registry = require('prismarine-registry')(VERSION);
const Chunk = require('prismarine-chunk')(registry);
const Block = require('prismarine-block')(registry);
const Item = require('prismarine-item')(registry);
const Vec3 = require('vec3');

const REPLACEABLE = /^(air|cave_air|void_air|grass|short_grass|tall_grass|fern|large_fern|dead_bush|snow|seagrass|tall_seagrass|bubble_column|vine|glow_lichen|water|lava)$/;
const FACES = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]];
const key = (cx, cz) => `${cx},${cz}`;
const stats = { packetsIn: 0, packetsOut: 0, digs: 0, places: 0, refused: 0, rcon: 0 };

// ---------------- the world ----------------
class World {
    constructor() { this.cols = new Map(); }
    /** The first snapshot of every chunk of every trace in `dir` (the world as the recording first saw it). */
    loadTrace(dir) {
        for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
            for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
                if (!line.startsWith('{"t":"chunk"')) continue;
                const j = JSON.parse(line);
                if (this.cols.has(key(j.cx, j.cz))) continue;
                const cells = new Uint16Array(zlib.inflateSync(Buffer.from(j.cells, 'base64')).buffer.slice(0));
                const col = new Chunk({ minY: j.minY, worldHeight: j.height });
                const p = new Vec3(0, 0, 0);
                for (let k = 0; k < cells.length; k++) { if (!cells[k]) continue; p.x = k % 16; p.z = (k >> 4) % 16; p.y = Math.floor(k / 256) + j.minY; col.setBlockStateId(p, cells[k]); }
                this.cols.set(key(j.cx, j.cz), col);
            }
        }
        return this.cols.size;
    }
    col(x, z) { return this.cols.get(key(Math.floor(x) >> 4, Math.floor(z) >> 4)); }
    get(x, y, z) { const c = this.col(x, z); return c ? c.getBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16)) : null; }
    set(x, y, z, s) { const c = this.col(x, z); if (!c) return false; c.setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), s); return true; }
}
const nameOf = (s) => (registry.blocksByStateId[s] ? registry.blocksByStateId[s].name : 'air');

// ---------------- the server ----------------
class Server {
    constructor() {
        this.world = new World();
        this.players = new Map();
        this.nextEntity = 100;
        this.capture = null;
    }
    /** The server's tick: the game clock (performance.now, running SIM_SPEED x), not the client's packets (an idle client sends none for a second). */
    get tick() { return Math.floor(require('perf_hooks').performance.now() / 50); }
    loadCapture(file) {
        // the configuration (registry data) and login packets of a real session of this version (scripts/sim/capture.js)
        const dec = (v) => { if (v && typeof v === 'object') { if (v.b64 !== undefined && Object.keys(v).length === 1) return Buffer.from(v.b64, 'base64'); if (v.big !== undefined && Object.keys(v).length === 1) return BigInt(v.big); if (Array.isArray(v)) return v.map(dec); const o = {}; for (const [k, x] of Object.entries(v)) o[k] = dec(x); return o; } return v; };
        const pk = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p.d === 'in');
        this.capture = { registry: pk.filter((p) => p.n === 'registry_data').map((p) => dec(p.p)), login: dec((pk.find((p) => p.n === 'login') || {}).p), chunk: dec((pk.find((p) => p.n === 'map_chunk') || {}).p) };
        if (!this.capture.login) throw new Error(`no login packet in ${file}`);
    }
    join(client) {
        const p = { client, name: client.username, eid: this.nextEntity++, pos: new Vec3(0.5, 100, 0.5), yaw: 0, pitch: 0, ground: false, inv: new Array(46).fill(null), held: 0, stateId: 1, dig: null, gm: 0, sent: new Set(), teleport: 1 };
        this.players.set(p.name, p);
        client.player = p;
        for (const r of this.capture.registry) client.send('registry_data', r, 'configuration');
        client.send('login', { ...this.capture.login, entityId: p.eid });
        client.send('window_items', { windowId: 0, stateId: p.stateId, items: p.inv.map((i) => Item.toNotch(i)), carriedItem: Item.toNotch(null) });
        // spawn where the recording's chunks are: the middle of the first recorded chunk, on its top block
        const first = this.world.cols.keys().next().value;
        if (first) { const [cx, cz] = first.split(',').map(Number); const x = cx * 16 + 8, z = cz * 16 + 8; let y = 319; while (y > -64 && !registry.blocksByStateId[this.world.get(x, y, z)]?.boundingBox?.startsWith('block')) y--; p.pos = new Vec3(x + 0.5, y + 1, z + 0.5); }
        this.sendChunks(p);
        this.teleport(p, p.pos.x, p.pos.y, p.pos.z, 0, 0);
        client.send('update_health', { health: 20, food: 20, foodSaturation: 5 });          // mineflayer's 'spawn' comes with the first health update
    }
    leave(client) { if (client.player) this.players.delete(client.player.name); }
    sendChunks(p) {
        const cx = Math.floor(p.pos.x) >> 4, cz = Math.floor(p.pos.z) >> 4;
        for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) {
            const k = key(cx + dx, cz + dz), col = this.world.cols.get(k);
            if (!col || p.sent.has(k)) continue;
            p.sent.add(k);
            const t = this.capture.chunk || {};
            p.client.send('map_chunk', { ...t, x: cx + dx, z: cz + dz, chunkData: col.dump(), blockEntities: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] });
        }
    }
    teleport(p, x, y, z, yaw, pitch) {
        p.pos = new Vec3(x, y, z);
        p.client.send('position', { x, y, z, yaw: yaw ?? p.yaw, pitch: pitch ?? p.pitch, flags: 0, teleportId: p.teleport++ });
        this.sendChunks(p);
    }
    blockChange(x, y, z, s) { for (const q of this.players.values()) if (q.sent.has(key(x >> 4, z >> 4))) q.client.send('block_change', { location: { x, y, z }, type: s }); }
    setSlot(p, slot) { p.stateId++; p.client.send('set_slot', { windowId: 0, stateId: p.stateId, slot, item: Item.toNotch(p.inv[slot]) }); }
    sendInventory(p) { p.stateId++; p.client.send('window_items', { windowId: 0, stateId: p.stateId, items: p.inv.map((i) => Item.toNotch(i)), carriedItem: Item.toNotch(null) }); }
    give(p, name, n) {
        const it = registry.itemsByName[name]; if (!it) return 0;
        let left = n;
        const order = [...Array(9).keys()].map((i) => 36 + i).concat([...Array(27).keys()].map((i) => 9 + i));
        for (const s of order) { const x = p.inv[s]; if (x && x.type === it.id && x.count < it.stackSize) { const a = Math.min(left, it.stackSize - x.count); x.count += a; left -= a; this.setSlot(p, s); if (!left) return n; } }
        for (const s of order) { if (!p.inv[s]) { const a = Math.min(left, it.stackSize); p.inv[s] = new Item(it.id, a); left -= a; this.setSlot(p, s); if (!left) return n; } }
        return n - left;
    }
    /** Vanilla break ticks for the player's held item (the same formula the client uses; Efficiency from the item's components). */
    breakTicks(p, s) {
        const b = Block.fromStateId(s, 0), held = p.inv[36 + p.held];
        const ench = held && held.enchants ? require(path.join(ROOT, 'src/transport/fabric_bot.js')).normEnchants(held.enchants, registry) : [];
        const ms = b.digTime(held ? held.type : null, p.gm === 1, false, !p.ground, ench, {});
        return Math.ceil(ms / 50);
    }
    breakBlock(p, x, y, z) {
        const s = this.world.get(x, y, z); if (s === null) return;
        const b = Block.fromStateId(s, 0), held = p.inv[36 + p.held];
        this.world.set(x, y, z, 0); this.blockChange(x, y, z, 0); stats.digs++;
        // the drop straight into the pack (auto-pickup on the test worlds) when the held item can harvest it
        const can = !b.harvestTools || (held && b.harvestTools[held.type]);
        if (can) for (const d of (registry.blocks[b.type].drops || [])) { const id = typeof d === 'object' ? d.drop : d; const it = registry.items[typeof id === 'object' ? id.id : id]; if (it) this.give(p, it.name, 1); break; }
    }
    onPacket(client, name, a) {
        stats.packetsIn++;
        const p = client.player; if (!p) return;
        switch (name) {
            case 'position': case 'position_look': case 'look': case 'flying':
                if (a.x !== undefined) { p.pos = new Vec3(a.x, a.y, a.z); this.sendChunks(p); }
                if (a.yaw !== undefined) { p.yaw = a.yaw; p.pitch = a.pitch; }
                if (a.onGround !== undefined) p.ground = !!a.onGround; else if (a.flags !== undefined) p.ground = !!(a.flags & 1 || a.flags.onGround);
                break;
            case 'held_item_slot': p.held = a.slotId; break;
            case 'block_dig': {
                const { x, y, z } = a.location;
                if (a.status === 0) {
                    const s = this.world.get(x, y, z);
                    p.dig = { x, y, z, t: this.tick, need: s === null ? Infinity : this.breakTicks(p, s) };
                    if (p.dig.need <= 0) { this.breakBlock(p, x, y, z); p.dig = null; }
                } else if (a.status === 2) {
                    const d = p.dig;
                    // the server accepts a finish at 70 % of the break time or more (ServerPlayerGameMode), else the block stays and is sent again
                    if (d && d.x === x && d.y === y && d.z === z && (this.tick - d.t + 1) >= 0.7 * d.need) this.breakBlock(p, x, y, z);
                    else { stats.refused++; const s = this.world.get(x, y, z); if (s !== null) this.blockChange(x, y, z, s); }
                    p.dig = null;
                } else if (a.status === 1) p.dig = null;
                if (a.sequence !== undefined) client.send('acknowledge_player_digging', { sequenceId: a.sequence });
                break;
            }
            case 'block_place': {
                const { x, y, z } = a.location, held = p.inv[36 + (a.hand ? 45 - 36 : p.held)];
                const clicked = this.world.get(x, y, z);
                let t = { x, y, z };
                if (clicked === null || !REPLACEABLE.test(nameOf(clicked))) { const f = FACES[a.direction]; t = { x: x + f[0], y: y + f[1], z: z + f[2] }; }
                const cur = this.world.get(t.x, t.y, t.z), blk = held && registry.blocksByName[held.name];
                const inside = [...this.players.values()].some((q) => Math.abs(q.pos.x - (t.x + 0.5)) < 0.8 && Math.abs(q.pos.z - (t.z + 0.5)) < 0.8 && q.pos.y < t.y + 1 && q.pos.y + 1.8 > t.y);
                if (blk && cur !== null && REPLACEABLE.test(nameOf(cur)) && !inside) {
                    this.world.set(t.x, t.y, t.z, blk.defaultState); this.blockChange(t.x, t.y, t.z, blk.defaultState); stats.places++;
                    held.count--; const slot = 36 + p.held; if (held.count <= 0) p.inv[slot] = null; this.setSlot(p, slot);
                } else { stats.refused++; if (cur !== null) this.blockChange(t.x, t.y, t.z, cur); }
                if (a.sequence !== undefined) client.send('acknowledge_player_digging', { sequenceId: a.sequence });
                break;
            }
            case 'window_click':
                // the client's own prediction of the changed slots is taken as the result (prototype: no validation of the click)
                if (a.windowId === 0) { for (const c of a.changedSlots || []) { p.inv[c.location] = Item.fromNotch(c.item); } }
                break;
            default: break;                                                                 // teleport_confirm, settings, keep_alive, arm_animation, entity_action, ...
        }
    }
    /** The commands the harness and play.js send over RCON. */
    rcon(cmd) {
        stats.rcon++;
        const w = cmd.trim().split(/\s+/), p = this.players.get(w[1]);
        switch (w[0]) {
            case 'seed': return `Seed: [${process.env.SIM_SEED || 0}]`;
            case 'gamerule': case 'difficulty': case 'forceload': case 'tellraw': case 'effect': case 'time': case 'weather': case 'scoreboard': case 'kill': case 'say': return '';
            case 'gamemode': { const q = this.players.get(w[2]); if (q) { q.gm = { survival: 0, creative: 1, adventure: 2, spectator: 3 }[w[1]] ?? 0; q.client.send('game_state_change', { reason: 'change_game_mode', gameMode: q.gm }); q.client.send('abilities', { flags: q.gm === 3 ? 6 : q.gm === 1 ? 13 : 0, flyingSpeed: 0.05, walkingSpeed: 0.1 }); } return ''; }
            case 'tp': if (p) this.teleport(p, Number(w[2]), Number(w[3]), Number(w[4]), w[5] !== undefined ? Number(w[5]) : undefined, w[6] !== undefined ? Number(w[6]) : undefined); return p ? `Teleported ${w[1]}` : 'No entity was found';
            case 'clear': if (p) { p.inv.fill(null); this.sendInventory(p); } return '';
            case 'setblock': {
                const [x, y, z] = [Number(w[1]), Number(w[2]), Number(w[3])];
                const m = /^(?:minecraft:)?([a-z0-9_]+)(?:\[(.*)\])?$/.exec(w[4] || '');
                if (!m) return 'bad block';
                const props = {}; for (const kv of (m[2] || '').split(',').filter(Boolean)) { const [k, v] = kv.split('='); props[k] = v === 'true' ? true : v === 'false' ? false : (/^\d+$/.test(v) ? Number(v) : v); }
                let s; try { s = Block.fromProperties(m[1], props, 0).stateId; } catch (_) { s = registry.blocksByName[m[1]] ? registry.blocksByName[m[1]].defaultState : null; }
                if (s === null || s === undefined || !this.world.set(x, y, z, s)) return 'not loaded';
                this.blockChange(x, y, z, s); return 'Changed the block';
            }
            case 'item': {
                // item replace entity <name> <slot> with <item>[components] <count>
                const q = this.players.get(w[3]); if (!q) return 'No entity';
                const slotName = w[4], m = /^(?:minecraft:)?([a-z0-9_]+)(\[.*\])?$/.exec(w[6] || ''), count = Number(w[7] || 1);
                const map = (sn) => { const [k, i] = sn.split('.'); return k === 'hotbar' ? 36 + Number(i) : k === 'inventory' ? 9 + Number(i) : { 'armor.head': 5, 'armor.chest': 6, 'armor.legs': 7, 'armor.feet': 8, 'weapon.offhand': 45 }[sn]; };
                const slot = map(slotName), it = m && registry.itemsByName[m[1]];
                if (slot === undefined || !it) return 'bad item';
                q.inv[slot] = new Item(it.id, count); this.setSlot(q, slot);
                return 'Replaced a slot';
            }
            case 'data': {
                const q = this.players.get(w[3]);
                if (q && w[4] === 'Pos') return `${w[3]} has the following entity data: [${q.pos.x}d, ${q.pos.y}d, ${q.pos.z}d]`;
                return '';
            }
            default: return '';
        }
    }
}

// ---------------- the fake client ----------------
class FakeClient extends EventEmitter {
    constructor(server, username) {
        super();
        this.server = server; this.username = username; this.version = VERSION; this.state = 'play'; this.wait_connect = false; this.ended = false;
        this.uuid = '00000000-0000-3000-8000-' + Buffer.from(username).toString('hex').padEnd(12, '0').slice(0, 12);
        this.socket = { setNoDelay() {}, setTimeout() {}, on() {}, once() {}, removeListener() {}, write() {}, end() {}, destroy() {} };
        setTimeout(() => { this.emit('connect'); server.join(this); }, 10);
    }
    write(name, params) { if (!this.ended) this.server.onPacket(this, name, params); }
    writeRaw() {}
    registerChannel() {} unregisterChannel() {} writeChannel() {}
    chat() {}
    end(reason) { if (this.ended) return; this.ended = true; this.server.leave(this); setImmediate(() => this.emit('end', reason || 'quit')); }
    send(name, params, state = 'play') {
        stats.packetsOut++;
        const meta = { name, state };
        setImmediate(() => { if (this.ended) return; this.emit(name, params, meta); this.emit('packet', params, meta, Buffer.alloc(0), Buffer.alloc(0)); });
    }
}

// ---------------- installation ----------------
function install() {
    const server = new Server();
    if (process.env.TRACE) console.log(`[front] ${server.world.loadTrace(process.env.TRACE)} chunks from ${process.env.TRACE}`);
    server.loadCapture(process.env.CAPTURE || `/out/simrec/capture-${VERSION}.jsonl`);
    // One game clock for every bot, stepped, not scaled: every 50 / SPEED ms of wall time it advances exactly one tick (performance.now + 50 ms) and runs each
    // bot's physics poll once. Scaling the wall clock instead (time_scale.js) let mineflayer's accumulator catch up several physics steps in one poll when the
    // event loop lagged, and the action layer's runner, which counts 'physicsTick' events between its awaits, saw one tick for several steps: walks
    // measured about 5 ticks short on move_b (mvb-r1 traces: one jump arc of four steps inside one counted tick). A late poll now slows the game instead.
    const { performance } = require('perf_hooks');
    let virtual = performance.now();
    performance.now = () => virtual;
    const si = global.setInterval, ci = global.clearInterval;
    const polls = new Map(); let nextPoll = 1;
    si.call(global, () => { virtual += 50; for (const fn of [...polls.values()]) { try { fn(); } catch (e) { console.error('[front] physics poll', e && e.message); } } }, Math.max(1, 50 / SPEED));
    global.setInterval = function stepped(fn, ms, ...rest) {
        if (fn && fn.name === 'doPhysics') { const h = { front: nextPoll++ }; polls.set(h.front, fn); return h; }
        return si.call(this, fn, ms, ...rest);
    };
    global.clearInterval = function (h) { if (h && h.front) { polls.delete(h.front); return; } return ci.call(this, h); };
    const ts = require(path.join(ROOT, 'src/transport/time_scale.js'));
    ts.setTimeScale = () => SPEED;                                                     // the transport's own scaling is this one
    // every bot gets a fake client
    const mineflayer = require('mineflayer');
    const create = mineflayer.createBot;
    mineflayer.createBot = (o = {}) => create({ ...o, version: VERSION, client: new FakeClient(server, o.username || 'Player') });
    // RCON answered here
    const rconMod = require(path.join(ROOT, 'src/rl/rcon.js'));
    rconMod.Rcon = class FakeRcon { constructor() {} async connect() { return this; } async command(c) { return server.rcon(c); } end() {} close() {} };
    process.on('exit', () => console.log(`[front] ${JSON.stringify(stats)}`));
    console.log(`[front] in-process server for ${VERSION}, clocks x${SPEED}`);
    return server;
}

module.exports = { install, Server, World, FakeClient, stats };
if (module.parent && module.parent.id === 'internal/preload') module.exports.server = install();
