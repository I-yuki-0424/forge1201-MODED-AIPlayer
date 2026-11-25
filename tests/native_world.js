'use strict';
// A small block world for the native physics and inventory tests (TASK-20261125-076): real block states of a version (prismarine-block), placed by name.
const Vec3 = require('vec3');

function world(version = '1.21.1') {
    const registry = require('prismarine-registry')(version);
    const Block = require('prismarine-block')(registry);
    const cells = new Map(), cache = new Map();
    const stateOf = (name, props = {}) => {
        const k = `${name}${JSON.stringify(props)}`;
        if (cache.has(k)) return cache.get(k);
        const b = registry.blocksByName[name];
        if (!b) throw new Error(`no block ${name} in ${version}`);
        let sid = b.defaultState;
        if (Object.keys(props).length) {
            // the properties not named keep their default (a ladder asked for by facing alone is not waterlogged)
            const want = Object.entries({ ...Block.fromStateId(b.defaultState, 0).getProperties(), ...props }).map(([p, v]) => [p, String(v)]);
            for (let id = b.minStateId; id <= b.maxStateId; id++) {
                const got = Block.fromStateId(id, 0).getProperties();
                if (want.every(([p, v]) => String(got[p]) === v)) { sid = id; break; }
                if (id === b.maxStateId) throw new Error(`no state ${k}`);
            }
        }
        cache.set(k, sid);
        return sid;
    };
    const w = {
        registry, Block,
        set(x, y, z, name, props) { cells.set(`${x},${y},${z}`, stateOf(name, props)); return w; },
        fill(x0, y0, z0, x1, y1, z1, name, props) { for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) w.set(x, y, z, name, props); return w; },
        floor(y = 0, name = 'stone', r = 40) { return w.fill(-r, y, -r, r, y, r, name); },
        getBlock(p) {
            const x = Math.floor(p.x), y = Math.floor(p.y), z = Math.floor(p.z);
            const b = Block.fromStateId(cells.get(`${x},${y},${z}`) ?? stateOf('air'), 0);
            b.position = new Vec3(x, y, z);
            return b;
        },
    };
    return w;
}

module.exports = { world };
