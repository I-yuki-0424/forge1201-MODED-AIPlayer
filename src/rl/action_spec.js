'use strict';
// Closed action space of the RL environment, in the data-defined form of the DPOD file API (v1).
// Mirrors DPOD `integrations/botsystem/action_spec.py` (`proposal_full`, `proposal_min`); the `hello` handshake compares
// `spec_hash` with DPOD's, so any drift between the two implementations is refused at run time, not discovered later.
const crypto = require('crypto');

const KEY_MODES = ['off', 'tap', 'hold'];
// Component names the controls layer can apply (src/rl/controls.js). Anything else is refused at start-up.
const KNOWN = new Set(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak', 'attack', 'use',
    'yaw_delta_deg', 'pitch_delta_deg', 'hotbar']);

const key = (name, modes = KEY_MODES) => ({ kind: 'key', name, modes });
const MOVE_RULES = [
    { kind: 'exclusive', a: 'forward', b: 'back' }, { kind: 'exclusive', a: 'left', b: 'right' },
    { kind: 'requires', a: 'sprint', b: 'forward' }, { kind: 'exclusive', a: 'sprint', b: 'sneak' },
];

function full(ticksPerStep = 4) {
    return {
        name: 'botsystem_full', version: 0, ticks_per_step: ticksPerStep,
        components: [
            ...['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak', 'attack', 'use'].map((n) => key(n)),
            { kind: 'axis', name: 'yaw_delta_deg', values: [-45, -15, 0, 15, 45] },
            { kind: 'axis', name: 'pitch_delta_deg', values: [-15, 0, 15] },
            { kind: 'select', name: 'hotbar', n: 10 },
        ],
        rules: MOVE_RULES,
    };
}

function min(ticksPerStep = 4) {
    return {
        name: 'botsystem_min', version: 0, ticks_per_step: ticksPerStep,
        components: [key('forward'), key('jump'), key('sprint', ['off', 'hold']), key('attack', ['off', 'hold']),
            { kind: 'axis', name: 'yaw_delta_deg', values: [-30, 0, 30] }],
        rules: [{ kind: 'requires', a: 'sprint', b: 'forward' }],
    };
}

const SPECS = { full, min };

/** Python's `%.6g` for the finite values used here (no exponent form: |v| in [1e-4, 1e6)). */
const g6 = (v) => String(parseFloat(Number(v).toPrecision(6)));

function sortKeys(x) {
    if (Array.isArray(x)) return x.map(sortKeys);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map((k) => [k, sortKeys(x[k])]));
    return x;
}

/** sha256 of the compact, key-sorted JSON with axis values as `%.6g` strings (same canonical form as DPOD). */
function specHash(spec) {
    const w = JSON.parse(JSON.stringify(spec));
    for (const c of w.components) if (c.kind === 'axis') c.values = c.values.map(g6);
    return crypto.createHash('sha256').update(JSON.stringify(sortKeys(w))).digest('hex');
}

function checkSpec(spec) {
    if (!(spec.ticks_per_step >= 1)) throw new Error('ticks_per_step must be >= 1');
    for (const c of spec.components) {
        if (!KNOWN.has(c.name)) throw new Error(`unknown action component ${c.name}`);
        if (c.kind === 'key' && c.modes.includes('tap') && spec.ticks_per_step === 1) throw new Error(`${c.name}: tap == hold at 1 tick`);
    }
    return spec;
}

const domain = (c) => (c.kind === 'key' ? c.modes : c.kind === 'axis' ? c.values : Array.from({ length: c.n }, (_, i) => i));

/** Throws unless `action` has exactly the spec's components, each inside its domain, and breaks no rule. */
function validate(spec, action) {
    const names = spec.components.map((c) => c.name);
    const got = Object.keys(action);
    if (got.length !== names.length || !names.every((n) => n in action)) throw new Error(`action keys ${got} != ${names}`);
    for (const c of spec.components) {
        if (!domain(c).includes(action[c.name])) throw new Error(`${c.name}=${JSON.stringify(action[c.name])} outside its domain`);
    }
    for (const r of spec.rules) {
        const a = action[r.a] !== 'off', b = action[r.b] !== 'off';
        if ((r.kind === 'exclusive' && a && b) || (r.kind === 'requires' && a && !b)) throw new Error(`rule ${r.kind}(${r.a},${r.b}) violated`);
    }
}

/** Per tick, which keys are down: `off` never, `tap` on tick 0 only, `hold` on every tick. */
function keySchedule(spec, action) {
    const keys = spec.components.filter((c) => c.kind === 'key').map((c) => c.name);
    const down = { off: () => false, tap: (t) => t === 0, hold: () => true };
    return Array.from({ length: spec.ticks_per_step }, (_, t) => Object.fromEntries(keys.map((k) => [k, down[action[k]](t)])));
}

module.exports = { SPECS, specHash, checkSpec, validate, keySchedule, g6 };
