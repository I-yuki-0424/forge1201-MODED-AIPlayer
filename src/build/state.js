'use strict';
// Block states for the builder: names, properties as strings, which properties the builder decides (placement, clicks) and which the world decides (power, neighbours, entities),
// what a cell must become (the blueprint normalised), and which item places it. Pure: no bot, no world.

const AIR = new Set(['air', 'cave_air', 'void_air']);
const FLUIDS = new Set(['water', 'lava']);

/** 'minecraft:stone' -> 'stone'. */
const bare = (n) => String(n).replace(/^minecraft:/, '');

/** Every property value as a string (prismarine gives booleans and numbers, a litematic gives strings). */
function props(p) { const o = {}; for (const [k, v] of Object.entries(p || {})) o[k] = String(v); return o; }

/** 'name[a=b,c=d]' (the command syntax). */
function str(name, p = {}) {
    const e = Object.entries(p);
    return `minecraft:${bare(name)}${e.length ? '[' + e.map(([k, v]) => `${k}=${v}`).join(',') + ']' : ''}`;
}

// Properties the world sets by itself: the power of a circuit, what a neighbour connects to, who sleeps in a bed, what sound a note block makes.
const DERIVED_ALWAYS = new Set(['power', 'powered', 'triggered', 'enabled', 'extended', 'in_wall', 'occupied', 'instrument', 'short', 'distance', 'snowy', 'locked', 'attached', 'disarmed', 'has_record', 'has_book', 'bloom', 'shrieking', 'can_summon', 'sculk_sensor_phase', 'tip', 'thickness', 'berries', 'unstable']);
const CONNECTS = /^(.*_fence|.*_pane|glass_pane|iron_bars|.*_wall|redstone_wire|tripwire|chorus_plant|.*_mushroom_block|mushroom_stem|fire|vine|glow_lichen|sculk_vein|resin_clump)$/;
const DIRS6 = new Set(['north', 'south', 'east', 'west', 'up', 'down']);
const FACE_DECIDED = /^(vine|glow_lichen|sculk_vein|resin_clump|.*_mushroom_block|mushroom_stem)$/;      // their faces are placed (one per click), not connected

/**
 * Is the property `k` of block `name` decided by the builder (it must match) or by the world (it is ignored)?
 * Redstone torches, lamps and furnaces are lit by power or fuel; candles and campfires are lit by a click.
 */
function decided(name, k) {
    const n = bare(name);
    if (DERIVED_ALWAYS.has(k)) return false;
    if (k === 'lit') return /candle|campfire/.test(n);
    if (k === 'waterlogged') return true;
    if (k === 'shape' && /_stairs$/.test(n)) return false;                // stairs bend by their neighbours
    if (k === 'type' && /chest$/.test(n)) return true;
    if (DIRS6.has(k) && CONNECTS.test(n) && !FACE_DECIDED.test(n)) return false;
    if (k === 'open' && /^iron_(door|trapdoor)$/.test(n)) return false;    // only power opens them
    if (k === 'level' && /^(water|lava)$/.test(n)) return true;           // checked separately: a source must be a source, a flow is derived
    if (k === 'axis' && n === 'nether_portal') return true;
    if (k === 'age' || k === 'stage' || k === 'moisture' || k === 'hatch' || k === 'charges' || k === 'honey_level' || k === 'dusted') return false;
    return true;
}

/** The decided part of a state. */
function decidedProps(name, p) { const o = {}; for (const [k, v] of Object.entries(props(p))) if (decided(name, k)) o[k] = v; return o; }

/**
 * What the world holds at a cell matches what it should hold. Flowing fluids match a fluid of the same kind (they come from the sources); piston heads and the blocks a piston has moved are
 * judged with their piston (`dynamic`): a piston head where the blueprint has air (or the reverse) is the circuit, not the builder.
 */
function matches(want, have) {
    const wn = bare(want.name), hn = bare(have.name);
    if (AIR.has(wn)) return AIR.has(hn);
    if (FLUIDS.has(wn)) {
        if (wn !== hn) return false;
        const wl = Number(props(want.props).level || 0), hl = Number(props(have.props).level || 0);
        return wl === 0 ? hl === 0 : true;
    }
    if (wn !== hn) return false;
    const wp = decidedProps(wn, want.props), hp = props(have.props);
    for (const [k, v] of Object.entries(wp)) {
        if (hp[k] === undefined || hp[k] === v) continue;
        if (k === 'type' && /chest$/.test(wn) && v === 'right' && hp[k] === 'single') continue;         // the first half of a double chest stands alone until its partner joins it (the partner's own cell is checked)
        return false;
    }
    return true;
}

/** Cells whose difference the circuit makes (never broken or "repaired" by the builder): a piston's head or a block in motion where the blueprint has air, or the reverse. */
function dynamicPair(want, have) {
    const wn = bare(want.name), hn = bare(have.name);
    const moving = (n) => n === 'piston_head' || n === 'moving_piston';
    if (moving(hn) && (AIR.has(wn) || moving(wn))) return true;
    if (moving(wn) && AIR.has(hn)) return true;
    if (FLUIDS.has(wn) && Number(props(want.props).level || 0) > 0 && (AIR.has(hn) || hn === wn)) return true;       // a flow that has not (yet) reached this cell or has another level
    if (FLUIDS.has(hn) && Number(props(have.props).level || 0) > 0 && AIR.has(wn)) return false;                         // a flow where the blueprint has air: something leaks, that is wrong
    return false;
}

/**
 * The blueprint cell as the builder must leave it. A block in motion (moving_piston, saved in the middle of a piston's stroke) becomes the block it is carrying (its block entity's `blockState`);
 * a bed nobody sleeps in; everything else unchanged.
 */
function normalise(name, p, nbt) {
    let n = bare(name), q = props(p);
    if (n === 'moving_piston') {
        const bs = nbt && nbt.blockState;
        if (bs && typeof bs === 'object' && bs.Name) { n = bare(bs.Name); q = props(bs.Properties || {}); }
        else if (typeof bs === 'string') { n = bare(bs); q = {}; }
        else if (bs && typeof bs === 'object' && bs.id) { n = bare(bs.id); q = props(bs.properties || {}); }
        else { n = 'air'; q = {}; }
    }
    if (/_bed$/.test(n) && q.occupied === 'true') q.occupied = 'false';
    if (AIR.has(n)) { n = 'air'; q = {}; }
    return { name: n, props: q };
}

// The item that places a block, when it is not the block's own name.
const ITEM_OF = {
    redstone_wire: 'redstone', wall_torch: 'torch', redstone_wall_torch: 'redstone_torch', soul_wall_torch: 'soul_torch', tripwire: 'string', water: 'water_bucket', lava: 'lava_bucket',
    powder_snow: 'powder_snow_bucket', nether_portal: 'flint_and_steel', fire: 'flint_and_steel', soul_fire: 'flint_and_steel', bubble_column: 'water_bucket', cocoa: 'cocoa_beans',
    carrots: 'carrot', potatoes: 'potato', beetroots: 'beetroot_seeds', wheat: 'wheat_seeds', melon_stem: 'melon_seeds', pumpkin_stem: 'pumpkin_seeds', sweet_berry_bush: 'sweet_berries',
    cave_vines: 'glow_berries', cave_vines_plant: 'glow_berries', kelp_plant: 'kelp', twisting_vines_plant: 'twisting_vines', weeping_vines_plant: 'weeping_vines', big_dripleaf_stem: 'big_dripleaf',
    redstone_ore: 'redstone_ore', copper_wall_torch: 'copper_torch',
};
/** The item for a target state, or null when no item places it (piston heads, the head of a bed, flowing fluid, the upper half of a door: their other part does). */
function itemOf(name, p = {}) {
    const n = bare(name), q = props(p);
    if (AIR.has(n) || n === 'piston_head' || n === 'moving_piston' || n === 'end_portal' || n === 'end_gateway') return null;
    if (/_bed$/.test(n) && q.part === 'head') return null;
    if ((/_door$/.test(n) || /^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|pitcher_plant|tall_seagrass|small_dripleaf)$/.test(n)) && q.half === 'upper') return null;
    if (FLUIDS.has(n) && Number(q.level || 0) > 0) return null;
    if (/_wall_sign$/.test(n)) return n.replace('_wall_sign', '_sign');
    if (/_wall_hanging_sign$/.test(n)) return n.replace('_wall_hanging_sign', '_hanging_sign');
    if (/_wall_banner$/.test(n)) return n.replace('_wall_banner', '_banner');
    if (/_wall_(head|skull)$/.test(n)) return n.replace('_wall_', '_');
    if (/_wall_fan$/.test(n)) return n.replace('_wall_fan', '_fan');
    if (/^potted_/.test(n)) return 'flower_pot';
    if (/_cauldron$/.test(n)) return 'cauldron';
    return ITEM_OF[n] || n;
}

module.exports = { AIR, FLUIDS, bare, props, str, decided, decidedProps, matches, dynamicPair, normalise, itemOf };
