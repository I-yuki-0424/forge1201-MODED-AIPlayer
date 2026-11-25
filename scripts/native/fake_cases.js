'use strict';
// The movement cases recorded on the server with a carpet fake player (TASK-20261125-076). Each: blocks around the origin (relative cells; everything
// else in the arena is air), the start (feet cell, vanilla yaw: 0 south, 90 west, 180 north, 270 east; pitch), and the keys per tick (a change at tick t
// holds until the next). Keys as the trace rows write them: F B L R J S N (forward back left right jump sprint sneak), '.' = up.
const K = (s) => s;          // 7 characters
const floor = (r = 6, y = -1, name = 'stone') => [[-r, y, -r, r, y, r, name]];

const CASES = [
    { name: 'walk_east', start: [0, 0, 0, 270, 0], blocks: floor(), program: [[0, K('F......')], [30, K('.......')]], ticks: 45 },
    { name: 'sprint_jump_south', start: [0, 0, -5, 0, 0], blocks: floor(8), program: [[0, K('F....S.')], [10, K('F...JS.')], [40, K('.......')]], ticks: 55 },
    { name: 'sneak_edge_north', start: [0, 0, 0, 180, 0], blocks: [[-2, -1, -2, 2, -1, 2, 'stone']], program: [[0, K('F.....N')], [50, K('.......')]], ticks: 55 },
    { name: 'step_slab_west', start: [3, 0, 0, 90, 0], blocks: [...floor(), [-1, 0, -1, -1, 0, 1, 'oak_slab[type=bottom]'], [-3, 0, -1, -2, 0, 1, 'oak_slab[type=bottom]']], program: [[0, K('F......')], [30, K('.......')]], ticks: 40 },
    { name: 'stairs_north', start: [0, 0, 2, 180, 0], blocks: [...floor(), [-1, 0, 0, 1, 0, 0, 'stone_stairs[facing=north,half=bottom,shape=straight]'], [-1, 0, -1, 1, 0, -1, 'stone'], [-1, 1, -2, 1, 1, -2, 'stone_stairs[facing=north,half=bottom,shape=straight]']], program: [[0, K('F......')], [35, K('.......')]], ticks: 45 },
    { name: 'ladder_up', start: [0, 0, 0, 180, 0], blocks: [...floor(), [0, 0, -1, 0, 8, -1, 'stone'], [0, 0, 0, 0, 8, 0, 'ladder[facing=south]']], program: [[0, K('F......')], [40, K('......N')], [55, K('.......')]], ticks: 70 },
    { name: 'water_swim_up', start: [0, 0, 0, 180, 0], blocks: [...floor(), [-2, 0, -2, 2, 5, 2, 'water']], program: [[0, K('....J..')], [25, K('.......')]], ticks: 50 },
    { name: 'ice_slide_east', start: [-4, 0, 0, 270, 0], blocks: floor(8, -1, 'packed_ice'), program: [[0, K('F......')], [20, K('.......')]], ticks: 50 },
    { name: 'soul_sand_west', start: [4, 0, 0, 90, 0], blocks: floor(8, -1, 'soul_sand'), program: [[0, K('F......')], [30, K('.......')]], ticks: 40 },
    { name: 'honey_jump', start: [0, 0, 0, 0, 0], blocks: floor(4, -1, 'honey_block'), program: [[0, K('....J..')], [20, K('.......')]], ticks: 30 },
    { name: 'slime_drop', start: [0, 6, 0, 0, 0], blocks: floor(4, -1, 'slime_block'), program: [[0, K('.......')]], ticks: 45 },
    { name: 'cobweb_fall', start: [0, 5, 0, 0, 0], blocks: [...floor(), [0, 0, 0, 0, 3, 0, 'cobweb']], program: [[0, K('.......')]], ticks: 45 },
    // starts one above the snow on a barrier (taken away at tick 0): a body without leather boots sinks into powder snow, so it cannot stand on it at rest
    { name: 'powder_snow_sink', start: [0, 2, 0, 0, 0], blocks: [...floor(6, -3), [-1, -2, -1, 1, 0, 1, 'powder_snow']], program: [[0, K('.......')]], ticks: 50 },
    { name: 'scaffold_climb', start: [0, 0, 0, 0, 0], blocks: [...floor(), [0, 0, 0, 0, 5, 0, 'scaffolding[distance=0,bottom=false]']], program: [[0, K('....J..')], [30, K('.......')]], ticks: 45 },
    { name: 'bubble_up', start: [0, 0, 0, 0, 0], blocks: [[-3, -2, -3, 3, -2, 3, 'stone'], [0, -1, 0, 0, -1, 0, 'soul_sand'], [-1, -1, -1, 1, -1, -1, 'stone'], [-1, -1, 1, 1, -1, 1, 'stone'], [-1, -1, 0, -1, -1, 0, 'stone'], [1, -1, 0, 1, -1, 0, 'stone'],
        [0, 0, 0, 0, 7, 0, 'bubble_column[drag=false]'], [-1, 0, -1, 1, 7, -1, 'glass'], [-1, 0, 1, 1, 7, 1, 'glass'], [-1, 0, 0, -1, 7, 0, 'glass'], [1, 0, 0, 1, 7, 0, 'glass']], program: [[0, K('.......')]], ticks: 40 },
    { name: 'crouch_gap_north', start: [0, 0, 2, 180, 0], blocks: [...floor(), [-2, 1, -3, 2, 1, -1, 'oak_slab[type=top]']], program: [[0, K('F.....N')], [60, K('.......')]], ticks: 65 },
];

/** carpet /player actions for a change of keys from `a` to `b` (strings 'FBLRJSN'). */
function actions(a, b) {
    const has = (s, c) => s.includes(c), out = [];
    const mv = (s) => (has(s, 'F') ? 'forward' : has(s, 'B') ? 'backward' : has(s, 'L') ? 'left' : has(s, 'R') ? 'right' : null);
    if (has(a, 'J') && !has(b, 'J')) out.push('stop');                                     // stop ends the continuous jump (and the movement: set again below)
    if (mv(b) !== mv(a) || out.includes('stop')) out.push(mv(b) ? `move ${mv(b)}` : 'move');
    if (has(b, 'N') !== has(a, 'N')) out.push(has(b, 'N') ? 'sneak' : 'unsneak');
    if (has(b, 'S') !== has(a, 'S')) out.push(has(b, 'S') ? 'sprint' : 'unsprint');
    if (has(b, 'J') && !has(a, 'J')) out.push('jump continuous');
    return out;
}

module.exports = { CASES, actions };
