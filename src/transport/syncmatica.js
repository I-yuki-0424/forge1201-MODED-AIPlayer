'use strict';
// Syncmatica client (Fabric mode): the server-wide list of Litematica placements and their `.litematic` files, over the mod's own plugin
// channel. Read from the mod's classes (0.3.20, 2026-11-17), not guessed; docs/implemented/SYNCMATICA-v1.md has the table.
//
// Wire format. ONE custom payload channel `syncmatica:main`; its data is  utf(sub-channel "syncmatica:<type>")  +  the type's body.
// Strings are varint-length UTF-8, UUIDs two big-endian longs, BlockPos one packed long (x 26 bits | z 26 bits | y 12 bits), ints 4 bytes.
//   server -> client  register_version  utf serverVersion                 (first thing on join)
//   client -> server  register_version  utf "0.3.20"
//   server -> client  feature_request   (empty)    client -> server  feature  utf "CORE\nFEATURE\n..."   (and the same the other way round)
//   server -> client  confirm_user      int n, n x metadata               (the whole list, features agreed)
//   server -> client  register_metadata metadata   (a placement shared later)      remove_syncmatic UUID      modify UUID + position [+ UUID, utf]
//   client -> server  request_download  UUID   -> server: send_litematic UUID int len bytes[len] (16384 per packet), the client answers
//                     received_litematic UUID after EACH chunk, the server ends with finished_litematic UUID; the file's hash is
//                     UUID.nameUUIDFromBytes(md5(file)).
//   share (client -> server): register_metadata, the server answers request_download, the client uploads (send_litematic / received_litematic / finished_litematic).
// metadata = UUID id, utf fileName, UUID hash, [DISPLAY_NAME: utf name], [CORE_EX: UUID owner, utf ownerName, UUID lastModifiedBy, utf name],
//            [VERSION: varint litematicVersion, varint dataVersion], position
// position = BlockPos origin, utf dimension, int rotation (NONE, CLOCKWISE_90, CLOCKWISE_180, COUNTERCLOCKWISE_90), int mirror (NONE, LEFT_RIGHT, FRONT_BACK),
//            [CORE_EX: int n, n x (utf subRegionName, BlockPos, int rotation, int mirror)]
// Fabric's networking API only sends a channel to a client that announced it (`minecraft:register`); a plain bot does that in the configuration phase.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const CHANNEL = 'syncmatica:main';
const VERSION = '0.3.20';
const FEATURES = ['CORE', 'FEATURE', 'MESSAGE', 'CORE_EX', 'VERSION', 'DISPLAY_NAME'];
const CHUNK = 16384;
const ROTATIONS = ['NONE', 'CLOCKWISE_90', 'CLOCKWISE_180', 'COUNTERCLOCKWISE_90'];
const MIRRORS = ['NONE', 'LEFT_RIGHT', 'FRONT_BACK'];
const TYPES = ['register_metadata', 'cancel_share', 'request_download', 'send_litematic', 'received_litematic', 'finished_litematic', 'cancel_litematic',
    'remove_syncmatic', 'register_version', 'confirm_user', 'feature_request', 'feature', 'modify', 'modify_request', 'modify_request_deny',
    'modify_request_accept', 'modify_finish', 'mesage'];
const MAX_FILE = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------- codec (pure)

class Reader {
    constructor(buf) { this.b = buf; this.i = 0; }
    left() { return this.b.length - this.i; }
    need(n) { if (n < 0 || this.i + n > this.b.length) throw new Error(`syncmatica packet too short (need ${n}, have ${this.left()})`); }
    int() { this.need(4); const v = this.b.readInt32BE(this.i); this.i += 4; return v; }
    long() { this.need(8); const v = this.b.readBigInt64BE(this.i); this.i += 8; return v; }
    varint() {
        let v = 0, shift = 0;
        for (let k = 0; k < 5; k++) { this.need(1); const c = this.b[this.i++]; v |= (c & 0x7f) << shift; if (!(c & 0x80)) return v; shift += 7; }
        throw new Error('varint too long');
    }
    utf(max = 32767) { const n = this.varint(); if (n > max * 3) throw new Error('string too long'); this.need(n); const s = this.b.toString('utf8', this.i, this.i + n); this.i += n; return s; }
    uuid() { this.need(16); const h = this.b.toString('hex', this.i, this.i + 16); this.i += 16; return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`; }
    pos() { const v = this.long(); return unpackPos(v); }
    rest() { const r = this.b.subarray(this.i); this.i = this.b.length; return r; }
    bytes(n) { this.need(n); const r = this.b.subarray(this.i, this.i + n); this.i += n; return r; }
}

class Writer {
    constructor() { this.parts = []; }
    int(v) { const b = Buffer.alloc(4); b.writeInt32BE(v | 0); this.parts.push(b); return this; }
    long(v) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, BigInt(v))); this.parts.push(b); return this; }
    varint(v) { const o = []; v >>>= 0; do { let c = v & 0x7f; v >>>= 7; if (v) c |= 0x80; o.push(c); } while (v); this.parts.push(Buffer.from(o)); return this; }
    utf(s) { const b = Buffer.from(String(s), 'utf8'); this.varint(b.length); this.parts.push(b); return this; }
    uuid(u) { this.parts.push(Buffer.from(String(u).replace(/-/g, ''), 'hex')); return this; }
    pos(p) { return this.long(packPos(p)); }
    bytes(b) { this.parts.push(Buffer.from(b)); return this; }
    done() { return Buffer.concat(this.parts); }
}

/** BlockPos long: x in the top 26 bits, z in the middle 26, y in the low 12 (all signed). */
function unpackPos(v) {
    const x = Number(BigInt.asIntN(26, v >> 38n)), z = Number(BigInt.asIntN(26, v >> 12n)), y = Number(BigInt.asIntN(12, v));
    return { x, y, z };
}
function packPos({ x, y, z }) { return ((BigInt(x) & 0x3ffffffn) << 38n) | ((BigInt(z) & 0x3ffffffn) << 12n) | (BigInt(y) & 0xfffn); }

/** The channel payload of one packet: utf("syncmatica:<type>") + body. */
function encode(type, body = Buffer.alloc(0)) {
    if (!TYPES.includes(type)) throw new Error(`unknown syncmatica packet ${type}`);
    return Buffer.concat([new Writer().utf(`syncmatica:${type}`).done(), body]);
}
/** Split a payload into {type, body}; type is null for a sub-channel this client does not know. */
function decode(buf) {
    const r = new Reader(buf), id = r.utf(256);
    const m = /^syncmatica:([a-z_]+)$/.exec(id);
    return { type: m && TYPES.includes(m[1]) ? m[1] : null, id, body: r.rest() };
}

/** Hash of a file as the server computes it: UUID.nameUUIDFromBytes(md5(file)) (md5 of the md5, version 3 bits set). */
function hashOf(file) {
    const d = crypto.createHash('md5').update(crypto.createHash('md5').update(file).digest()).digest();
    d[6] = (d[6] & 0x0f) | 0x30; d[8] = (d[8] & 0x3f) | 0x80;
    const h = d.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function readPosition(r, features, p) {
    p.pos = r.pos(); p.dimension = r.utf(256);
    p.rotation = ROTATIONS[r.int()] ?? 'NONE'; p.mirror = MIRRORS[r.int()] ?? 'NONE';
    p.subRegions = [];
    if (features.has('CORE_EX')) {
        const n = r.int();
        if (n < 0 || n > 4096) throw new Error(`bad sub-region count ${n}`);
        for (let k = 0; k < n; k++) p.subRegions.push({ name: r.utf(256), pos: r.pos(), rotation: ROTATIONS[r.int()] ?? 'NONE', mirror: MIRRORS[r.int()] ?? 'NONE' });
    }
    return p;
}
function writePosition(w, p, features) {
    w.pos(p.pos).utf(p.dimension).int(Math.max(0, ROTATIONS.indexOf(p.rotation))).int(Math.max(0, MIRRORS.indexOf(p.mirror)));
    if (features.has('CORE_EX')) {
        const s = p.subRegions || [];
        w.int(s.length);
        for (const q of s) w.utf(q.name).pos(q.pos).int(Math.max(0, ROTATIONS.indexOf(q.rotation))).int(Math.max(0, MIRRORS.indexOf(q.mirror)));
    }
    return w;
}

/** One placement as the server sends it (see the format above). `features` = the Set both sides agreed on. */
function readMetadata(r, features) {
    const p = { id: r.uuid(), fileName: r.utf(256), hash: r.uuid(), name: null, owner: null, ownerName: null, lastModifiedBy: null, lastModifiedName: null, litematicVersion: null, dataVersion: null };
    if (features.has('DISPLAY_NAME')) p.name = r.utf(256);
    if (features.has('CORE_EX')) { p.owner = r.uuid(); p.ownerName = r.utf(64); p.lastModifiedBy = r.uuid(); p.lastModifiedName = r.utf(64); }
    if (features.has('VERSION')) { p.litematicVersion = r.varint(); p.dataVersion = r.varint(); }
    return readPosition(r, features, p);
}
function writeMetadata(p, features) {
    const w = new Writer().uuid(p.id).utf(p.fileName).uuid(p.hash);
    if (features.has('DISPLAY_NAME')) w.utf(p.name || p.fileName);
    if (features.has('CORE_EX')) w.uuid(p.owner).utf(p.ownerName || '').uuid(p.lastModifiedBy || p.owner).utf(p.lastModifiedName || p.ownerName || '');
    if (features.has('VERSION')) w.varint(p.litematicVersion || 0).varint(p.dataVersion || 0);
    return writePosition(w, p, features).done();
}

// ---------------------------------------------------------------------------------------------------------------- client

/**
 * Attach to a bot. Emits: 'ready' (the list arrived), 'placement' (a placement added or moved), 'removed' (id), 'message' ({type, text}).
 * `client.placements` is a Map id -> placement; `client.fetch(id)` downloads the file (Buffer, hash verified); `client.share(...)` uploads one.
 */
class SyncmaticaClient extends EventEmitter {
    constructor(bot, { send } = {}) {
        super();
        this.bot = bot; this.placements = new Map(); this.ready = false; this.serverVersion = null;
        this.features = new Set(FEATURES); this.downloads = new Map(); this.uploads = new Map(); this.log = [];
        this._send = send || ((payload) => bot._client.write('custom_payload', { channel: CHANNEL, data: payload }));
        if (!send) this._attach();
    }

    _attach() {
        const c = this.bot._client;
        const announce = (state) => { try { c.write('custom_payload', { channel: 'minecraft:register', data: Buffer.from(`${CHANNEL}\0`) }); } catch (e) { this.note(`register in ${state} failed: ${e.message}`); } };
        // the configuration phase is where Fabric collects the channels a client understands; the play phase repeats it for servers that take it there
        c.on('select_known_packs', () => announce('configuration'));
        c.on('registry_data', (() => { let done = false; return () => { if (!done) { done = true; announce('configuration'); } }; })());
        this.bot.once('login', () => announce('play'));
        c.on('custom_payload', (p) => { if (p && p.channel === CHANNEL) this.receive(Buffer.from(p.data)); });
    }

    note(s) { this.log.push(s); if (this.log.length > 200) this.log.shift(); this.emit('log', s); }
    send(type, body) { this._send(encode(type, body)); }

    /** One inbound payload. Errors are noted and the packet dropped: a bad packet from a server must not kill the bot. */
    receive(buf) {
        let m;
        try { m = decode(buf); } catch (e) { return this.note(`undecodable payload: ${e.message}`); }
        if (!m.type) return this.note(`unknown sub-channel ${m.id}`);
        try { this.handle(m.type, new Reader(m.body)); } catch (e) { this.note(`${m.type}: ${e.message}`); this.emit('error_packet', m.type, e); }
    }

    handle(type, r) {
        switch (type) {
            case 'register_version': this.serverVersion = r.utf(64); this.send('register_version', new Writer().utf(VERSION).done()); break;
            case 'feature_request': this.send('feature', new Writer().utf(FEATURES.join('\n')).done()); break;
            case 'feature': this.serverFeatures = new Set(r.utf(32767).split('\n').filter(Boolean)); break;       // what the server writes follows what this client declared, so `features` stays ours
            case 'confirm_user': {
                const n = r.int();
                if (n < 0 || n > 10000) throw new Error(`bad placement count ${n}`);
                for (let k = 0; k < n; k++) { const p = readMetadata(r, this.features); this.placements.set(p.id, p); }
                this.ready = true; this.emit('ready', [...this.placements.values()]);
                break;
            }
            case 'register_metadata': { const p = readMetadata(r, this.features); this.placements.set(p.id, p); this.emit('placement', p); break; }
            case 'remove_syncmatic': { const id = r.uuid(); this.placements.delete(id); this.emit('removed', id); break; }
            case 'modify': {
                const id = r.uuid(), p = this.placements.get(id);
                if (!p) throw new Error(`modify of unknown placement ${id}`);
                readPosition(r, this.features, p);
                if (this.features.has('CORE_EX') && r.left() >= 16) { p.lastModifiedBy = r.uuid(); p.lastModifiedName = r.utf(64); }
                this.emit('placement', p);
                break;
            }
            case 'mesage': this.emit('message', { type: r.utf(32), text: r.utf(1024) }); break;
            case 'send_litematic': this._chunk(r); break;
            case 'finished_litematic': this._finish(r.uuid()); break;
            case 'cancel_litematic': { const id = r.uuid(), d = this.downloads.get(id); if (d) { this.downloads.delete(id); d.reject(new Error('the server cancelled the download')); } break; }
            case 'request_download': this._upload(r.uuid()); break;
            case 'received_litematic': this._upload(r.uuid(), true); break;
            default: break;      // modify_request*, modify_finish, cancel_share: nothing a reader does
        }
    }

    // -------- download
    /** The file of a placement (Buffer). Resolves after the server's finished packet, rejects on a hash mismatch, a cancel or the timeout. */
    fetch(id, { timeoutMs = 60000 } = {}) {
        const p = this.placements.get(id);
        if (!p) return Promise.reject(new Error(`unknown placement ${id}`));
        if (this.downloads.has(id)) return this.downloads.get(id).promise;
        const d = { chunks: [], size: 0, hash: p.hash };
        d.promise = new Promise((resolve, reject) => {
            d.resolve = resolve; d.reject = reject;
            d.timer = setTimeout(() => { this.downloads.delete(id); reject(new Error(`download of ${id} timed out`)); }, timeoutMs);
        });
        this.downloads.set(id, d);
        this.send('request_download', new Writer().uuid(id).done());
        return d.promise;
    }
    _chunk(r) {
        const id = r.uuid(), n = r.int(), d = this.downloads.get(id);
        if (!d) return this.note(`chunk of ${id} without a download`);
        if (n < 0 || n > r.left()) return d.reject(new Error(`bad chunk length ${n}`));
        d.size += n;
        if (d.size > MAX_FILE) { this.downloads.delete(id); clearTimeout(d.timer); return d.reject(new Error('litematic larger than 32 MiB')); }
        d.chunks.push(Buffer.from(r.bytes(n)));
        this.send('received_litematic', new Writer().uuid(id).done());
    }
    _finish(id) {
        const d = this.downloads.get(id);
        if (!d) return;
        this.downloads.delete(id); clearTimeout(d.timer);
        const file = Buffer.concat(d.chunks), got = hashOf(file);
        if (got !== d.hash) return d.reject(new Error(`hash mismatch: the server announced ${d.hash}, the file is ${got}`));
        d.resolve(file);
    }

    // -------- share (upload)
    /** Publish a file as a placement; resolves when the server has the file (it then lists the placement and tells every client). */
    share({ file, name, fileName, pos, dimension = 'minecraft:overworld', rotation = 'NONE', mirror = 'NONE', owner, ownerName, litematicVersion = 7, dataVersion = 0 }) {
        if (!this.ready) return Promise.reject(new Error('not connected to the Syncmatica list yet'));
        const id = crypto.randomUUID(), hash = hashOf(file);
        const p = { id, fileName: fileName || `${name}.litematic`, hash, name, owner, ownerName, lastModifiedBy: owner, lastModifiedName: ownerName, litematicVersion, dataVersion, pos, dimension, rotation, mirror, subRegions: [] };
        const u = { file, offset: 0, placement: p };
        u.promise = new Promise((resolve, reject) => { u.resolve = resolve; u.reject = reject; u.timer = setTimeout(() => { this.uploads.delete(id); reject(new Error('upload timed out')); }, 60000); });
        this.uploads.set(id, u);
        this.send('register_metadata', writeMetadata(p, this.features));
        return u.promise.then(() => p);
    }
    _upload(id, ack = false) {
        const u = this.uploads.get(id);
        if (!u) return;
        if (u.offset >= u.file.length) {
            this.send('finished_litematic', new Writer().uuid(id).done());
            this.uploads.delete(id); clearTimeout(u.timer); u.resolve();
            return;
        }
        const part = u.file.subarray(u.offset, u.offset + CHUNK);
        u.offset += part.length;
        this.send('send_litematic', new Writer().uuid(id).int(part.length).bytes(part).done());
    }
}

/** Attach a Syncmatica client to a bot (Fabric mode, a server that runs Syncmatica). */
const attach = (bot, opts) => new SyncmaticaClient(bot, opts);

module.exports = { attach, SyncmaticaClient, Reader, Writer, encode, decode, hashOf, readMetadata, writeMetadata, readPosition, packPos, unpackPos, CHANNEL, VERSION, FEATURES, ROTATIONS, MIRRORS, TYPES, CHUNK };
