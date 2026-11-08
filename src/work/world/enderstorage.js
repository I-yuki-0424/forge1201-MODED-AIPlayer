'use strict';
// Ender Storage (CodeChicken's mod `enderstorage`, 1.20.1 build 2.11.0): ender chests, tanks and pouches whose contents belong to a FREQUENCY, not to a block or a
// player. Facts, read from the mod's classes and from a live world on 2026-11-09 (docs/implemented/WORK-CONSOLE-v1.md, v10):
//   - a frequency is three wool colours (left, middle, right; 16^3 = 4096 of them) and, for a private chest, the owner's UUID;
//   - the block entity stores it as `Frequency: {left, middle, right: int (wool meta), owner?: UUID, owner_name?: JSON text}`;
//   - the items of every frequency are saved in the WORLD folder, `EnderStorage/data1.dat` / `data2.dat` (the manager alternates between them), gzip NBT:
//     { "<key>": { size: 0|1|2 (3x3, 3x9, 6x9; config item_storage_size, default 1 = 27 slots), Items: [{Slot, id, Count, tag?}] } } with
//     key = `left=<colour>,middle=<colour>,right=<colour>[,owner=<uuid>],type=item`;
//   - a chest opened by anyone shows that one storage: items cross dimensions and need no player.
// This file only knows the data (read-only on the world folder). Opening a chest is `deposit` / `withdraw` of the action layer on the chest's block.
const fs = require('fs');
const path = require('path');
const nbt = require('prismarine-nbt');

/** In wool-meta order: the number is the colour's index in the block entity. */
const COLOURS = Object.freeze(['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BLOCKS = /^(enderstorage:)?ender_chest$/;       // the mod's chest (`ender_chest` alone is the vanilla one: the player's own, see isVanillaEnderChest)

/** A colour from its name ("light blue", "lightBlue", "silver" ...) or wool index 0..15; throws on anything else. */
function colour(v) {
    if (Number.isInteger(v) && v >= 0 && v < 16) return COLOURS[v];
    const s = String(v).trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');
    const alias = { silver: 'light_gray', grey: 'gray', light_grey: 'light_gray', lightblue: 'light_blue', lightgray: 'light_gray', lightgrey: 'light_gray' };
    const c = alias[s] || s;
    if (!COLOURS.includes(c)) throw new Error(`colour ${String(v).slice(0, 16)}: one of ${COLOURS.join(', ')}`);
    return c;
}

/** {left, middle, right, owner?} validated and normalised (owner: a UUID, lower case; absent = a public chest). */
function frequency(e) {
    if (!e || typeof e !== 'object') throw new Error('ender: {left, middle, right} colours');
    const f = { left: colour(e.left), middle: colour(e.middle), right: colour(e.right) };
    if (e.owner !== undefined && e.owner !== null && e.owner !== '') {
        const o = String(e.owner).toLowerCase();
        if (!UUID.test(o)) throw new Error('ender.owner: the player UUID of a private chest (leave empty for a public one)');
        f.owner = o;
    }
    return f;
}

/** The key the mod saves a frequency under. */
const keyOf = (f, type = 'item') => `left=${f.left},middle=${f.middle},right=${f.right}${f.owner ? `,owner=${f.owner}` : ''},type=${type}`;

/** The reverse of keyOf; null when the text is not a key. */
function parseKey(key) {
    const m = /^left=([a-z_]+),middle=([a-z_]+),right=([a-z_]+)(?:,owner=([0-9a-f-]{36}))?,type=([a-z_]+)$/.exec(String(key));
    if (!m) return null;
    try { const f = frequency({ left: m[1], middle: m[2], right: m[3], owner: m[4] }); return { ...f, type: m[5] }; } catch (_) { return null; }
}

/** Colours as a short label for a table: "blue / white / white" (+ " (private)"). */
const label = (f) => `${f.left} / ${f.middle} / ${f.right}${f.owner ? ' (private)' : ''}`;

const isMod = (blockName) => BLOCKS.test(String(blockName || '')) && String(blockName).startsWith('enderstorage:');
const isVanillaEnderChest = (blockName) => /^(minecraft:)?ender_chest$/.test(String(blockName || ''));

/** [{item, count}] biggest first, empty slots left out. `Items` is the NBT list as prismarine-nbt `simplify` gives it. */
function summarize(items) {
    const m = new Map();
    for (const it of items || []) { const id = String(it.id || ''); const n = Number(it.Count) || 0; if (!n || id === 'minecraft:air') continue; m.set(id, (m.get(id) || 0) + n); }
    return [...m].map(([item, count]) => ({ item, count })).sort((a, b) => b.count - a.count || a.item.localeCompare(b.item));
}

const SIZES = [9, 27, 54];

/** Read one data file; null when it is missing or unreadable (the manager may be writing it). */
async function readFile(file) {
    let buf; try { buf = fs.readFileSync(file); } catch (_) { return null; }
    try { return nbt.simplify((await nbt.parse(buf)).parsed); } catch (_) { return null; }
}

/**
 * Every frequency the world has saved: { file, mtimeMs, frequencies: [{key, type, left, middle, right, owner?, size (slots), used (slots with an item), items: [{item, count}]}] }.
 * The newer of data1.dat / data2.dat wins; when it cannot be read (half written) the other one is used. `worldDir` null or no folder = null.
 */
async function readStore(worldDir) {
    if (!worldDir) return null;
    const dir = path.join(worldDir, 'EnderStorage');
    const files = ['data1.dat', 'data2.dat'].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f))
        .map((f) => ({ f, t: fs.statSync(f).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { f, t } of files) {
        const data = await readFile(f); if (!data || typeof data !== 'object') continue;
        const out = [];
        for (const [key, v] of Object.entries(data)) {
            const p = parseKey(key); if (!p || !v) continue;
            const slots = Array.isArray(v.Items) ? v.Items : [];
            out.push({ key, ...p, size: SIZES[v.size] || slots.length, used: slots.filter((s) => s.id !== 'minecraft:air' && s.Count > 0).length, items: summarize(slots),
                slots: slots.filter((s) => s.id !== 'minecraft:air' && s.Count > 0).map((s) => ({ slot: Number(s.Slot), id: String(s.id), count: Number(s.Count), tag: s.tag && Object.keys(s.tag).length ? s.tag : undefined })) });
        }
        return { file: f, mtimeMs: t, frequencies: out.sort((a, b) => a.key.localeCompare(b.key)) };
    }
    return files.length ? null : { file: null, mtimeMs: 0, frequencies: [] };
}

module.exports = { COLOURS, colour, frequency, keyOf, parseKey, label, isMod, isVanillaEnderChest, summarize, readStore, BLOCKS };
