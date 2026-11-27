'use strict';
// PNG without a dependency: zlib from Node core plus the chunk format (RFC 2083). encode() writes 8-bit RGBA (filter 0 per row), decode() reads what the game's textures
// use: greyscale, RGB, palette (1/2/4/8 bit, tRNS), grey+alpha, RGBA, 8 bit, not interlaced (an interlaced or 16-bit file is refused with an Error).
const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; }
function crc32(buf, c = 0xffffffff) { for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c; }

function chunk(type, data) {
    const t = Buffer.from(type, 'ascii'), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length); crc.writeUInt32BE((crc32(data, crc32(t)) ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, t, data, crc]);
}

/** The scanlines (filter byte 0 + the row) of a w x h RGBA image. */
function raw(w, h, rgba) {
    if (!(w > 0 && h > 0) || rgba.length !== w * h * 4) throw new Error(`png: ${w}x${h} needs ${w * h * 4} bytes, got ${rgba.length}`);
    const out = Buffer.alloc((w * 4 + 1) * h);
    for (let y = 0; y < h; y++) { out[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(out, y * (w * 4 + 1) + 1); }
    return out;
}
function wrap(w, h, idat) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
/** RGBA bytes (Uint8Array/Buffer, w*h*4) -> PNG Buffer. */
function encode(w, h, rgba) { return wrap(w, h, zlib.deflateSync(raw(w, h, rgba), { level: 6 })); }
/** The same, compressed on libuv's thread pool (off the bots' event loop). */
function encodeAsync(w, h, rgba) {
    const r = raw(w, h, rgba);
    return new Promise((resolve, reject) => zlib.deflate(r, { level: 6 }, (e, z) => (e ? reject(e) : resolve(wrap(w, h, z)))));
}

/**
 * An opaque RGBA image as an indexed PNG (colour type 3, 8 bit): exact when it has at most 256 colours, else the 256 most frequent colours (the overlays, the text and the
 * sky stay exact) and every other colour mapped to its nearest of them (lossy: textures lose shades). About a third of the RGBA size. Returns { png, colours, lossy }.
 */
function indexed(w, h, rgba) {
    const n = w * h, freq = new Map();
    for (let i = 0; i < n; i++) { const c = (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]; freq.set(c, (freq.get(c) || 0) + 1); }
    const pal = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a)).slice(0, 256), idx = new Map(pal.map((c, i) => [c, i]));
    const near = (c) => {
        let best = 0, bd = Infinity; const r = c >> 16, g = (c >> 8) & 255, b = c & 255;
        for (let i = 0; i < pal.length; i++) { const p = pal[i], dr = r - (p >> 16), dg = g - ((p >> 8) & 255), db = b - (p & 255), d = 2 * dr * dr + 4 * dg * dg + 3 * db * db; if (d < bd) { bd = d; best = i; } }
        idx.set(c, best); return best;
    };
    const out = Buffer.alloc((w + 1) * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, c = (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]; const k = idx.get(c); out[y * (w + 1) + 1 + x] = k === undefined ? near(c) : k; }
    const plte = Buffer.alloc(pal.length * 3); pal.forEach((c, i) => { plte[i * 3] = c >> 16; plte[i * 3 + 1] = (c >> 8) & 255; plte[i * 3 + 2] = c & 255; });
    return { raw: out, plte, colours: freq.size, lossy: freq.size > 256 };
}
function wrapIndexed(w, h, plte, idat) {
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3;
    return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('PLTE', plte), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}
/** The indexed PNG, compressed on the thread pool. Resolves { png, colours, lossy }. */
function encodeIndexedAsync(w, h, rgba) {
    if (!(w > 0 && h > 0) || rgba.length !== w * h * 4) return Promise.reject(new Error('png: bad size'));
    const q = indexed(w, h, rgba);
    return new Promise((resolve, reject) => zlib.deflate(q.raw, { level: 9 }, (e, z) => (e ? reject(e) : resolve({ png: wrapIndexed(w, h, q.plte, z), colours: q.colours, lossy: q.lossy }))));
}

const paeth =(a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };

/** PNG Buffer -> { width, height, data: Uint8Array RGBA }. */
function decode(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error('png: not a PNG');
    let o = 8, w = 0, h = 0, depth = 0, type = 0, inter = 0, pal = null, trns = null; const idat = [];
    while (o + 8 <= buf.length) {
        const len = buf.readUInt32BE(o), t = buf.toString('ascii', o + 4, o + 8), d = buf.subarray(o + 8, o + 8 + len);
        if (o + 12 + len > buf.length) throw new Error('png: truncated');
        if (t === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; type = d[9]; inter = d[12]; }
        else if (t === 'PLTE') pal = d;
        else if (t === 'tRNS') trns = d;
        else if (t === 'IDAT') idat.push(d);
        else if (t === 'IEND') break;
        o += 12 + len;
    }
    if (!w || !h || w * h > 16 * 1024 * 1024) throw new Error('png: bad size');
    if (inter) throw new Error('png: interlaced');
    const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
    if (!ch || depth > 8 || (type !== 0 && type !== 3 && depth !== 8)) throw new Error(`png: colour type ${type} depth ${depth} not supported`);
    const bpp = Math.max(1, (ch * depth) >> 3), stride = (w * ch * depth + 7) >> 3;
    const z = zlib.inflateSync(Buffer.concat(idat));
    if (z.length < (stride + 1) * h) throw new Error('png: short image data');
    const px = Buffer.alloc(stride * h);
    for (let y = 0; y < h; y++) {
        const f = z[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, up = row - stride;
        for (let i = 0; i < stride; i++) {
            const x = z[src + i], a = i >= bpp ? px[row + i - bpp] : 0, b = y ? px[up + i] : 0, c = y && i >= bpp ? px[up + i - bpp] : 0;
            px[row + i] = (f === 0 ? x : f === 1 ? x + a : f === 2 ? x + b : f === 3 ? x + ((a + b) >> 1) : f === 4 ? x + paeth(a, b, c) : x) & 0xff;
        }
    }
    const out = new Uint8Array(w * h * 4), max = (1 << depth) - 1;
    const sample = (row, i) => (depth === 8 ? px[row + i] : (px[row + ((i * depth) >> 3)] >> (8 - depth - ((i * depth) & 7))) & max);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const row = y * stride, q = (y * w + x) * 4;
        if (type === 3) { const k = sample(row, x); out[q] = pal ? pal[k * 3] : 0; out[q + 1] = pal ? pal[k * 3 + 1] : 0; out[q + 2] = pal ? pal[k * 3 + 2] : 0; out[q + 3] = trns && k < trns.length ? trns[k] : 255; }
        else if (type === 0) { const v = Math.round(sample(row, x) * 255 / max); out[q] = out[q + 1] = out[q + 2] = v; out[q + 3] = 255; }
        else if (type === 4) { out[q] = out[q + 1] = out[q + 2] = px[row + x * 2]; out[q + 3] = px[row + x * 2 + 1]; }
        else if (type === 2) { out[q] = px[row + x * 3]; out[q + 1] = px[row + x * 3 + 1]; out[q + 2] = px[row + x * 3 + 2]; out[q + 3] = 255; }
        else { out[q] = px[row + x * 4]; out[q + 1] = px[row + x * 4 + 1]; out[q + 2] = px[row + x * 4 + 2]; out[q + 3] = px[row + x * 4 + 3]; }
    }
    return { width: w, height: h, data: out };
}

module.exports = { encode, encodeAsync, encodeIndexedAsync, decode, crc32 };
