'use strict';
// One column of the saved world: the top block of x, z that a pit would start from, read from the region file (Anvil .mca), exactly (the map's height is in steps of two).
// Used by the Pits page's "Top = ground" when no bot has the column loaded (owner 2026-11-25, list 5 Small 3: the button did not work). Read-only, one chunk per call.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const nbt = require('prismarine-nbt');
const { entryAt } = require('./mca');

/** Not ground: air, fluids, trees, plants and thin things lying on the ground. grass_block, snow_block, moss_block are ground. */
const NOT_GROUND = /(^|:)(air|cave_air|void_air|water|lava|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant|short_grass|grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|sugar_cane|bamboo|lily_pad|torch|wall_torch)$|leaves|_log$|_wood$|_stem$|hyphae|sapling|flower|tulip|orchid|allium|bluet|daisy|poppy|dandelion|cornflower|lily_of|rose_bush|peony|lilac|sunflower|_carpet$|mushroom$|_roots$|sprouts$|_button$|_pressure_plate$|rail$|_sign$|_banner$/;
const ground = (name) => !NOT_GROUND.test(name);

/** The chunk NBT (root value) holding x, z from the region folder `dir`, or null (no file, never generated). */
function readChunk(dir, x, z) {
    const cx = Math.floor(x / 16), cz = Math.floor(z / 16), file = path.join(dir, `r.${Math.floor(cx / 32)}.${Math.floor(cz / 32)}.mca`);
    let fd; try { fd = fs.openSync(file, 'r'); } catch (_) { return null; }
    try {
        const hdr = Buffer.alloc(4); const i = (cx & 31) + (cz & 31) * 32;
        if (fs.readSync(fd, hdr, 0, 4, i * 4) < 4) return null;
        const off = hdr.readUIntBE(0, 3), n = hdr[3]; if (!off || !n) return null;
        const b = Buffer.alloc(n * 4096); fs.readSync(fd, b, 0, n * 4096, off * 4096);
        const len = b.readInt32BE(0), comp = b[4];
        if (len < 2 || len > n * 4096 - 4 || comp > 3) return null;
        const body = b.subarray(5, 4 + len), raw = comp === 2 ? zlib.inflateSync(body) : comp === 1 ? zlib.gunzipSync(body) : body;
        return nbt.parseUncompressed(raw, 'big').value;
    } finally { fs.closeSync(fd); }
}

/** The highest ground block of a chunk's column (x, z world coordinates): { y, block } or null (no data, or nothing but air and fluids). */
function topOfChunk(v, x, z, accept = ground) {
    if (!v || !v.sections) return null;
    const secs = [];
    for (const s of v.sections.value.value) {
        const bs = s.block_states && s.block_states.value; if (!bs) continue;
        secs.push({ y: s.Y.value, palette: bs.palette.value.value.map((p) => p.Name.value), data: bs.data ? bs.data.value : null });
    }
    secs.sort((a, b) => b.y - a.y);
    const lx = ((x % 16) + 16) % 16, lz = ((z % 16) + 16) % 16;
    for (const sec of secs) {
        if (sec.palette.every((n) => !accept(n))) continue;
        for (let ly = 15; ly >= 0; ly--) {
            const name = sec.palette[entryAt(sec, (ly * 16 + lz) * 16 + lx)];
            if (accept(name)) return { y: sec.y * 16 + ly, block: name };
        }
    }
    return null;
}

/** Top ground block at x, z in the region folder `dir` (the saved world: as new as the server's last save). */
function topAt(dir, x, z, accept = ground) { return topOfChunk(readChunk(dir, x, z), x, z, accept); }

module.exports = { topAt, topOfChunk, readChunk, ground, NOT_GROUND };
