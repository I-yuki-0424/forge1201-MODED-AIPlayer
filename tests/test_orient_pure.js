'use strict';
// Placement orientation as a search (src/work/jobs/orient.js): the model of vanilla's getStateForPlacement and the recipes that reproduce a state.
const assert = require('assert');
const O = require('../src/work/jobs/orient');
const solidAll = () => true;
const has = (name, props, pred, solid = solidAll) => { const r = O.recipes(name, props, solid); assert.ok(r.length, `no recipe for ${name} ${JSON.stringify(props)}`); return r.find(pred) || assert.fail(`no matching recipe among ${r.length}`); };

{   // stairs: facing = the way the player looks, half from the click (top face of a block below -> bottom; side click above the middle -> top)
    for (const f of O.HORIZ) for (const half of ['bottom', 'top']) {
        const r = O.recipes('stone_brick_stairs', { facing: f, half, shape: 'straight', waterlogged: 'false' });
        assert.ok(r.length > 0, `${f} ${half}`);
        for (const q of r) assert.deepStrictEqual(O.model('stone_brick_stairs', q), { name: 'stone_brick_stairs', props: { facing: f, half } });
        assert.strictEqual(r[0].clicked === 'up' || half === 'top', true, 'a bottom stair is first clicked from above');
    }
    assert.strictEqual(O.recipes('oak_stairs', { facing: 'north', half: 'top' }).filter((r) => r.clicked === 'down').length > 0, true);
}
{   // trapdoors: on a side face facing = the face; from above/below facing = opposite of the look; half by click height / face
    const t = O.model('birch_trapdoor', { clicked: 'east', hy: 0.75, yRot: 0, pitch: 'level' }); assert.deepStrictEqual(t.props, { facing: 'east', half: 'top' });
    assert.deepStrictEqual(O.model('birch_trapdoor', { clicked: 'up', hy: 0.25, yRot: 180, pitch: 'level' }).props, { facing: 'south', half: 'bottom' });
    assert.deepStrictEqual(O.model('birch_trapdoor', { clicked: 'down', hy: 0.25, yRot: 180, pitch: 'level' }).props, { facing: 'south', half: 'top' });
    for (const f of O.HORIZ) for (const half of ['top', 'bottom']) assert.ok(O.recipes('birch_trapdoor', { facing: f, half, open: 'true', powered: 'false' }).length > 0);
    assert.deepStrictEqual(O.useProps('birch_trapdoor', { facing: 'north', half: 'top', open: 'true' }), { open: 'true' });
}
{   // hopper: faces the block it was clicked on; down for a click on the top or the bottom
    assert.deepStrictEqual(O.model('hopper', { clicked: 'south', hy: 0.25, yRot: 0, pitch: 'level' }).props, { facing: 'north' });
    assert.deepStrictEqual(O.model('hopper', { clicked: 'up', hy: 0.25, yRot: 0, pitch: 'level' }).props, { facing: 'down' });
    const r = has('hopper', { facing: 'west', enabled: 'true' }, () => true); assert.strictEqual(r.clicked, 'east');
}
{   // repeater: only on a block below; facing = opposite of the look
    const r = O.recipes('repeater', { facing: 'north', delay: '4', powered: 'true' }); assert.ok(r.length && r.every((q) => q.clicked === 'up'));
    assert.deepStrictEqual(O.recipes('repeater', { facing: 'north' }, (d) => d !== 'down'), [], 'no solid block below: no recipe');
    assert.deepStrictEqual(O.useProps('repeater', { facing: 'north', delay: '4' }), { delay: '4' });
}
{   // piston faces the player (nearest look reversed): facing up = looking down
    const r = has('piston', { facing: 'up', extended: 'false' }, () => true); assert.strictEqual(r.pitch, 'down');
    assert.deepStrictEqual(O.model('piston', { clicked: 'east', hy: 0.5, yRot: 270, pitch: 'level' }).props, { facing: 'west' });
}
{   // torches and signs (26.1.2, measured): the top of a block gives the standing block, a side face the wall block hung on the clicked block
    const standing = has('torch', {}, () => true); assert.strictEqual(standing.pitch, 'down'); assert.strictEqual(standing.clicked, 'up');
    const wall = O.recipes('wall_torch', { facing: 'east' }, (d) => d === 'west'); assert.ok(wall.length);
    for (const q of wall) { assert.strictEqual(q.clicked, 'east', 'the face clicked is the face the torch looks out of'); assert.strictEqual(O.dirOfYRot(q.yRot), 'west', 'and the player looks at the wall'); assert.strictEqual(q.support, 'west'); }
    assert.deepStrictEqual(O.recipes('wall_torch', { facing: 'east' }, (d) => d === 'east'), [], 'no wall on the west side');
    const rw = O.recipes('redstone_wall_torch', { facing: 'south', lit: 'true' }, (d) => d === 'north'); assert.ok(rw.length); assert.strictEqual(rw[0].name, 'redstone_wall_torch');
    const ws = O.recipes('oak_wall_sign', { facing: 'south', waterlogged: 'false' }, (d) => d === 'north'); assert.ok(ws.length); assert.strictEqual(O.itemOf('oak_wall_sign'), 'oak_sign'); assert.ok(ws.every((q) => q.support === 'north' && q.clicked === 'south'));
    for (let rot = 0; rot < 16; rot++) { const r = O.recipes('oak_sign', { rotation: String(rot) }); assert.ok(r.length, `rotation ${rot}`); assert.strictEqual(O.model('oak_sign', r[0], solidAll).props.rotation, String(rot)); }
}
{   // chest, bed, gate, wire, pillars
    assert.deepStrictEqual(O.model('chest', { clicked: 'up', hy: 0.5, yRot: 0, pitch: 'level' }).props, { facing: 'north' }, 'looking south -> the chest faces north');
    assert.ok(O.recipes('chest', { facing: 'north', type: 'left', waterlogged: 'false' }).length);
    assert.ok(O.recipes('white_bed', { facing: 'east', part: 'foot', occupied: 'false' }).length); assert.ok(O.derivedCell('white_bed', { part: 'head' })); assert.ok(!O.derivedCell('white_bed', { part: 'foot' }));
    assert.ok(O.recipes('spruce_fence_gate', { facing: 'west', open: 'true', in_wall: 'false' }).length);
    assert.ok(O.recipes('redstone_wire', { power: '15' }).every((q) => q.clicked === 'up')); assert.strictEqual(O.itemOf('redstone_wire'), 'redstone');
    assert.deepStrictEqual(O.model('oak_log', { clicked: 'east', hy: 0.5, yRot: 0, pitch: 'level' }).props, { axis: 'x' });
    assert.ok(O.derivedCell('piston_head', {}));
    assert.strictEqual(O.family('stone'), 'plain'); assert.deepStrictEqual(O.recipes('stone', {})[0].clicked, 'up');
}
{   // look conversion: yRot 180 = north = mineflayer yaw 0; 90 = west = +pi/2
    assert.ok(Math.abs(O.lookOf({ yRot: 180, pitch: 'level' }).yaw) < 1e-9); assert.ok(Math.abs(O.lookOf({ yRot: 90, pitch: 'level' }).yaw - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(O.lookOf({ yRot: 0, pitch: 'down' }).pitch + Math.PI / 2) < 1e-9);
}
console.log('orient: ok');
