// Simulate the vein mining algorithm logic before putting it into bot_actuator.js
const assert = require('assert');

function mockVeinMine(startPos, isSameTypeFunc) {
    const queue = [startPos];
    const visited = new Set();
    visited.add(`${startPos.x},${startPos.y},${startPos.z}`);
    const collected = [];

    while(queue.length > 0 && collected.length < 64) {
        const curr = queue.shift();
        collected.push(curr);

        const offsets = [
            {x:1, y:0, z:0}, {x:-1, y:0, z:0},
            {x:0, y:1, z:0}, {x:0, y:-1, z:0},
            {x:0, y:0, z:1}, {x:0, y:0, z:-1}
        ];

        for (const off of offsets) {
            const nx = curr.x + off.x;
            const ny = curr.y + off.y;
            const nz = curr.z + off.z;
            const key = `${nx},${ny},${nz}`;

            if (!visited.has(key)) {
                visited.add(key);
                if (isSameTypeFunc(nx, ny, nz)) {
                    queue.push({x: nx, y: ny, z: nz});
                }
            }
        }
    }
    return collected;
}

const mockWorld = {
    '0,0,0': true,
    '1,0,0': true,
    '2,0,0': true,
    '0,1,0': true,
    '0,-1,0': false
};

const isSame = (x, y, z) => !!mockWorld[`${x},${y},${z}`];
const collected = mockVeinMine({x:0,y:0,z:0}, isSame);
console.log("Collected count:", collected.length);
assert.strictEqual(collected.length, 4);
console.log("Test passed");
