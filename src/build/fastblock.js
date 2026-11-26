'use strict';
// Block reads by state id (TASK-079's profile of the build harness, SPEED-v1 section 7: 23 % of the busy CPU was prismarine-world `getBlock` building a new Block and a new Biome
// object for every cell the planner, the claim and the click search read). A cell's state id comes straight from the chunk section; the Block for a state id is built once per
// registry and shared (name, properties, collision boxes, material, dig time: nothing of it depends on the position). Callers must not change what they get.
const tables = new WeakMap();          // registry -> Map(stateId -> { block, seen, place })

function table(bot) {
    let t = tables.get(bot.registry);
    if (!t) { t = { Block: require('prismarine-block')(bot.registry), m: new Map() }; tables.set(bot.registry, t); }
    return t;
}

/** The state id at a cell, or null when its chunk is not loaded. */
function stateId(bot, x, y, z) {
    const w = bot.world; if (!w || !w.getColumnAt) return undefined;
    const col = w.getColumnAt({ x, z }); if (!col) return null;
    return col.getBlockStateId({ x: x & 15, y, z: z & 15 });
}

/** The entry of a state id: { block (a shared prismarine Block), seen ({name, props (strings), shape}), place ({name, props, shapes}) }. */
function entry(bot, id) {
    const t = table(bot);
    let e = t.m.get(id);
    if (!e) {
        const b = t.Block.fromStateId(id, 0), props = {};
        for (const [k, v] of Object.entries(b.getProperties())) props[k] = String(v);
        Object.freeze(props);
        const air = b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
        e = { block: b, seen: Object.freeze({ name: b.name === 'cave_air' || b.name === 'void_air' ? b.name : b.name, props, shape: b.boundingBox }), place: air ? null : Object.freeze({ name: b.name, props, shapes: b.shapes || [] }), air };
        t.m.set(id, e);
    }
    return e;
}

/** bot.blockAt(pos, false) without the allocation: a shared Block (no position), or null when not loaded. Falls back to blockAt for a bot without a chunk world (tests). */
function blockAt(bot, x, y, z) {
    const id = stateId(bot, x, y, z);
    if (id === undefined) { const { Vec3 } = require('vec3'); return bot.blockAt(new Vec3(x, y, z), false); }
    if (id === null) return null;
    return entry(bot, id).block;
}

module.exports = { stateId, entry, blockAt };
