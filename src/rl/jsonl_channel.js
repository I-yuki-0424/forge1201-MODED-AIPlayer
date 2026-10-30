'use strict';
// Append-only JSON-lines files for the DPOD file API (docs/implemented/RL-INTERFACE-v1.md, wire format PROTOCOL.md in DPOD).
// Each file has exactly one writer. The reader consumes only up to the last '\n', so a half-written line is harmless.
const fs = require('fs');

const MAX_LINE_BYTES = 4 * 1024 * 1024;

function dumps(msg) {
    // JSON.stringify turns NaN/Infinity into null silently; the protocol forbids them, so refuse instead.
    const s = JSON.stringify(msg, (_k, v) => {
        if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in message');
        return v;
    });
    return s + '\n';
}

class LineWriter {
    constructor(file) { this.fd = fs.openSync(file, 'a'); }
    send(msg) {
        const line = dumps(msg);
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error('message exceeds 4 MiB');
        fs.writeSync(this.fd, line);   // one write call on an append-mode fd
    }
    close() { fs.closeSync(this.fd); }
}

class LineReader {
    /** @param opts {runId, allowed:[types]}; invalid lines are counted in `.rejected` and skipped. */
    constructor(file, { runId, allowed }) {
        this.file = file; this.runId = runId; this.allowed = new Set(allowed);
        this.pos = 0; this.rest = Buffer.alloc(0); this.rejected = 0;
    }
    poll() {
        let size;
        try { size = fs.statSync(this.file).size; } catch { return []; }
        if (size <= this.pos) return [];
        const fd = fs.openSync(this.file, 'r');
        const chunk = Buffer.alloc(size - this.pos);
        try { fs.readSync(fd, chunk, 0, chunk.length, this.pos); } finally { fs.closeSync(fd); }
        this.pos = size;
        const buf = Buffer.concat([this.rest, chunk]);
        const end = buf.lastIndexOf(0x0a);
        if (end < 0) { this.rest = buf; return []; }
        this.rest = buf.subarray(end + 1);
        const out = [];
        for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
            if (!line) continue;
            try {
                const m = JSON.parse(line);
                if (m && m.v === 1 && this.allowed.has(m.type) && m.run_id === this.runId) out.push(m);
                else this.rejected++;
            } catch { this.rejected++; }
        }
        return out;
    }
}

module.exports = { LineWriter, LineReader, dumps };
