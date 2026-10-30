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

    /** Run one console command and return its text output. Commands are issued one at a time by the caller. */
    async command(cmd) {
        if (!this.sock) throw new Error('rcon: not connected');
        const reply = await this._request(this.nextId++, TYPE_EXEC, cmd, this.opts.timeoutMs);
        return reply.body;
    }

    close() { if (this.sock) this.sock.destroy(); this.sock = null; }
}

module.exports = { Rcon, encode, decode };
