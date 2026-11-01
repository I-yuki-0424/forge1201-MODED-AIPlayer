'use strict';
// World model for the skills: what a cell is for walking and what a block looks like to a ray. Read-only.
// `fromBot(bot)` adapts a Mineflayer bot; tests build the same interface from a plain map (tests/test_skills_pure.js).

const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'cactus', 'sweet_berry_bush', 'wither_rose', 'powder_snow',
    'cobweb', 'campfire', 'soul_campfire', 'pointed_dripstone']);
const LIQUID = new Set(['water', 'lava', 'bubble_column']);
// Water a player swims in (plants that only exist under water count as water); bubble columns push, so they stay 'liquid'.
const WATER = new Set(['water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);
// What the client physics climbs (prismarine-physics isOnLadder: ladders and vines; holding jump climbs since 1.14).
const CLIMB = new Set(['ladder', 'vine']);
// Blocks the use key acts on (vanilla opens or toggles them instead of placing the held block against them).
const INTERACTIVE = /(^|_)(chest|barrel|crafting_table|furnace|smoker|door|trapdoor|fence_gate|lever|button|bed|anvil|shulker_box|hopper|dispenser|dropper|brewing_stand|enchanting_table|loom|grindstone|stonecutter|cartography_table|smithing_table|note_block|repeater|comparator|daylight_detector|bell|lectern|composter|cake|beacon)$/;

/**
 * Walking kind of a block: 'air' (walk through), 'solid' (full or near-full collision box: stand on it), 'water' (swim
 * in it), 'climb' (ladder, vine: pass through, climb with jump), 'liquid' (bubble columns), 'danger' (never step in or on),
 * 'partial' (some other collision shape: slabs, fences, closed doors; treated as an obstacle), 'unknown' (not loaded).
 */
function kindOf(block) {
    if (!block) return 'unknown';
    if (DANGER.has(block.name)) return 'danger';
    if (WATER.has(block.name)) return 'water';
    if (CLIMB.has(block.name)) return 'climb';
    if (LIQUID.has(block.name)) return 'liquid';
    if (block.boundingBox === 'empty') return 'air';
    const s = block.shapes || [];
    // A full cube, or one box over the whole cell up to >= 0.8 (mud, soul sand, dirt path, farmland): the bot stands on
    // top of it in the cell above (motion.feetCell), so for walking it is ground like a full block.
    if (s.length === 1 && s[0][0] <= 0 && s[0][1] <= 0 && s[0][2] <= 0 && s[0][3] >= 1 && s[0][4] >= 0.8 && s[0][5] >= 1) return 'solid';
    return 'partial';
}

/**
 * Boxes a view ray can hit, relative to the cell. Collision shapes where the block has them; small outline boxes for
 * the non-colliding blocks a player aims at (levers, buttons, torches, open fence gates). Other non-colliding blocks
 * (grass, flowers, air) are transparent here: the crosshair passes through them in this model.
 */
function shapesOf(block) {
    if (!block) return [];
    if (block.shapes && block.shapes.length) return block.shapes;
    const n = block.name;
    if (/(^|_)(lever|button)$/.test(n)) {
        const p = block.getProperties ? block.getProperties() : {};
        if (p.face === 'ceiling') return [[0.25, 0.6, 0.25, 0.75, 1, 0.75]];
        if (p.face === 'wall') {
            // `facing` points away from the supporting block.
            return [{ north: [0.25, 0.2, 0.6, 0.75, 0.8, 1], south: [0.25, 0.2, 0, 0.75, 0.8, 0.4],
                west: [0.6, 0.2, 0.25, 1, 0.8, 0.75], east: [0, 0.2, 0.25, 0.4, 0.8, 0.75] }[p.facing] || [0.25, 0.2, 0.25, 0.75, 0.8, 0.75]];
        }
        return [[0.25, 0, 0.25, 0.75, 0.4, 0.75]];
    }
    if (/torch$/.test(n)) return [[0.375, 0, 0.375, 0.625, 0.625, 0.625]];
    if (/fence_gate$/.test(n)) return [[0, 0, 0.375, 1, 1, 0.625], [0.375, 0, 0, 0.625, 1, 1]];
    return [];
}

const isInteractive = (name) => INTERACTIVE.test(name || '');

/**
 * World interface over a Mineflayer bot: blockAt (a full Block), kindAt, shapesAt, and sid/info (state id of a cell, -1 when
 * not loaded; what that state is). kindAt/shapesAt never build a Block per cell: everything about a cell follows from its
 * state id, so a Block is made once per distinct state (bot.blockAt builds one with biome and block entity per call, which
 * was 60 % of the RL environment's CPU, 2026-11-01 profile). One instance per bot and registry.
 */
function fromBot(bot) {
    const c = bot.__skillWorld;
    if (c && c.registry === bot.registry) return c.w;
    const Vec3 = require('vec3');
    const blockAt = (x, y, z) => bot.blockAt(new Vec3(x, y, z), false);
    let w;
    if (bot.world && typeof bot.world.getBlockStateId === 'function' && typeof bot.world.getColumnAt === 'function') {
        // The copy of prismarine-block mineflayer itself loads (a transitive dependency, not one of ours).
        const Block = require(require.resolve('prismarine-block', { paths: [require.resolve('mineflayer')] }))(bot.registry);
        const cache = new Map(), v = new Vec3(0, 0, 0);
        const info = (s) => {
            let i = cache.get(s);
            if (!i) {
                let b = null;
                try { b = Block.fromStateId(s, 0); } catch { /* a state the registry does not know */ }
                i = b && b.name ? { name: b.name, kind: kindOf(b), shapes: shapesOf(b), diggable: b.diggable, block: b }
                    : { name: 'unknown', kind: 'partial', shapes: [], diggable: false, block: null };
                cache.set(s, i);
            }
            return i;
        };
        // The column of the last lookup is kept (neighbouring cells share it); a chunk load or unload forgets it.
        let mx = NaN, mz = NaN, col = null;
        const forget = () => { mx = NaN; };
        if (typeof bot.world.on === 'function') { bot.world.on('chunkColumnLoad', forget); bot.world.on('chunkColumnUnload', forget); }
        const lp = { x: 0, y: 0, z: 0 };
        const sid = (x, y, z) => {
            const cx = x >> 4, cz = z >> 4;
            if (cx !== mx || cz !== mz) { v.x = x; v.y = 0; v.z = z; col = bot.world.getColumnAt(v) || null; mx = cx; mz = cz; }
            if (!col) return -1;
            lp.x = x & 15; lp.y = y; lp.z = z & 15;
            return col.getBlockStateId(lp);
        };
        w = { blockAt, sid, info,
            kindAt: (x, y, z) => { const s = sid(x, y, z); return s < 0 ? 'unknown' : info(s).kind; },
            shapesAt: (x, y, z) => { const s = sid(x, y, z); return s < 0 ? [] : info(s).shapes; },
            nameAt: (x, y, z) => { const s = sid(x, y, z); return s < 0 ? null : info(s).name; } };
    } else {
        w = { blockAt, kindAt: (x, y, z) => kindOf(blockAt(x, y, z)), shapesAt: (x, y, z) => shapesOf(blockAt(x, y, z)),
            nameAt: (x, y, z) => blockAt(x, y, z)?.name ?? null };
    }
    bot.__skillWorld = { registry: bot.registry, w };
    return w;
}

/**
 * Cells within `r` (Euclidean) of `c` whose state satisfies pred(info), nearest first, at most `count`. Chunk sections whose
 * palette holds no matching state are skipped without reading a cell (mineflayer's findBlocks misses 1.18 palettes and
 * scans every cell). `dy` limits the vertical range.
 */
function findStates(bot, w, c, r, pred, { count = Infinity, dy = r } = {}) {
    const memo = pred.__memo || (pred.__memo = new Map());
    const want = (s) => { let m = memo.get(s); if (m === undefined) memo.set(s, m = !!pred(w.info(s))); return m; };
    const cx = Math.floor(c.x), cy = Math.floor(c.y), cz = Math.floor(c.z), out = [];
    for (let X = (cx - r) >> 4; X <= (cx + r) >> 4; X++) for (let Z = (cz - r) >> 4; Z <= (cz + r) >> 4; Z++) {
        const col = bot.world.getColumn(X, Z);
        if (!col || !col.sections) continue;
        const minY = col.minY ?? bot.game.minY ?? 0;
        for (let S = (cy - dy - minY) >> 4; S <= (cy + dy - minY) >> 4; S++) {
            const sec = col.sections[S];
            if (!sec || !sec.data) continue;
            const pal = sec.data.value !== undefined ? [sec.data.value] : sec.data.palette;
            if (pal && !pal.some(want)) continue;
            const y0 = Math.max(minY + 16 * S, cy - dy), y1 = Math.min(minY + 16 * S + 15, cy + dy);
            for (let x = Math.max(16 * X, cx - r); x <= Math.min(16 * X + 15, cx + r); x++) for (let z = Math.max(16 * Z, cz - r); z <= Math.min(16 * Z + 15, cz + r); z++) {
                for (let y = y0; y <= y1; y++) {
                    const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2;
                    if (d2 > r * r) continue;
                    const s = w.sid(x, y, z);
                    if (s >= 0 && want(s)) out.push({ x, y, z, d2, sid: s });
                }
            }
        }
    }
    return out.sort((a, b) => a.d2 - b.d2).slice(0, count);
}

/** A player's body passes through a cell of this kind (feet or head). */
const passable = (k) => k === 'air' || k === 'climb';

/** A player fits in the cell (feet and head free) and has solid support below. */
function standable(w, x, y, z) {
    return passable(w.kindAt(x, y, z)) && passable(w.kindAt(x, y + 1, z)) && w.kindAt(x, y - 1, z) === 'solid';
}

/** The feet can be held in this water cell with the head at or above the surface while holding jump (surface swimming):
 *  feet in water, head cell water or air, and air at most two cells above the feet. Deeper water is not entered (no air). */
function swimmable(w, x, y, z) {
    if (w.kindAt(x, y, z) !== 'water') return false;
    const h = w.kindAt(x, y + 1, z);
    return h === 'air' || (h === 'water' && w.kindAt(x, y + 2, z) === 'air');
}

/** Feet in a ladder/vine cell with the head free: the player can hang there (holding jump climbs, nothing held slides down). */
const climbable = (w, x, y, z) => w.kindAt(x, y, z) === 'climb' && passable(w.kindAt(x, y + 1, z));

module.exports = { kindOf, shapesOf, isInteractive, fromBot, findStates, standable, swimmable, climbable, passable, DANGER, WATER, CLIMB };
