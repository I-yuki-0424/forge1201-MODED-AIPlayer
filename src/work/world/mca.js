'use strict';
// Top-down map of a Minecraft world from its region files (Anvil .mca), read-only, no server round trip: for every column the block
// at the MOTION_BLOCKING height (trees, water and buildings count, plants do not), as a palette index plus the height.
// Chunks that were never generated to `full`, or are unreadable, stay 0 ("unknown"). Used by the map in the console (mapworker.js
// runs it off the main thread: a region is ~1000 chunks to inflate and parse).
const fs = require('fs');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');

const SIDE = 512;

function entryAt(sec, i) {                      // palette index of block i (0..4095) in a section's block_states
    const pal = sec.palette, data = sec.data;
    if (!data || pal.length === 1) return 0;
    const bits = Math.max(4, Math.ceil(Math.log2(pal.length))), per = Math.floor(64 / bits), mask = (1 << bits) - 1;
    const [hi, lo] = data[Math.floor(i / per)], shift = (i % per) * bits;
    const v = shift >= 32 ? hi >>> (shift - 32) : shift + bits <= 32 ? lo >>> shift : (lo >>> shift) | (hi << (32 - shift));
    return v & mask;
}

const AIR = /(^|:)(air|cave_air|void_air)$/;

/**
 * Slice mode (`top` = a y): the first block that is not air from y = top downwards, instead of the heightmap. The Nether has a bedrock roof, so its heightmap shows
 * bedrock everywhere (the map was one black square); a slice at cave level shows the floor of the caverns and the rock that is cut. Fluids count as a block.
 */
function sliceColumns(secs, minY, top, cx, cz, names, nameIndex, out) {
    const maxSec = Math.max(...secs.keys()), start = Math.min(top, maxSec * 16 + 15), airSec = new Map();
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        let y = start;
        for (; y >= minY; y--) {
            const sec = secs.get(y >> 4);
            if (!sec) { y = (y >> 4) * 16; continue; }                       // no section stored: air (the loop's y-- then enters the section below)
            let air = airSec.get(sec); if (air === undefined) { air = sec.palette.every((n) => AIR.test(n)); airSec.set(sec, air); }
            if (air) { y = (y >> 4) * 16; continue; }
            const name = sec.palette[entryAt(sec, ((y & 15) * 16 + z) * 16 + x)];
            if (AIR.test(name)) continue;
            let n = nameIndex.get(name);
            if (n === undefined) { if (names.length >= 255) n = 255; else { names.push(name); n = names.length; } nameIndex.set(name, n); }
            const o = (cz * 16 + z) * SIDE + cx * 16 + x;
            out.idx[o] = n; out.h[o] = Math.max(0, Math.min(255, (y + 64) >> 1));
            break;
        }
    }
}

/** Decode one chunk's NBT (root value) into the 16x16 columns of `out`: { idx: Uint8Array, h: Uint8Array }, at chunk (cx, cz) of the region. */
function chunkColumns(v, cx, cz, names, nameIndex, out, top = null) {
    const hm = v.Heightmaps && v.Heightmaps.value.MOTION_BLOCKING;
    if (!hm || !v.sections) return false;
    const st = v.Status && v.Status.value;
    if (st && st !== 'minecraft:full' && st !== 'full') return false;
    const secs = new Map();
    for (const s of v.sections.value.value) {
        const bs = s.block_states && s.block_states.value;
        if (!bs) continue;
        secs.set(s.Y.value, { palette: bs.palette.value.value.map((p) => p.Name.value), data: bs.data ? bs.data.value : null });
    }
    const minY = v.yPos.value * 16;
    if (top !== null) { sliceColumns(secs, minY, top, cx, cz, names, nameIndex, out); return true; }
    const total = Math.max(...secs.keys()) * 16 + 16 - minY;
    const hb = Math.ceil(Math.log2(total + 1)), hper = Math.floor(64 / hb), hmask = (1 << hb) - 1, longs = hm.value;
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        const i = z * 16 + x, [hi, lo] = longs[Math.floor(i / hper)], shift = (i % hper) * hb;
        const val = (shift >= 32 ? hi >>> (shift - 32) : shift + hb <= 32 ? lo >>> shift : (lo >>> shift) | (hi << (32 - shift))) & hmask;
        const y = val + minY - 1, sec = secs.get(y >> 4);
        if (!sec || val === 0) continue;
        const name = sec.palette[entryAt(sec, ((y & 15) * 16 + z) * 16 + x)];
        let n = nameIndex.get(name);
        if (n === undefined) { if (names.length >= 255) n = 255; else { names.push(name); n = names.length; } nameIndex.set(name, n); }
        const o = (cz * 16 + z) * SIDE + cx * 16 + x;
        out.idx[o] = n; out.h[o] = Math.max(0, Math.min(255, (y + 64) >> 1));
    }
    return true;
}

/** Read one region file (`top`: a y to look down from instead of the surface, see sliceColumns). Returns { names: [blockName...] (index i+1), idx: Uint8Array(512*512), h: Uint8Array(512*512), chunks, skipped }. */
function readRegion(file, top = null) {
    const out = { names: [], idx: new Uint8Array(SIDE * SIDE), h: new Uint8Array(SIDE * SIDE), chunks: 0, skipped: 0 }, nameIndex = new Map();
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        if (size < 8192) return out;
        const hdr = Buffer.alloc(8192); fs.readSync(fd, hdr, 0, 8192, 0);
        for (let i = 0; i < 1024; i++) {
            const off = hdr.readUIntBE(i * 4, 3), n = hdr[i * 4 + 3];
            if (!off || !n || (off + n) * 4096 > size) continue;
            try {
                const b = Buffer.alloc(n * 4096); fs.readSync(fd, b, 0, n * 4096, off * 4096);
                const len = b.readInt32BE(0), comp = b[4];
                if (len < 2 || len > n * 4096 - 4 || comp > 3) { out.skipped++; continue; }          // external (.mcc) or newer compression: skip
                const body = b.subarray(5, 4 + len);
                const raw = comp === 2 ? zlib.inflateSync(body) : comp === 1 ? zlib.gunzipSync(body) : body;
                const v = nbt.parseUncompressed(raw, 'big').value;
                if (chunkColumns(v, i & 31, i >> 5, out.names, nameIndex, out, top)) out.chunks++;
            } catch (_) { out.skipped++; }
        }
    } finally { fs.closeSync(fd); }
    return out;
}

module.exports = { readRegion, entryAt, SIDE };
