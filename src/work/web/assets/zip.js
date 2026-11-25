'use strict';
// A minimal reader of zip files (the Minecraft client jar): the central directory and stored or deflated entries, nothing else (no zip64, no encryption).
// Pure on a Buffer. Names are returned as written in the archive; the caller decides which ones it takes (assets/store.js takes a closed set of paths).
const zlib = require('zlib');

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

/** The entries of a zip in buffer `buf`: [{ name, method, csize, size, offset }]. Throws on a file that is not a zip. */
function entries(buf) {
    let e = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
    if (e < 0) throw new Error('zip: no end of central directory');
    const n = buf.readUInt16LE(e + 10), out = [];
    let p = buf.readUInt32LE(e + 16);
    for (let k = 0; k < n; k++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new Error('zip: bad central directory');
        const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
        const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), offset = buf.readUInt32LE(p + 42);
        out.push({ name: buf.toString('utf8', p + 46, p + 46 + nl), method, csize, size, offset });
        p += 46 + nl + xl + cl;
    }
    return out;
}

/** The bytes of one entry (from entries()). Size limit `max` (default 8 MB) against a crafted archive. */
function read(buf, ent, max = 8 * 1024 * 1024) {
    if (ent.size > max) throw new Error(`zip: ${ent.name} is larger than ${max} bytes`);
    const o = ent.offset;
    if (o + 30 > buf.length || buf.readUInt32LE(o) !== LOC) throw new Error('zip: bad local header');
    const start = o + 30 + buf.readUInt16LE(o + 26) + buf.readUInt16LE(o + 28), data = buf.subarray(start, start + ent.csize);
    if (ent.method === 0) return Buffer.from(data);
    if (ent.method === 8) { const r = zlib.inflateRawSync(data, { maxOutputLength: max }); if (r.length !== ent.size) throw new Error(`zip: ${ent.name} has the wrong size`); return r; }
    throw new Error(`zip: method ${ent.method} of ${ent.name} is not supported`);
}

module.exports = { entries, read };
