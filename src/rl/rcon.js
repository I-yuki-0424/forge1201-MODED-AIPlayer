'use strict';
// Minimal Source-RCON client (Minecraft server console). The RL harness, not the bot, uses it to reset episodes,
// so the bot itself never needs operator rights or issues cheat commands (see Issue 5 in bot_actuator.js).
const net = require('net');

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const MAX_BODY = 4096;

function encode(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const out = Buffer.alloc(14 + b.length);
    out.writeInt32LE(10 + b.length, 0);
    out.writeInt32LE(id, 4);
    out.writeInt32LE(type, 8);
    b.copy(out, 12);
    return out;
}

/** Split a byte stream into packets. Returns [packets, rest]. */
function decode(buf) {
    const packets = [];
    let off = 0;
    while (buf.length - off >= 4) {
        const len = buf.readInt32LE(off);
        if (len < 10 || len > MAX_BODY + 10) throw new Error(`rcon: bad packet length ${len}`);
        if (buf.length - off < 4 + len) break;
        packets.push({
            id: buf.readInt32LE(off + 4),
            type: buf.readInt32LE(off + 8),
            body: buf.toString('utf8', off + 12, off + 4 + len - 2),
        });
        off += 4 + len;
    }
    return [packets, buf.subarray(off)];
}

class Rcon {
    constructor({ host, port, password, timeoutMs = 5000 }) {
        this.opts = { host, port, password, timeoutMs };
        this.nextId = 1;
        this.pending = new Map();
        this.rest = Buffer.alloc(0);
        this.sock = null;
    }

    async connect() {
        const { host, port, password, timeoutMs } = this.opts;
        this.sock = net.connect({ host, port });
        this.sock.setNoDelay(true);
        await new Promise((resolve, reject) => {
            this.sock.once('connect', resolve);
            this.sock.once('error', reject);
        });
        this.sock.on('data', (d) => this._onData(d));
        this.sock.on('close', () => this._failAll(new Error('rcon: connection closed')));
        this.sock.on('error', (e) => this._failAll(e));
        const authId = this.nextId++;
        const reply = await this._request(authId, TYPE_AUTH, password, timeoutMs);
        if (reply.id === -1) throw new Error('rcon: authentication failed');
    }

    _onData(d) {
        let packets;
        try {
            [packets, this.rest] = decode(Buffer.concat([this.rest, d]));
        } catch (e) { return this._failAll(e); }
        for (const p of packets) {
            // Auth replies carry id -1 on failure; match those to the oldest pending auth request.
            const key = this.pending.has(p.id) ? p.id : (p.id === -1 ? [...this.pending.keys()][0] : undefined);
            const w = this.pending.get(key);
            if (!w) continue;
            // a command's reply comes in packets of at most 4096 bytes: gathered until the marker sent after the command is answered (the server answers in order)
            if (w.parts) {
                w.parts.push(p.body);
                // a part shorter than the server's 4096 characters is the last one: done; a full one may have more after it: the marker asks
                if (p.body.length < 4096) { if (!w.markerSent) { this.pending.delete(key); clearTimeout(w.timer); w.resolve({ id: key, type: TYPE_EXEC, body: w.parts.join('') }); } }
                else if (!w.markerSent) { w.markerSent = true; this.pending.set(w.marker, w.mk); this.sock.write(encode(w.marker, 0, '')); }
                continue;
            }
            if (w.marker) {
                const m = this.pending.get(w.marker);
                this.pending.delete(key); clearTimeout(w.timer);
                if (m) { this.pending.delete(w.marker); clearTimeout(m.timer); m.resolve({ id: w.marker, type: TYPE_EXEC, body: m.parts.join('') }); }
                continue;
            }
            // The server answers an auth request with an empty type-0 packet first, then the type-2 result.
            if (w.type === TYPE_AUTH && p.type !== TYPE_EXEC) continue;
            this.pending.delete(key);
            clearTimeout(w.timer);
            w.resolve(p);
        }
    }

    _failAll(err) {
        for (const [id, w] of this.pending) { clearTimeout(w.timer); w.reject(err); this.pending.delete(id); }
    }

    _request(id, type, body, timeoutMs) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`rcon: timeout after ${timeoutMs} ms`));
            }, timeoutMs);
            this.pending.set(id, { type, resolve, reject, timer });
            this.sock.write(encode(id, type, body));
        });
    }

    /**
     * Run one console command and return its whole text output. The server splits a reply longer than 4096 bytes over several packets; the first one alone cut a shulker box's
     * contents off mid-string ("snbt: unterminated string at 4053", 2026-11-22). A part shorter than 4096 characters ends the reply; after a full part a second request of an
     * unknown type is sent: the server answers it with "Unknown request 0" after the last part of the command's reply, and that answer ends the reply.
     */
    async command(cmd) {
        if (!this.sock) throw new Error('rcon: not connected');
        const id = this.nextId++, marker = this.nextId++, { timeoutMs } = this.opts;
        return new Promise((resolve, reject) => {
            const fail = (e) => { this.pending.delete(id); this.pending.delete(marker); reject(e); };
            const main = { type: TYPE_EXEC, parts: [], resolve: (p) => resolve(p.body), reject: fail };
            // a server that ignores the marker: what arrived by the timeout is the reply
            main.timer = setTimeout(() => { if (main.parts.length) { this.pending.delete(id); this.pending.delete(marker); resolve(main.parts.join('')); } else fail(new Error(`rcon: timeout after ${timeoutMs} ms`)); }, timeoutMs);
            // the marker goes out only after a full first part, as a write of its own: written together with the command, the server's RCON thread (one packet per read)
            // lost track of the stream and closed the connection
            main.marker = marker; main.mk = { type: 0, marker: id, resolve: () => {}, reject: fail, timer: null };
            this.pending.set(id, main);
            this.sock.write(encode(id, TYPE_EXEC, cmd));
        });
    }

    close() { if (this.sock) this.sock.destroy(); this.sock = null; }
}

module.exports = { Rcon, encode, decode };
