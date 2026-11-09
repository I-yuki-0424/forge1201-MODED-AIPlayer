'use strict';
// Simple placement (owner 2026-11-09): one block type laid as a floor, a wall, or the four walls of a room, picked on the map like a pit. The shape is turned into the same
// cell list a structure is, so the build job (build.js) does the rest: bottom-up, one row per unit, scaffold where a bot cannot reach, missing items fetched. Pure.
//
//   floor  the rectangle x0..x1 by z0..z1, ONE layer at y
//   wall   a straight line from (x0, z0) to (x1, z1), `height` layers from y up; it must run along x (z0 = z1) or along z (x0 = x1)
//   room   the four walls around the rectangle x0..x1 by z0..z1, `height` layers from y up (the middle stays open; lay a floor separately)
const MAX_CELLS = 40000, MAX_SIDE = 256, MAX_HEIGHT = 64;
const KINDS = ['floor', 'wall', 'room'];
const BLOCK = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_]{1,64}$/;
const NOT_PLACEABLE = /^(air|cave_air|void_air|water|lava|bedrock|barrier|structure_void|jigsaw|command_block)$/;

class LayoutError extends Error {}
const bad = (m) => { throw new LayoutError(m); };

/**
 * The cells of a layout, relative to the minimum corner, and where that corner is. Throws LayoutError with a sentence for the operator.
 * @param s { kind, block, x0, z0, x1, z1, y, height? }
 * @returns { origin: {x, y, z}, size: [w, h, d], cells: [{x, y, z, block}], count, describe }
 */
function layout(s) {
    if (!s || typeof s !== 'object') bad('layout missing');
    if (!KINDS.includes(s.kind)) bad(`kind: one of ${KINDS.join(', ')}`);
    if (typeof s.block !== 'string' || !BLOCK.test(s.block) || NOT_PLACEABLE.test(s.block.replace(/^minecraft:/, ''))) bad('block: a placeable block such as cobblestone, oak_planks or create:andesite_casing');
    for (const k of ['x0', 'z0', 'x1', 'z1', 'y']) if (!Number.isInteger(s[k]) || Math.abs(s[k]) > 29_999_000) bad(`${k} must be an integer`);
    const height = s.kind === 'floor' ? 1 : s.height === undefined ? 3 : s.height;
    if (!Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) bad(`height: 1..${MAX_HEIGHT}`);
    if (s.y < -64 || s.y + height - 1 > 319) bad('the layers must lie between y -64 and y 319');
    const block = s.block.replace(/^minecraft:/, '');
    let x0 = Math.min(s.x0, s.x1), x1 = Math.max(s.x0, s.x1), z0 = Math.min(s.z0, s.z1), z1 = Math.max(s.z0, s.z1);
    if (s.kind === 'wall' && x0 !== x1 && z0 !== z1) bad('a wall runs straight: along x (z from = z to) or along z (x from = x to). Drag a line on the map, or make one pair of numbers equal.');
    if (x1 - x0 >= MAX_SIDE || z1 - z0 >= MAX_SIDE) bad(`at most ${MAX_SIDE} blocks per side`);
    const flat = new Set();                                         // the footprint: "x,z"
    if (s.kind === 'floor') { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) flat.add(`${x},${z}`); }
    else if (s.kind === 'wall') { for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) flat.add(`${x},${z}`); }
    else {
        if (x1 - x0 < 1 || z1 - z0 < 1) bad('a room needs at least 2 x 2 blocks (for one straight line use a wall)');
        for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) if (x === x0 || x === x1 || z === z0 || z === z1) flat.add(`${x},${z}`);
    }
    const count = flat.size * height;
    if (count > MAX_CELLS) bad(`${count} blocks is too many (at most ${MAX_CELLS}): make it smaller or split it`);
    const cells = [];
    for (const k of flat) { const [x, z] = k.split(',').map(Number); for (let dy = 0; dy < height; dy++) cells.push({ x: x - x0, y: dy, z: z - z0, block }); }
    const w = x1 - x0 + 1, d = z1 - z0 + 1;
    const along = s.kind === 'wall' ? (x0 !== x1 || z0 === z1 ? 'x' : 'z') : null;
    const describe = s.kind === 'floor' ? `a floor of ${w} × ${d} (${count} ${block}) at y ${s.y}, from x ${x0} to ${x1} and z ${z0} to ${z1}`
        : s.kind === 'wall' ? `a wall ${along === 'x' ? w : d} long and ${height} high (${count} ${block}), along ${along} from ${along === 'x' ? `x ${x0} to ${x1} at z ${z0}` : `z ${z0} to ${z1} at x ${x0}`}, y ${s.y} to ${s.y + height - 1}`
            : `the four walls of a ${w} × ${d} room, ${height} high (${count} ${block}), y ${s.y} to ${s.y + height - 1}; the inside stays open`;
    // The footprint as boxes for the map: one rectangle, or the four strips of a room's walls.
    const boxes = s.kind === 'room' ? [{ x0, z0, x1, z1: z0 }, { x0, z0: z1, x1, z1 }, { x0, z0: z0 + 1, x1: x0, z1: z1 - 1 }, { x0: x1, z0: z0 + 1, x1, z1: z1 - 1 }] : [{ x0, z0, x1, z1 }];
    return { origin: { x: x0, y: s.y, z: z0 }, size: [w, height, d], cells, count, describe, block, kind: s.kind, height, boxes, along };
}

module.exports = { layout, LayoutError, KINDS, MAX_CELLS, MAX_HEIGHT };
