'use strict';
// How a player gets a block state into a cell: the vanilla placement rules (BlockItem.place -> Block.getStateForPlacement) written out per block family, for a placement "into the air"
// (the use packet names the target cell itself: the server replaces the air there, so the clicked face and the look are free choices and no neighbour is needed to click on), and what
// has to stand first (support, a partner, the cell an observer watches). Pure. Verified block by block on a live server by scripts/t26/rules_probe.js.
//
// A recipe: { op: 'place'|'ignite'|'pour'|'none', item, face, cursor: [x,y,z], look: {h, v}, sneak, clicks, clickLook, deps: [[dx,dy,dz], ...], late }
//   face     the clicked face (0 down, 1 up, 2 north, 3 south, 4 west, 5 east); look.h a horizontal direction the player faces, look.v 'up'|'down'|null (the nearest looking direction is
//            vertical); clicks: right-clicks after the placement (note, delay, mode, open); deps: cells (relative) that must hold their target first; late: placed after every other block.
const S = require('./state');

const FACE = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
const VEC = { down: [0, -1, 0], up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0] };
const OPP = { down: 'up', up: 'down', north: 'south', south: 'north', west: 'east', east: 'west' };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' };
const CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
const HORIZ = ['north', 'south', 'west', 'east'];
// mineflayer's yaw: 0 = north (-z), pi/2 = west, pi = south, -pi/2 = east; pitch > 0 looks up
const YAW = { north: 0, west: Math.PI / 2, south: Math.PI, east: -Math.PI / 2 };
const PITCH_V = (80 * Math.PI) / 180;
/** The yaw and pitch of a look spec: horizontal direction h (default north), vertical v. */
function lookAngles(look) {
    const h = (look && look.h) || 'north', v = look && look.v;
    return { yaw: YAW[h], pitch: v === 'up' ? PITCH_V : v === 'down' ? -PITCH_V : 0 };
}
/** A look whose nearest direction is `d` (any of the six). */
const lookAt = (d, h) => (d === 'up' || d === 'down' ? { h: h || 'north', v: d } : { h: d, v: null });

const FLOOR = /^(redstone_wire|repeater|comparator|rail|powered_rail|detector_rail|activator_rail|.*_pressure_plate|.*_carpet|moss_carpet|pale_moss_carpet|torch|soul_torch|redstone_torch|copper_torch|.*_sign|.*_banner|snow|.*candle|sea_pickle|cake|.*_cake|flower_pot|potted_.*|.*_sapling|dandelion|poppy|blue_orchid|allium|azure_bluet|.*_tulip|oxeye_daisy|cornflower|lily_of_the_valley|wither_rose|torchflower|sunflower|lilac|rose_bush|peony|short_grass|tall_grass|fern|large_fern|dead_bush|.*_mushroom|sugar_cane|bamboo|cactus|kelp|seagrass|.*_coral|.*_coral_fan|turtle_egg|frogspawn|lily_pad|scaffolding|pointed_dripstone|.*_door|bell|lantern|soul_lantern|.*_lantern|chain|fire|soul_fire)$/;
const GRAVITY = /^(sand|red_sand|gravel|suspicious_sand|suspicious_gravel|.*_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg)$/;
const PISTONLIKE = /^(piston|sticky_piston|dispenser|dropper|barrel|crafter|command_block|chain_command_block|repeating_command_block)$/;        // facing = the opposite of the look
const LOOK_FACING = /^(observer)$/;                                                                                                       // facing = the look
const HOR_OPP = /^(chest|trapped_chest|ender_chest|furnace|blast_furnace|smoker|.*_glazed_terracotta|carved_pumpkin|jack_o_lantern|lectern|loom|stonecutter|beehive|bee_nest|chiseled_bookshelf|decorated_pot|vault|trial_spawner|.*_shelf|copper_golem_statue)$/;
const HOR_SAME = /^(.*_stairs|.*_bed|.*_fence_gate|.*_door|campfire|soul_campfire|.*_anvil|anvil|cocoa)$/;
const CLICK_FACE = /^(.*shulker_box|end_rod|lightning_rod|.*_amethyst_bud|amethyst_cluster)$/;      // facing = the clicked face
const CLICK_AXIS = /^(.*_log|.*_wood|.*_stem|.*_hyphae|stripped_.*|basalt|polished_basalt|bone_block|hay_block|purpur_pillar|quartz_pillar|.*_pillar|chain|.*_chain|bamboo_block|muddy_mangrove_roots|deepslate|infested_deepslate|ochre_froglight|verdant_froglight|pearlescent_froglight|creaking_heart|pale_oak_wood)$/;
const WALL_ATTACH = /^(wall_torch|soul_wall_torch|redstone_wall_torch|copper_wall_torch|ladder|.*_wall_sign|.*_wall_banner|tripwire_hook|.*_wall_hanging_sign)$/;   // facing = the opposite of the look (the block looked at holds it)
const FACE_ATTACHED = /^(lever|.*_button|grindstone)$/;

/** A placement into the air at the cell itself with this face, cursor, look and sneak. */
const place = (item, face, look, extra = {}) => ({ op: 'place', item, face: FACE[face], cursor: [0.5, face === 'up' ? 0.99 : face === 'down' ? 0.01 : 0.5, 0.5], look, sneak: false, clicks: 0, deps: [], ...extra });

/**
 * The recipe for a target state (normalised by state.normalise). `at(dx, dy, dz)` gives the target state of a neighbour cell (or null outside the blueprint), for the rules that look
 * at neighbours (chest halves, observers, note blocks). Returns null for a cell nothing is placed in (air, piston heads, flowing fluid, the head of a bed, the upper half of a door).
 */
function recipe(t, at = () => null) {
    const n = S.bare(t.name), p = S.props(t.props), item = S.itemOf(n, p);
    if (S.AIR.has(n) || n === 'piston_head' || n === 'moving_piston') return null;
    if (n === 'water' || n === 'lava') return Number(p.level || 0) > 0 ? null : { op: 'pour', item, deps: [], late: true, clicks: 0 };
    if (n === 'nether_portal') return { op: 'ignite', item: 'flint_and_steel', portal: true, deps: [], late: true, clicks: 0 };
    if (n === 'fire' || n === 'soul_fire') return { op: 'ignite', item: 'flint_and_steel', deps: [[0, -1, 0]], late: true, clicks: 0 };
    if (!item) return null;
    let r;
    const f = p.facing;
    // foot here, head at +facing; `room`: the head's cell must be empty at the click, or the server places nothing (BedBlock.getStateForPlacement: the head cell must be replaceable).
    // A bot pillared up in the head cell and clicked the side of its own pillar: 159 beds 'got air' in hc1/hd1, b081a 780,74,570 "head cell had pumpkin"
    if (/_bed$/.test(n)) r = place(item, 'up', { h: f }, { room: [VEC[f]] });
    else if (/^(chest|trapped_chest)$/.test(n)) {
        // facing = the opposite of the look. A double chest: the RIGHT half first with sneak (stays single), then the LEFT half without sneak joins it (the clockwise neighbour is tried first).
        const type = p.type || 'single';
        r = place(item, 'up', { h: OPP[f] }, { sneak: type !== 'left' });
        if (type === 'left') r.deps.push(VEC[CW[f]]);
    } else if (n === 'hopper') r = place(item, f === 'down' ? 'up' : OPP[f], { h: 'north' });                  // facing = opposite of the clicked face, vertical -> down
    else if (LOOK_FACING.test(n)) {
        r = place(item, 'up', lookAt(f));
        const v = VEC[f];
        if (v) { const w = at(v[0], v[1], v[2]); if (w && !S.AIR.has(S.bare(w.name))) { r.deps.push(v); r.soft = [v]; } }     // the cell it watches stands first (no pulse at placement); a preference, not a need (job.js)
    } else if (PISTONLIKE.test(n)) r = place(item, 'up', lookAt(OPP[f]));
    else if (/^(repeater|comparator)$/.test(n)) {
        r = place(item, 'up', { h: OPP[f] }, { deps: [[0, -1, 0]] });
        if (n === 'repeater') r.clicks = (Number(p.delay || 1) - 1) % 4;
        else r.clicks = p.mode === 'subtract' ? 1 : 0;
    } else if (/_trapdoor$/.test(n)) {
        r = place(item, p.half === 'top' ? 'down' : 'up', { h: OPP[f] });
        if (p.open === 'true' && !/^iron_/.test(n)) r.clicks = 1;
    } else if (/_fence_gate$/.test(n)) { r = place(item, 'up', { h: f }); if (p.open === 'true') { r.clicks = 1; r.clickLook = { h: f }; } }
    else if (/_stairs$/.test(n)) r = place(item, p.half === 'top' ? 'down' : 'up', { h: f });
    else if (/_slab$/.test(n)) {
        if (p.type === 'double') { r = place(item, 'up', { h: 'north' }); r.again = { face: FACE.up }; }
        else r = place(item, p.type === 'top' ? 'down' : 'up', { h: 'north' });
    } else if (/_door$/.test(n)) {
        r = place(item, 'up', { h: f }, { deps: [[0, -1, 0]], room: [[0, 1, 0]] });          // the upper half's cell empty at the click (DoorBlock.getStateForPlacement)
        // hinge: vanilla decides it from the neighbours and the click position; the cursor on the hinge side is a hint, the result is read back
        const side = p.hinge === 'right' ? CW[f] : CCW[f], v = VEC[side];
        r.cursor = [0.5 + v[0] * 0.3, 0.5, 0.5 + v[2] * 0.3];
        if (p.open === 'true' && !/^iron_/.test(n)) r.clicks = 1;
    } else if (CLICK_FACE.test(n)) r = place(item, f || 'up', { h: 'north' });
    else if (WALL_ATTACH.test(n)) r = place(item, 'up', { h: OPP[f] }, { deps: [VEC[OPP[f]]] });
    else if (/^(torch|soul_torch|redstone_torch|copper_torch)$/.test(n)) r = place(item, 'up', { h: 'north', v: 'down' }, { deps: [[0, -1, 0]] });
    else if (FACE_ATTACHED.test(n)) {
        const face = p.face || 'wall';
        if (face === 'floor') r = place(item, 'up', { h: f, v: 'down' }, { deps: [[0, -1, 0]] });
        else if (face === 'ceiling') r = place(item, 'up', { h: f, v: 'up' }, { deps: [[0, 1, 0]] });
        else r = place(item, 'up', { h: OPP[f] }, { deps: [VEC[OPP[f]]] });
        if (n === 'lever' && p.powered === 'true') r.clicks = 1;
    } else if (/^(lantern|soul_lantern|.*_lantern)$/.test(n) && n !== 'jack_o_lantern') r = p.hanging === 'true' ? place(item, 'up', { h: 'north', v: 'up' }, { deps: [[0, 1, 0]] }) : place(item, 'up', { h: 'north', v: 'down' }, { deps: [[0, -1, 0]] });
    else if (/^(rail|powered_rail|detector_rail|activator_rail)$/.test(n)) {
        const sh = p.shape || 'north_south';
        r = place(item, 'up', { h: /east|west/.test(sh) && !/north|south/.test(sh) ? 'east' : 'north' }, { deps: [[0, -1, 0]] });
    } else if (HOR_OPP.test(n)) r = place(item, 'up', { h: OPP[f] || 'north' });
    else if (HOR_SAME.test(n)) r = place(item, 'up', { h: /anvil/.test(n) ? CCW[f] : f || 'north' });
    else if (CLICK_AXIS.test(n) && p.axis) r = place(item, p.axis === 'y' ? 'up' : p.axis === 'x' ? 'east' : 'south', { h: 'north' });
    else if (n === 'note_block') { r = place(item, 'up', { h: 'north' }, { deps: [[0, -1, 0]] }); r.clicks = Number(p.note || 0) % 25; }
    else if (n === 'daylight_detector') { r = place(item, 'up', { h: 'north' }); if (p.inverted === 'true') r.clicks = 1; }
    else if (/(^|_)candle$/.test(n)) { r = place(item, 'up', { h: 'north' }, { deps: [[0, -1, 0]] }); r.repeat = Number(p.candles || 1) - 1; }
    else if (n === 'sea_pickle') { r = place(item, 'up', { h: 'north' }, { deps: [[0, -1, 0]] }); r.repeat = Number(p.pickles || 1) - 1; }
    else if (n === 'snow') { r = place(item, 'up', { h: 'north' }, { deps: [[0, -1, 0]] }); r.repeat = Number(p.layers || 1) - 1; }
    else if (/_sign$|_banner$/.test(n) && p.rotation !== undefined) r = place(item, 'up', { h: 'north', yaw16: Number(p.rotation) }, { deps: [[0, -1, 0]] });
    else r = place(item, 'up', { h: 'north' });
    if (FLOOR.test(n) && !r.deps.some((d) => d[0] === 0 && d[1] === -1 && d[2] === 0) && !(p.face === 'wall' || p.face === 'ceiling' || p.hanging === 'true')) r.deps.push([0, -1, 0]);
    if (GRAVITY.test(n)) r.deps.push([0, -1, 0]);
    if (n === 'note_block' && !r.deps.length) r.deps.push([0, -1, 0]);
    // keep only the dependencies on cells that hold something
    r.deps = r.deps.filter((d) => { const w = at(d[0], d[1], d[2]); return w && !S.AIR.has(S.bare(w.name)) && S.bare(w.name) !== 'piston_head'; });
    if (p.waterlogged === 'true') r.waterlog = true;
    return r;
}

module.exports = { FACE, VEC, OPP, CW, CCW, HORIZ, YAW, lookAngles, lookAt, recipe, FLOOR, GRAVITY };
