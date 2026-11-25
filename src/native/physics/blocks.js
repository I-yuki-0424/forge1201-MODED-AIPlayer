'use strict';
// What the player movement needs to know about a block (TASK-20261125-076): its collision boxes (including the ones that depend on who asks: scaffolding,
// powder snow), its fluid, friction, speed and jump factors, climbability, and the reactions of slime, beds, honey, cobwebs, berry bushes and bubble columns.
// Read from the block's name and properties (prismarine-block: `name`, `shapes`, `getProperties()`), so mod blocks get the vanilla behaviour of their shape
// and nothing else. The tables are the vanilla 1.20-1.21 values (Block.Properties of each block).

const FRICTION = { ice: 0.98, packed_ice: 0.98, frosted_ice: 0.98, blue_ice: 0.989, slime_block: 0.8 };
const SPEED = { soul_sand: 0.4, honey_block: 0.4 };
const JUMP = { honey_block: 0.5 };
// BlockTags.CLIMBABLE (1.21.1)
const CLIMBABLE = new Set(['ladder', 'vine', 'scaffolding', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant', 'cave_vines', 'cave_vines_plant']);
const WATER_PLANTS = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant']);          // always hold a water source
const AIR = new Set(['air', 'cave_air', 'void_air']);
const FULL = [[0, 0, 0, 1, 1, 1]];
const SCAFFOLD_BOTTOM = [[0, 0, 0, 1, 0.125, 1]];                                          // UNSTABLE_SHAPE_BOTTOM (0..2/16)
const POWDER_FALLING = [[0, 0, 0, 1, Math.fround(0.9), 1]];
const ABOVE_EPS = Math.fround(1e-5);

const bare = (name) => String(name || '').replace(/^minecraft:/, '');
const num = (v, d = 0) => (v === undefined ? d : Number(v));
const bool = (v) => v === true || v === 'true';

/** The static facts of one block state (cached by the caller per state). */
function describe(block) {
    const name = bare(block.name), props = typeof block.getProperties === 'function' ? block.getProperties() : (block._properties || {});
    const shapes = Array.isArray(block.shapes) ? block.shapes : [];
    let fluid = null;
    if (name === 'water' || name === 'lava') {
        const lvl = num(props.level, 0);
        fluid = { type: name, amount: lvl === 0 || lvl >= 8 ? 8 : 8 - lvl, falling: lvl >= 8 };
    } else if (name === 'bubble_column' || WATER_PLANTS.has(name) || bool(props.waterlogged)) fluid = { type: 'water', amount: 8, falling: false };
    return {
        name, props, shapes, fluid,
        air: AIR.has(name),
        friction: FRICTION[name] ?? 0.6,
        speedFactor: SPEED[name] ?? 1,
        jumpFactor: JUMP[name] ?? 1,
        climbable: CLIMBABLE.has(name),
        trapdoor: /_trapdoor$/.test(name),
        ladder: name === 'ladder',
        // getOnPos keeps the supporting cell itself for these (a fence is 1.5 high: the block "under" a body on it is the fence, not the cell below)
        fenceLike: /_fence$/.test(name) || /_wall$/.test(name) || /_fence_gate$/.test(name),
        bed: /_bed$/.test(name),
        slime: name === 'slime_block',
        honey: name === 'honey_block',
        cobweb: name === 'cobweb',
        berryBush: name === 'sweet_berry_bush',
        powderSnow: name === 'powder_snow',
        scaffolding: name === 'scaffolding',
        bubble: name === 'bubble_column' ? { down: bool(props.drag) } : null,
        // blocksMotion (legacy "solid"): anything with a collision box but a cobweb or a bamboo sapling
        blocksMotion: shapes.length > 0 && name !== 'cobweb' && name !== 'bamboo_sapling',
        fullCube: shapes.length === 1 && shapes[0].every((v, i) => v === FULL[0][i]),
    };
}

/**
 * A view of the world for one simulated tick: block lookups cached per cell, block facts cached per state for the life of the view's owner.
 * `world.getBlock(Vec3)` is prismarine's interface (mineflayer's bot world, the tests' fakes); null means an unloaded cell.
 */
class View {
    constructor(facts) { this.facts = facts || new Map(); this.world = null; this.cells = new Map(); this.p = null; }
    reset(world) {
        this.world = world; this.cells.clear();
        if (!this.p) { const V = require('vec3'); this.p = new V.Vec3(0, 0, 0); }
    }
    /** The facts of the cell, or null when its chunk is not loaded. */
    at(x, y, z) {
        const k = `${x},${y},${z}`;
        if (this.cells.has(k)) return this.cells.get(k);
        this.p.x = x; this.p.y = y; this.p.z = z;
        const b = this.world.getBlock(this.p);
        let d = null;
        if (b) {
            const sk = b.stateId !== undefined ? b.stateId : `${b.type}:${b.metadata}`;
            d = this.facts.get(sk);
            if (!d) { d = describe(b); this.facts.set(sk, d); }
        }
        this.cells.set(k, d);
        return d;
    }
    fluid(x, y, z) { const d = this.at(x, y, z); return d ? d.fluid : null; }
    /**
     * Collision boxes of a cell as the entity sees them (EntityCollisionContext): `who` = { y (feet before the move), descending (sneak key), fallDistance, walksOnPowderSnow }.
     */
    shapes(x, y, z, who) {
        const d = this.at(x, y, z);
        if (!d) return null;
        if (d.scaffolding) {
            if (who.y > y + 1 - ABOVE_EPS && !who.descending) return d.shapes;                      // STABLE_SHAPE (the data's shape)
            return num(d.props.distance, 0) !== 0 && bool(d.props.bottom) && who.y > y - ABOVE_EPS ? SCAFFOLD_BOTTOM : [];
        }
        if (d.powderSnow) {
            if (who.fallDistance > 2.5) return POWDER_FALLING;
            return who.walksOnPowderSnow && who.y > y + 1 - ABOVE_EPS && !who.descending ? FULL : [];
        }
        return d.shapes;
    }
}

module.exports = { View, describe, FRICTION, SPEED, JUMP, CLIMBABLE };
