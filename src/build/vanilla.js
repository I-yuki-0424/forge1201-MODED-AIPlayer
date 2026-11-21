'use strict';
// Vanilla's placement rules as a forward model (BlockPlaceContext + Block.getStateForPlacement, 26.1): a survival player clicks face F of block N, the hit point on it, looking
// along a ray from its eye; the block goes into N + F. Given that click, what state does the block get? Only the properties the builder decides (state.js `decided`).
// Pure. Checked block by block on a live server by scripts/t26/place_probe.js.
const S = require('./state');

const DIRS = ['down', 'up', 'north', 'south', 'west', 'east'];
const VEC = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const OPP = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
const AXIS = { down: 'y', up: 'y', north: 'z', south: 'z', west: 'x', east: 'x' };
const HORIZ = new Set(['north', 'south', 'west', 'east']);
const FACE = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };

/** Direction.orderedByNearest for a look vector (dx, dy, dz) (any length): the six directions, nearest first. Vanilla's own arithmetic on yaw/pitch, here on the vector. */
function orderedByNearest(dx, dy, dz) {
    const n = Math.hypot(dx, dy, dz) || 1;
    const x = dx / n, y = dy / n, z = dz / n;
    const east = x > 0, up = y > 0, south = z > 0;
    const l = Math.abs(x), m = Math.abs(y), nn = Math.abs(z);
    const xd = east ? 'east' : 'west', yd = up ? 'up' : 'down', zd = south ? 'south' : 'north';
    // vanilla compares |sin yaw| with |cos yaw| (l, n) and |sin pitch| (m) with the horizontal parts scaled by cos pitch (o, p): on the unit look vector these are |x|, |z| and |y|
    const arr = (a, b, c) => [a, b, c, OPP[c], OPP[b], OPP[a]];
    if (l > nn) { if (m > l) return arr(yd, xd, zd); return nn > m ? arr(xd, zd, yd) : arr(xd, yd, zd); }
    if (m > nn) return arr(yd, zd, xd);
    return l > m ? arr(zd, xd, yd) : arr(zd, yd, xd);
}
/** The horizontal direction a look vector faces (Direction.fromYRot). */
function horizontalOf(dx, dz) { return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'east' : 'west') : (dz > 0 ? 'south' : 'north'); }

// what a click opens or uses instead of placing (without sneak)
const INTERACTIVE = /^(.*chest|barrel|.*shulker_box|hopper|dropper|dispenser|furnace|blast_furnace|smoker|crafting_table|crafter|note_block|repeater|comparator|.*_trapdoor|.*_door|.*_fence_gate|lever|.*_button|.*_bed|anvil|chipped_anvil|damaged_anvil|beacon|brewing_stand|daylight_detector|enchanting_table|grindstone|lectern|loom|smithing_table|stonecutter|cartography_table|fletching_table|cake|.*_cake|bell|composter|cauldron|.*_cauldron|jukebox|respawn_anchor|.*_sign|.*_hanging_sign|chiseled_bookshelf|decorated_pot|vault|redstone_wire|flower_pot|potted_.*|command_block|structure_block|jigsaw|dragon_egg|end_portal_frame)$/;

const HOR_OPP = /^(chest|trapped_chest|ender_chest|furnace|blast_furnace|smoker|.*_glazed_terracotta|carved_pumpkin|jack_o_lantern|lectern|loom|stonecutter|beehive|bee_nest|chiseled_bookshelf|decorated_pot|vault|trial_spawner|repeater|comparator)$/;
const HOR_SAME = /^(.*_stairs|.*_bed|.*_fence_gate|.*_door|campfire|soul_campfire)$/;
const PISTONLIKE = /^(piston|sticky_piston|dispenser|dropper|barrel|crafter)$/;
const CLICK_FACE = /^(.*shulker_box|end_rod|lightning_rod|.*_amethyst_bud|amethyst_cluster)$/;
const CLICK_AXIS = /^(.*_log|.*_wood|.*_stem|.*_hyphae|stripped_.*|basalt|polished_basalt|bone_block|hay_block|purpur_pillar|quartz_pillar|.*_pillar|chain|.*_chain|bamboo_block|deepslate|.*_froglight|creaking_heart)$/;
const TORCHES = { torch: 'wall_torch', redstone_torch: 'redstone_wall_torch', soul_torch: 'soul_wall_torch', copper_torch: 'copper_wall_torch' };
const WALL_OF = (n) => TORCHES[n] || (/_sign$/.test(n) ? n.replace(/_sign$/, '_wall_sign') : /_banner$/.test(n) ? n.replace(/_banner$/, '_wall_banner') : null);

/**
 * The block an item places with a click, as {name, props} (decided properties), or null when the placement fails (nothing to hang on).
 * @param item   the held item (a block's item: 'redstone', 'torch', 'oak_sign' ...)
 * @param ctx    { face: clicked face ('up' ...), hitY: hit point's height relative to the target cell (-0.5..1.5), look: [dx, dy, dz], sneak,
 *                 at(dx, dy, dz): the state of a neighbour of the target cell as it stands ({name, props} | null), solid(dx, dy, dz): is that neighbour's face toward the cell sturdy }
 */
function predict(item, ctx) {
    const { face: F, look } = ctx, horiz = horizontalOf(look[0], look[2]), dirs = orderedByNearest(look[0], look[1], look[2]);
    const nearest = dirs[0];
    // getNearestLookingDirections: the clicked face's opposite first (a click on a block's side hangs things on that block)
    const ld = [OPP[F], ...dirs.filter((d) => d !== OPP[F])];
    const solid = (d) => ctx.solid(...VEC[d]);
    const n = item === 'redstone' ? 'redstone_wire' : item;
    if (TORCHES[n] || /_sign$/.test(n) || /_banner$/.test(n)) {
        for (const d of ld) {
            if (d === 'up') continue;
            if (d === 'down') { if (solid('down')) return { name: n, props: /_sign$|_banner$/.test(n) ? {} : {} }; continue; }
            if (solid(d)) return { name: WALL_OF(n), props: { facing: OPP[d] } };
        }
        return null;
    }
    if (n === 'lever' || /_button$/.test(n)) {
        for (const d of ld) {
            if (d === 'up' || d === 'down') { if (solid(d)) return { name: n, props: { face: d === 'up' ? 'ceiling' : 'floor', facing: horiz } }; continue; }
            if (solid(d)) return { name: n, props: { face: 'wall', facing: OPP[d] } };
        }
        return null;
    }
    if (n === 'ladder') { for (const d of ld) if (HORIZ.has(d) && solid(d)) return { name: n, props: { facing: OPP[d] } }; return null; }
    if (/(^|_)lantern$/.test(n) && n !== 'jack_o_lantern') { for (const d of ld) if ((d === 'up' || d === 'down') && solid(d)) return { name: n, props: { hanging: String(d === 'up') } }; return null; }
    if (n === 'hopper') { const f = OPP[F]; return { name: n, props: { facing: AXIS[f] === 'y' ? 'down' : f } }; }
    if (n === 'observer') return { name: n, props: { facing: nearest } };
    if (PISTONLIKE.test(n)) return { name: n, props: { facing: OPP[nearest] } };
    if (/_trapdoor$/.test(n)) return HORIZ.has(F) ? { name: n, props: { facing: F, half: ctx.hitY > 0.5 ? 'top' : 'bottom', open: 'false' } } : { name: n, props: { facing: OPP[horiz], half: F === 'up' ? 'bottom' : 'top', open: 'false' } };
    const half = F !== 'down' && (F === 'up' || !(ctx.hitY > 0.5)) ? 'bottom' : 'top';
    if (/_slab$/.test(n)) return { name: n, props: { type: half } };
    if (/_stairs$/.test(n)) return { name: n, props: { facing: horiz, half } };
    if (/^(chest|trapped_chest)$/.test(n)) {
        let facing = OPP[horiz], type = 'single';
        const single = (d) => { const s = ctx.at(...VEC[d]); return s && S.bare(s.name) === n && (s.props.type || 'single') === 'single' ? s.props.facing : null; };
        if (!ctx.sneak && HORIZ.has(F)) { const pf = single(OPP[F]); if (pf && AXIS[pf] !== AXIS[F]) { facing = pf; type = CCW[pf] === OPP[F] ? 'right' : 'left'; } }
        if (type === 'single' && !ctx.sneak) { if (facing === single(CW[facing])) type = 'left'; else if (facing === single(CCW[facing])) type = 'right'; }
        return { name: n, props: { facing, type, waterlogged: 'false' } };
    }
    if (HOR_OPP.test(n)) return { name: n, props: { facing: OPP[horiz] } };
    if (/_bed$/.test(n)) return { name: n, props: { facing: horiz, part: 'foot' } };
    if (HOR_SAME.test(n)) return { name: n, props: { facing: horiz, ...(/_fence_gate$/.test(n) ? { open: 'false' } : {}) } };
    if (/anvil$/.test(n)) return { name: n, props: { facing: CW[horiz] } };
    if (CLICK_FACE.test(n)) return { name: n, props: { facing: F } };
    if (CLICK_AXIS.test(n)) return { name: n, props: { axis: AXIS[F] } };
    if (/^(rail|powered_rail|detector_rail|activator_rail)$/.test(n)) return { name: n, props: { shape: horiz === 'east' || horiz === 'west' ? 'east_west' : 'north_south' } };
    return { name: n, props: {} };
}

module.exports = { predict, orderedByNearest, horizontalOf, INTERACTIVE, DIRS, VEC, OPP, CW, CCW, AXIS, FACE, HORIZ };
