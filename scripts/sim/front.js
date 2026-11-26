'use strict';
// The packet front end, prototype (TASK-20261125-078, docs/implemented/SIM-PARITY-v1.md section 6, backend B): the REAL bot code (mineflayer, the action layer,
// the work layer) runs against a server that lives in this process. Loaded with `node --require` before anything else, it
//   - hands every mineflayer bot a fake protocol client (`createBot({client})`): packets go in and out as objects, no socket, no codec;
//   - answers RCON (src/rl/rcon.js Rcon) with the handful of commands the harness and play.js use;
//   - keeps the players (positions, packs, the click on a slot) and hands the world to `forgeaip-sim serve` (Rust, tools/sim/src/serve.rs): the world
//     of a server's region files (REGIONS=<dir>, SIM_SPAWN=x,y,z the world spawn) or of a recorded run (TRACE=<dir>), digging at >= 70 % of the
//     break time with the tool's drop (straight into the pack: the test worlds' auto-pickup), placement states from the click and the look,
//     supports, water, falling blocks, and the harness's world commands (setblock, fill, clone, execute if/unless block(s)).
//   - runs the clocks SIM_SPEED times faster (performance.now and the physics poll, as src/transport/time_scale.js does up to 10x).
// What it does not have (the list in the doc): entities other than the players (item drops, mobs), fluids over time, light, hunger, containers,
// two-block placements (doors, beds: the lower half only), redstone.
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

const nameOf = (s) => (registry.blocksByStateId[s] ? registry.blocksByStateId[s].name : 'air');

// ---------------- the world side: forgeaip-sim serve (Rust) ----------------
/** The Rust world process: one JSON request per line, answers in order. */
class Serve {
    constructor(args) {
        const bin = process.env.SIM_BIN || path.join(ROOT, 'tools/sim/target/bookworm/release/forgeaip-sim');
        this.proc = require('child_process').spawn(bin, ['serve', ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
        this.wait = new Map(); this.next = 1;
        this.ready = new Promise((ok) => { this.onReady = ok; });
        require('readline').createInterface({ input: this.proc.stdout }).on('line', (l) => {
            const j = JSON.parse(l);
            if (j.ready) { this.info = j; return this.onReady(j); }
            const w = this.wait.get(j.id); if (w) { this.wait.delete(j.id); w(j); }
        });
        this.proc.on('exit', (c) => { if (c) console.error(`[front] serve exited ${c}`); });
    }
    ask(q) { const id = this.next++; return new Promise((ok) => { this.wait.set(id, ok); this.proc.stdin.write(JSON.stringify({ ...q, id }) + '\n'); }); }
    close() { try { this.proc.stdin.end(); } catch (_) { /* gone */ } }
}

/** The item of a name with the components a `give` / `item replace` names (enchantments, unbreakable, damage): what the client reads back. */
function itemFrom(spec, count) {
    const m = /^(?:minecraft:)?([a-z0-9_]+)(\[(.*)\])?$/.exec(String(spec || ''));
    if (!m || !registry.itemsByName[m[1]]) return null;
    const it = new Item(registry.itemsByName[m[1]].id, count);
    const comps = m[3] || '';
    const ench = [];
    const lv = /enchantments=\{(?:levels:\{)?([^}]*)\}/.exec(comps);
    if (lv) for (const pair of lv[1].split(',')) { const [k, v] = pair.split(':').map((x) => x.replace(/"/g, '').replace(/^minecraft:/, '').trim()); const e = registry.enchantmentsByName && registry.enchantmentsByName[k]; if (e && v) ench.push({ id: e.id, level: Number(v) }); }
    it.__comps = [];
    if (ench.length) it.__comps.push({ type: 'enchantments', data: { enchantments: ench, showTooltip: true } });
    if (/unbreakable=/.test(comps)) it.__comps.push({ type: 'unbreakable', data: true });
    it.__ench = ench;
    return it;
}
const notch = (it) => {
    if (!it) return Item.toNotch(null);
    const n = Item.toNotch(it);
    if (it.__comps && it.__comps.length) { n.components = it.__comps; n.addedComponentCount = it.__comps.length; n.removeComponents = n.removeComponents || []; n.removedComponentCount = n.removeComponents.length; }
    return n;
};
const effOf = (it) => { if (!it) return 0; const e = (it.__ench || []).find((x) => (registry.enchantments[x.id] || {}).name === 'efficiency'); return e ? e.level : 0; };

class Server {
    constructor() {
        this.players = new Map(); this.nextEntity = 100; this.capture = null; this.cols = new Map(); this.loading = new Map();
        this.spawn = process.env.SIM_SPAWN ? process.env.SIM_SPAWN.split(',').map(Number) : null;
    }
    /** The server's tick: the stepped game clock (performance.now advances 50 ms per tick). */
    get tick() { return Math.floor(require('perf_hooks').performance.now() / 50); }
    start() {
        const args = process.env.REGIONS ? ['--regions', process.env.REGIONS, '--cx', String(Math.floor((this.spawn ? this.spawn[0] : 0)) >> 4), '--cz', String(Math.floor((this.spawn ? this.spawn[2] : 0)) >> 4), '--r', process.env.SIM_R || '16']
            : ['--trace', process.env.TRACE];
        if (process.env.SIM_DATA) args.push('--data', process.env.SIM_DATA);
        this.serve = new Serve(args);
        return this.serve.ready.then((j) => console.log(`[front] serve ready: ${j.chunks} chunks`));
    }
    loadCapture(file) {
        // the configuration (registry data) and login packets of a real session of this version (scripts/sim/capture.js)
        const dec = (v) => { if (v && typeof v === 'object') { if (v.b64 !== undefined && Object.keys(v).length === 1) return Buffer.from(v.b64, 'base64'); if (v.big !== undefined && Object.keys(v).length === 1) return BigInt(v.big); if (Array.isArray(v)) return v.map(dec); const o = {}; for (const [k, x] of Object.entries(v)) o[k] = dec(x); return o; } return v; };
        const pk = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p.d === 'in');
        this.capture = { registry: pk.filter((p) => p.n === 'registry_data').map((p) => dec(p.p)), login: dec((pk.find((p) => p.n === 'login') || {}).p), chunk: dec((pk.find((p) => p.n === 'map_chunk') || {}).p) };
        if (!this.capture.login) throw new Error(`no login packet in ${file}`);
    }
    // ---- the world, mirrored from serve per chunk ----
    async col(cx, cz) {
        const k = key(cx, cz);
        if (this.cols.has(k)) return this.cols.get(k);
        if (!this.loading.has(k)) this.loading.set(k, this.serve.ask({ op: 'chunk', cx, cz }).then((j) => {
            let c = null;
            if (j.cells) {
                const raw = Buffer.from(j.cells, 'base64'), cells = new Uint16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));  // a pooled Buffer can start at an odd offset
                c = new Chunk({ minY: j.minY, worldHeight: j.height });
                const p = new Vec3(0, 0, 0);
                for (let i = 0; i < cells.length; i++) { if (!cells[i]) continue; p.x = i % 16; p.z = (i >> 4) % 16; p.y = Math.floor(i / 256) + j.minY; c.setBlockStateId(p, cells[i]); }
            }
            this.cols.set(k, c); return c;
        }));
        return this.loading.get(k);
    }
    get(x, y, z) { const c = this.cols.get(key(x >> 4, z >> 4)); return c ? c.getBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16)) : null; }
    apply(changes) {
        for (const [x, y, z, s] of changes || []) {
            const c = this.cols.get(key(x >> 4, z >> 4)); if (c) c.setBlockStateId(new Vec3(((x % 16) + 16) % 16, y, ((z % 16) + 16) % 16), s);
            this.blockChange(x, y, z, s);
        }
    }
    async join(client) {
        await this.serve.ready;
        const p = { client, name: client.username, eid: this.nextEntity++, pos: new Vec3(0.5, 100, 0.5), yaw: 0, pitch: 0, ground: false, inv: new Array(46).fill(null), held: 0, stateId: 1, dig: null, gm: 0, sent: new Set(), teleport: 1 };
        this.players.set(p.name, p);
        client.player = p;
        for (const r of this.capture.registry) client.send('registry_data', r, 'configuration');
        client.send('login', { ...this.capture.login, entityId: p.eid });
        client.send('window_items', { windowId: 0, stateId: p.stateId, items: p.inv.map(notch), carriedItem: notch(null) });
        // the world spawn (SIM_SPAWN, the real server's for the same seed), else the middle of the world's first chunk on its top block
        let [x, y, z] = this.spawn || [8, null, 8];
        await this.col(Math.floor(x) >> 4, Math.floor(z) >> 4);
        if (y === null || y === undefined) { y = 319; while (y > -64 && !registry.blocksByStateId[this.get(Math.floor(x), y, Math.floor(z))]?.boundingBox?.startsWith('block')) y--; y += 1; }
        client.send('spawn_position', { location: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, angle: 0 });
        await this.sendChunks(p, x, z);
        this.teleport(p, Math.floor(x) + 0.5, y, Math.floor(z) + 0.5, 0, 0);
        client.send('update_health', { health: 20, food: 20, foodSaturation: 5 });          // mineflayer's 'spawn' comes with the first health update
    }
    leave(client) { if (client.player) this.players.delete(client.player.name); }
    async sendChunks(p, x = p.pos.x, z = p.pos.z) {
        const cx = Math.floor(x) >> 4, cz = Math.floor(z) >> 4, R = Number(process.env.SIM_VIEW || 4);
        for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
            const k = key(cx + dx, cz + dz);
            if (p.sent.has(k)) continue;
            p.sent.add(k);
            const col = await this.col(cx + dx, cz + dz);
            if (!col) continue;
            const t = this.capture.chunk || {};
            p.client.send('map_chunk', { ...t, x: cx + dx, z: cz + dz, chunkData: col.dump(), blockEntities: [], skyLightMask: [], blockLightMask: [], emptySkyLightMask: [], emptyBlockLightMask: [], skyLight: [], blockLight: [] });
        }
    }
    teleport(p, x, y, z, yaw, pitch) {
        p.pos = new Vec3(x, y, z);
        this.sendChunks(p).then(() => p.client.send('position', { x, y, z, yaw: yaw ?? p.yaw, pitch: pitch ?? p.pitch, flags: 0, teleportId: p.teleport++ }));
    }
    blockChange(x, y, z, s) { for (const q of this.players.values()) if (q.sent.has(key(x >> 4, z >> 4))) q.client.send('block_change', { location: { x, y, z }, type: s }); }
    setSlot(p, slot) { p.stateId++; p.client.send('set_slot', { windowId: 0, stateId: p.stateId, slot, item: notch(p.inv[slot]) }); }
    sendInventory(p) { p.stateId++; p.client.send('window_items', { windowId: 0, stateId: p.stateId, items: p.inv.map(notch), carriedItem: notch(null) }); }
    give(p, spec, n) {
        const proto = itemFrom(spec, 1); if (!proto) return 0;
        const info = registry.items[proto.type];
        let left = n;
        const order = [...Array(9).keys()].map((i) => 36 + i).concat([...Array(27).keys()].map((i) => 9 + i));
        const plain = !(proto.__comps && proto.__comps.length);
        if (plain) for (const s of order) { const x = p.inv[s]; if (x && x.type === proto.type && !(x.__comps && x.__comps.length) && x.count < info.stackSize) { const a = Math.min(left, info.stackSize - x.count); x.count += a; left -= a; this.setSlot(p, s); if (!left) return n; } }
        for (const s of order) { if (!p.inv[s]) { const a = Math.min(left, info.stackSize); const it = itemFrom(spec, a); p.inv[s] = it; left -= a; this.setSlot(p, s); if (!left) return n; } }
        return n - left;
    }
    /** The eye in water (no Aqua Affinity here): a fifth of the dig speed, as on the ground's absence. */
    eyeInWater(p) { const s = this.get(Math.floor(p.pos.x), Math.floor(p.pos.y + 1.62), Math.floor(p.pos.z)); return s !== null && nameOf(s) === 'water'; }
    async dig(p, x, y, z, elapsed) {
        const held = p.inv[36 + p.held];
        const j = await this.serve.ask({ op: 'dig', x, y, z, tool: held ? held.name : '', eff: effOf(held), ground: p.ground, water: this.eyeInWater(p), elapsed });
        if (!j.ok) return j;
        stats.digs++;
        this.apply(j.changes);
        for (const [n, c] of j.drops || []) this.give(p, n, c);                      // drops straight into the pack (the test worlds' auto-pickup)
        return j;
    }
    /** Delayed destroys (ServerPlayerGameMode.hasDelayedDestroy): a dig stopped before 70 % goes on on the server and breaks the block at 100 %. */
    delayed() {
        const now = this.tick;
        for (const p of this.players.values()) {
            const d = p.delayed; if (!d || now < d.at) continue;
            p.delayed = null;
            if (this.get(d.x, d.y, d.z) !== d.s) continue;                              // the block changed meanwhile: nothing to finish
            this.dig(p, d.x, d.y, d.z, d.need);
        }
    }
    async onPacket(client, name, a) {
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
                    p.dig = { x, y, z, t: this.tick };
                    // an instant break: the server breaks at the start (the 70 % rule with a need of 0)
                    const j = await this.dig(p, x, y, z, -1);
                    if (j.ok) p.dig = null;
                } else if (a.status === 2) {
                    const d = p.dig;
                    const j = d && d.x === x && d.y === y && d.z === z ? await this.dig(p, x, y, z, this.tick - d.t) : { ok: false };
                    if (!j.ok) {
                        stats.refused++; const s = this.get(x, y, z); if (s !== null) this.blockChange(x, y, z, s);
                        if (j.need && !p.delayed) p.delayed = { x, y, z, s, need: j.need, at: d.t + j.need - 1 };
                    }
                    p.dig = null;
                } else if (a.status === 1) p.dig = null;
                else if (a.status === 3 || a.status === 4) { const slot = 36 + p.held, it = p.inv[slot]; if (it) { if (a.status === 3 || it.count <= 1) p.inv[slot] = null; else it.count--; } }
                if (a.sequence !== undefined) client.send('acknowledge_player_digging', { sequenceId: a.sequence });
                break;
            }
            case 'block_place': {
                const { x, y, z } = a.location, slot = a.hand ? 45 : 36 + p.held, held = p.inv[slot];
                const ack = () => { if (a.sequence !== undefined) client.send('acknowledge_player_digging', { sequenceId: a.sequence }); };
                if (!held || !registry.blocksByName[held.name === 'redstone' ? 'redstone_wire' : held.name]) { ack(); break; }
                // the target cell (the clicked one when it is replaceable, else the one in front of the clicked face) must not hold a player
                const cs = this.get(x, y, z), f = FACES[a.direction] || [0, 1, 0];
                const t = cs !== null && REPLACEABLE.test(nameOf(cs)) ? { x, y, z } : { x: x + f[0], y: y + f[1], z: z + f[2] };
                const inside = [...this.players.values()].some((q) => Math.abs(q.pos.x - (t.x + 0.5)) < 0.8 && Math.abs(q.pos.z - (t.z + 0.5)) < 0.8 && q.pos.y < t.y + 1 && q.pos.y + 1.8 > t.y);
                if (inside) { stats.refused++; const s = this.get(t.x, t.y, t.z); if (s !== null) this.blockChange(t.x, t.y, t.z, s); ack(); break; }
                const j = await this.serve.ask({ op: 'place', x, y, z, face: a.direction, hy: a.cursorY, yaw: p.yaw, pitch: p.pitch, item: held.name });
                if (j.ok) { stats.places++; this.apply(j.changes); held.count--; if (held.count <= 0) p.inv[slot] = null; this.setSlot(p, slot); }
                else { stats.refused++; const s = this.get(t.x, t.y, t.z); if (s !== null) this.blockChange(t.x, t.y, t.z, s); }
                ack();
                break;
            }
            case 'window_click':
                // the client's own prediction of the changed slots is taken as the result (prototype: no validation of the click)
                if (a.windowId === 0) { for (const c of a.changedSlots || []) { p.inv[c.location] = Item.fromNotch(c.item); } }
                break;
            default: break;                                                                 // teleport_confirm, settings, keep_alive, arm_animation, entity_action, ...
        }
    }
    /** The commands the harness and play.js send over RCON: world commands go to serve, player commands are answered here. */
    async rcon(cmd) {
        stats.rcon++;
        let line = cmd.trim();
        const pre = /^execute in [a-z:_]+ run (.*)$/.exec(line); if (pre) line = pre[1];
        const w = line.split(/\s+/);
        if (['setblock', 'fill', 'clone'].includes(w[0]) || (w[0] === 'execute' && /^(execute (in \S+ )?(if|unless) (block|blocks) )/.test(line))) {
            const j = await this.serve.ask({ op: 'cmd', line });
            this.apply(j.changes);
            return j.out;
        }
        const p = this.players.get(w[1]);
        switch (w[0]) {
            case 'seed': return `Seed: [${process.env.SIM_SEED || 0}]`;
            case 'gamerule': case 'difficulty': case 'forceload': case 'tellraw': case 'time': case 'weather': case 'kill': case 'say': case 'tick': return '';
            case 'scoreboard': return /players get/.test(line) ? `${w[3]} has 0 [${w[4]}]` : '';
            case 'effect': return '';
            case 'gamemode': { const q = this.players.get(w[2]); if (q) { q.gm = { survival: 0, creative: 1, adventure: 2, spectator: 3 }[w[1]] ?? 0; q.client.send('game_state_change', { reason: 'change_game_mode', gameMode: q.gm }); q.client.send('abilities', { flags: q.gm === 3 ? 6 : q.gm === 1 ? 13 : 0, flyingSpeed: 0.05, walkingSpeed: 0.1 }); } return ''; }
            case 'tp': if (p) this.teleport(p, Number(w[2]), Number(w[3]), Number(w[4]), w[5] !== undefined ? Number(w[5]) : undefined, w[6] !== undefined ? Number(w[6]) : undefined); return p ? `Teleported ${w[1]}` : 'No entity was found';
            case 'give': if (!p) return 'No player was found'; this.give(p, w[2], Number(w[3] || 1)); return `Gave ${w[3] || 1} [${w[2]}] to ${w[1]}`;
            case 'clear': {
                if (!p) return 'No player was found';
                if (w[2] && w[3] === '0') { const n = w[2].replace(/^minecraft:/, ''); const c = p.inv.reduce((s, it) => s + (it && it.name === n ? it.count : 0), 0); return c ? `Found ${c} matching item(s) on player ${w[1]}` : `No items were found on player ${w[1]}`; }
                p.inv.fill(null); this.sendInventory(p); return '';
            }
            case 'item': {
                // item replace entity <name> <slot> with <item>[components] <count>
                const q = this.players.get(w[3]); if (!q) return 'No entity';
                const map = (sn) => { const [k, i] = sn.split('.'); return k === 'hotbar' ? 36 + Number(i) : k === 'inventory' ? 9 + Number(i) : { 'armor.head': 5, 'armor.chest': 6, 'armor.legs': 7, 'armor.feet': 8, 'weapon.offhand': 45 }[sn]; };
                const slot = map(w[4]), it = itemFrom(w[6], Number(w[7] || 1));
                if (slot === undefined || !it) return 'bad item';
                q.inv[slot] = it; this.setSlot(q, slot);
                return 'Replaced a slot';
            }
            case 'data': {
                const q = this.players.get(w[3]);
                if (q && w[4] === 'Pos') return `${w[3]} has the following entity data: [${q.pos.x}d, ${q.pos.y}d, ${q.pos.z}d]`;
                if (q && w[4] === 'Dimension') return `${w[3]} has the following entity data: "minecraft:overworld"`;
                return '';
            }
            case 'spreadplayers': { const q = this.players.get(w[w.length - 1]); if (q) { const x = Number(w[1]), z = Number(w[2]); await this.col(Math.floor(x) >> 4, Math.floor(z) >> 4); let y = 319; while (y > -64 && !registry.blocksByStateId[this.get(Math.floor(x), y, Math.floor(z))]?.boundingBox?.startsWith('block')) y--; this.teleport(q, Math.floor(x) + 0.5, y + 1, Math.floor(z) + 0.5); } return 'Spread 1 player'; }
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
    server.start();
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
    let ticks = 0;
    si.call(global, () => {
        virtual += 50; ticks++;
        for (const fn of [...polls.values()]) { try { fn(); } catch (e) { console.error('[front] physics poll', e && e.message); } }
        server.delayed();
        // the world clocks of serve (falling blocks landing) on the same game clock, one request per 5 ticks
        if (ticks % 5 === 0 && server.serve.info) server.serve.ask({ op: 'tick', n: 5 }).then((j) => server.apply(j.changes));
    }, Math.max(1, 50 / SPEED));
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
    rconMod.Rcon = class FakeRcon { constructor() {} async connect() { await server.serve.ready; return this; } async command(c) { return server.rcon(c); } end() {} close() {} };
    process.on('exit', () => { console.log(`[front] ${JSON.stringify(stats)}`); server.serve.close(); });
    console.log(`[front] in-process server for ${VERSION}, clocks x${SPEED}`);
    return server;
}

module.exports = { install, Server, Serve, FakeClient, stats, itemFrom };
if (module.parent && module.parent.id === 'internal/preload') module.exports.server = install();
