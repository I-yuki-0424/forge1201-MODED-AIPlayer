'use strict';
// RL-MOVE-v3, the contract with the trainer (rl3/): cell codes, observation layout, actions. Changing any number here means retraining (rl3/obs.py, rl3/sim.py say the same).
const CODE = Object.freeze({ AIR: 0, SOLID: 1, WATER: 2, LAVA: 3, OWN: 4, OTHER: 5, ROCK: 6, PART: 7 });
const DIRS = Object.freeze([[0, -1], [1, 0], [0, 1], [-1, 0]]);                       // N E S W as [dx, dz]
const ACTIONS = Object.freeze(['walk_n', 'walk_e', 'walk_s', 'walk_w', 'bridge_n', 'bridge_e', 'bridge_s', 'bridge_w', 'dig_n', 'dig_e', 'dig_s', 'dig_w',
    'pillar', 'descend', 'dig_up', 'dig_down', 'unlay', 'wait', 'sidestep']);
const A = Object.freeze({ WALK: 0, BRIDGE: 4, DIG: 8, PILLAR: 12, DESCEND: 13, DIGUP: 14, DIGDOWN: 15, UNLAY: 16, WAIT: 17, SIDESTEP: 18 });
const NA = ACTIONS.length;
const PR = Object.freeze([4, 3, 4]), PATCH = Object.freeze([9, 7, 9]), NCH = 5;
const RAY_DIRS = Object.freeze([[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]);
const RAY_LEN = 12, NVEC = 48, HORIZON = 240, MAX_HP = 20, PACK_CAP = 64, MAX_BOTS = 6;
const OBS_PATCH = NCH * PATCH[0] * PATCH[1] * PATCH[2], OBS_VIS = PATCH[0] * PATCH[2], OBS_DIM = OBS_PATCH + OBS_VIS + NVEC;
module.exports = { CODE, DIRS, ACTIONS, A, NA, PR, PATCH, NCH, RAY_DIRS, RAY_LEN, NVEC, HORIZON, MAX_HP, PACK_CAP, MAX_BOTS, OBS_PATCH, OBS_VIS, OBS_DIM };
