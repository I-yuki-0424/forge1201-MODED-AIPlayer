'use strict';
// Placement orientation as a search (owner 2026-11-17: "implement it systematically", RL is not to learn this). A block's state after placement is a function of
//   the clicked face (the face of the support block the click lands on), the height of the click on that face (0..1), the way the player looks (yaw, pitch)
// and nothing else; the server takes the face and the click point from the packet and the look from the last look packet, so a bot can choose all of them.
// `model(name, ctx, solid)` is that function for the block families of vanilla (the rules of each Block.getStateForPlacement, 26.1), `recipes(name, props, solid)`
// enumerates contexts and keeps those whose result equals the wanted state. Nothing here touches a bot or a server.
//
// Direction names are the game's: north -z, south +z, west -x, east +x, up +y, down -y. `yRot` is the vanilla yaw in degrees (0 = looking south, 90 = west, 180 = north, 270 = east).
const DIR = { north: [0, 0, -1], south: [0, 0, 1], west: [-1, 0, 0], east: [1, 0, 0], up: [0, 1, 0], down: [0, -1, 0] };
const OPP = { north: 'south', south: 'north', west: 'east', east: 'west', up: 'down', down: 'up' };
const HORIZ = ['north', 'east', 'south', 'west'];
const YROT = { south: 0, west: 90, north: 180, east: 270 };
const bare = (n) => String(n).replace(/^minecraft:/, '');
const horizontal = (d) => d !== 'up' && d !== 'down';
const dirOfYRot = (y) => ['south', 'west', 'north', 'east'][((Math.floor(y / 90 + 0.5) % 4) + 4) % 4];
const vec = (d) => DIR[d];
const add = (p, d) => ({ x: p.x + DIR[d][0], y: p.y + DIR[d][1], z: p.z + DIR[d][2] });
/** Mineflayer yaw/pitch (radians) of a recipe's look: yaw 0 looks north and grows counter-clockwise, pitch > 0 looks up. */
const lookOf = (r) => ({ yaw: ((180 - r.yRot) * Math.PI) / 180, pitch: r.pitch === 'up' ? Math.PI / 2 : r.pitch === 'down' ? -Math.PI / 2 : 0 });

// ---------------------------------------------------------------------------------------------------------------- families

const FAMILY = [
    [/(^|_)stairs$/, 'stairs'], [/_slab$/, 'slab'], [/_trapdoor$/, 'trapdoor'], [/^(repeater|comparator)$/, 'diode'], [/^hopper$/, 'hopper'], [/^note_block$/, 'note'],
    [/^(chest|trapped_chest)$/, 'chest'], [/^(piston|sticky_piston|dispenser|dropper|barrel)$/, 'nearest'], [/^observer$/, 'observer'], [/^(furnace|blast_furnace|smoker|loom|stonecutter|lectern|anvil|chipped_anvil|damaged_anvil|grindstone_floor|carved_pumpkin|jack_o_lantern|ender_chest|bell_floor)$/, 'facing_opposite'],
    [/_fence_gate$/, 'gate'], [/_bed$/, 'bed'], [/_door$/, 'door'], [/^(torch|soul_torch|redstone_torch)$/, 'torch'], [/^(wall_torch|soul_wall_torch|redstone_wall_torch)$/, 'wall_torch'],
    [/_sign$/, 'sign'], [/_wall_sign$/, 'wall_sign'], [/^redstone_wire$/, 'wire'], [/^(ladder)$/, 'ladder'],
    [/(_log|_wood|_stem|_hyphae|basalt|bone_block|hay_block|chain|_pillar|purpur_pillar|quartz_pillar)$/, 'pillar'],
];
const SIGN_STANDING = /_sign$/ , SIGN_WALL = /_wall_sign$/;
function family(name) {
    const n = bare(name);
    if (SIGN_WALL.test(n)) return 'wall_sign';
    for (const [re, f] of FAMILY) if (re.test(n)) return f;
    return 'plain';
}

/** Items that never exist as a placement result of their own: the other half of a bed or door, a piston arm. Skipped by the planner. */
function derivedCell(name, props) {
    const n = bare(name);
    if (/_bed$/.test(n)) return props.part === 'head';
    if (/_door$/.test(n)) return props.half === 'upper';
    if (/^(piston_head|moving_piston)$/.test(n)) return true;
    if (/^(tall_grass|large_fern|sunflower|lilac|rose_bush|peony|tall_seagrass)$/.test(n)) return props.half === 'upper';
    return false;
}

/**
 * The properties placement decides for a block, per family (what a recipe must reproduce) and the ones fixed afterwards by using the block
 * (`use`: right-click until it matches). Everything else a state carries is derived by the game from its neighbours or from power and is not compared.
 */
const STATIC = {
    stairs: ['facing', 'half'], slab: ['type'], trapdoor: ['facing', 'half'], diode: ['facing'], hopper: ['facing'], chest: ['facing'], nearest: ['facing'], observer: ['facing'], facing_opposite: ['facing'],
    gate: ['facing'], bed: ['facing'], door: ['facing'], wall_torch: ['facing'], wall_sign: ['facing'], sign: ['rotation'], ladder: ['facing'], pillar: ['axis'],
};
const USE = { trapdoor: ['open'], gate: ['open'], door: ['open'], diode: ['delay', 'mode'], note: ['note'] };      // right-click until it matches: a repeater steps its delay, a comparator toggles its mode, a note block steps its note (0..24)
const staticProps = (name, props) => Object.fromEntries((STATIC[family(name)] || []).filter((k) => k in (props || {})).map((k) => [k, String(props[k])]));
const useProps = (name, props) => Object.fromEntries((USE[family(name)] || []).filter((k) => k in (props || {})).map((k) => [k, String(props[k])]));

// ---------------------------------------------------------------------------------------------------------------- the forward model

/**
 * What placing `name` gives for the context ctx = { clicked, hy, yRot, pitch }. `solid(d)`: is the block next to the target cell in direction d a full,
 * sturdy block (a torch or sign attaches to it, a repeater stands on it)? Returns { name, props } (only the properties placement decides) or null when the
 * game would refuse or when the result depends on something the context does not fix.
 */
function model(name, ctx, solid = () => true) {
    const fam = family(name), n = bare(name), { clicked, hy, pitch } = ctx, facing = dirOfYRot(ctx.yRot), look = pitch === 'up' ? 'up' : pitch === 'down' ? 'down' : facing;
    const top = (clicked === 'down') || (horizontal(clicked) && hy > 0.5);
    switch (fam) {
        case 'plain': case 'note': return { name: n, props: {} };
        case 'stairs': return { name: n, props: { facing, half: top ? 'top' : 'bottom' } };
        case 'slab': return { name: n, props: { type: clicked === 'up' ? 'bottom' : clicked === 'down' ? 'top' : top ? 'top' : 'bottom' } };
        case 'trapdoor': return horizontal(clicked)
            ? { name: n, props: { facing: clicked, half: hy > 0.5 ? 'top' : 'bottom' } }
            : { name: n, props: { facing: OPP[facing], half: clicked === 'up' ? 'bottom' : 'top' } };
        case 'diode': return clicked === 'up' && solid('down') ? { name: n, props: { facing: OPP[facing] } } : null;
        case 'hopper': return { name: n, props: { facing: horizontal(clicked) ? OPP[clicked] : 'down' } };
        case 'chest': return { name: n, props: { facing: OPP[facing] } };
        case 'nearest': return { name: n, props: { facing: OPP[look] } };
        case 'observer': return { name: n, props: { facing: look } };                // measured on 26.1.2 (scripts/t26/orient_probe.js, 2026-11-21): an observer faces the way the player looks, unlike a piston or a dropper
        case 'facing_opposite': return { name: n, props: { facing: OPP[facing] } };
        case 'gate': return { name: n, props: { facing } };
        case 'door': return clicked === 'down' ? null : { name: n, props: { facing } };
        case 'bed': return { name: n, props: { facing } };
        case 'pillar': return { name: n, props: { axis: clicked === 'up' || clicked === 'down' ? 'y' : clicked === 'east' || clicked === 'west' ? 'x' : 'z' } };
        case 'ladder': return horizontal(clicked) ? { name: n, props: { facing: clicked } } : null;
        case 'wire': return clicked === 'up' && solid('down') ? { name: n, props: {} } : null;
        case 'torch': case 'sign': {
            // Measured on 26.1.2 (sign_probe, 2026-11-17): a click on the TOP of a block gives the standing block whatever the look; a click on a SIDE face gives the wall block, attached to the
            // clicked block (facing = the face clicked). The recipe also looks toward the wall (the older rule of the nearest-looking directions), so that both rules agree.
            const wall = fam === 'torch' ? n.replace(/torch$/, 'wall_torch') : n.replace(/_sign$/, '_wall_sign').replace(/^(.*)_hanging_wall_sign$/, '$1_wall_hanging_sign');
            if (clicked === 'down') return null;
            if (clicked === 'up') return pitch === 'down' && solid('down') ? { name: n, props: fam === 'sign' ? { rotation: String(Math.floor(((180 + ctx.yRot) * 16) / 360 + 0.5) & 15) } : {} } : null;
            return pitch === 'level' && facing === OPP[clicked] && solid(OPP[clicked]) ? { name: wall, props: { facing: clicked } } : null;
        }
        default: return null;
    }
}

/** The family of the BLOCK a torch or sign item places, for the planner: `wall_torch` and `wall_sign` come from the torch / sign item. */
const itemFamilyOf = (blockName) => { const f = family(blockName); return f === 'wall_torch' ? 'torch' : f === 'wall_sign' ? 'sign' : f; };
const itemOf = (blockName) => bare(blockName).replace(/_wall_(sign|banner|head|hanging_sign)$/, '_$1').replace(/^(.*)_wall_torch$/, '$1_torch').replace(/^wall_torch$/, 'torch').replace('redstone_wire', 'redstone');

const eq = (have, want) => Object.entries(want).every(([k, v]) => String(have[k]) === String(v));

/**
 * Every context that places the wanted state, best first. `solid(d)` as in model(). A recipe is
 *   { clicked, hy, yRot, pitch, sneak:false, support: direction FROM the target cell TO the clicked block, face: protocol face index of the clicked face, name, props }.
 * Preference: a click from above on the support below (the natural one), then the side faces, the bottom last; a level look before a vertical one.
 */
function recipes(name, props, solid = () => true) {
    const want = staticProps(name, props), fam = itemFamilyOf(name), out = [];
    const faceIndex = { down: 0, up: 1, north: 2, south: 3, west: 4, east: 5 };
    const yRots = fam === 'sign' && 'rotation' in (props || {}) && !/wall/.test(bare(name)) ? Array.from({ length: 16 }, (_, k) => ((k * 22.5 - 180) % 360 + 360) % 360) : HORIZ.map((d) => YROT[d]);
    for (const clicked of ['up', 'north', 'south', 'east', 'west', 'down']) for (const hy of [0.25, 0.75]) for (const pitch of ['level', 'down', 'up']) for (const yRot of yRots) {
        if (!horizontal(clicked) && hy !== 0.25) continue;                       // the height of the click matters on side faces only
        if ((fam === 'plain' || fam === 'note') && (hy !== 0.25 || pitch !== 'level' || yRot !== 0)) continue;     // nothing depends on the look: one recipe per clicked face
        const ctx = { clicked, hy, yRot, pitch }, r = model(fam === 'torch' || fam === 'sign' ? itemOf(name) : name, ctx, solid);
        if (!r || r.name !== bare(name) || !eq(r.props, want)) continue;
        out.push({ ...ctx, sneak: false, support: OPP[clicked], face: faceIndex[clicked], name: r.name, props: r.props });
    }
    const rank = (r) => ({ up: 0, north: 1, south: 1, east: 1, west: 1, down: 2 }[r.clicked] * 10 + (r.pitch === 'level' ? 0 : 1) + (r.hy > 0.5 ? 0.5 : 0));
    return out.sort((a, b) => rank(a) - rank(b));
}

module.exports = { DIR, OPP, HORIZ, family, itemFamilyOf, itemOf, derivedCell, staticProps, useProps, model, recipes, lookOf, add, vec, dirOfYRot, STATIC, USE };
