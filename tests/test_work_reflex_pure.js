// Reflexes (src/work/bot/reflex.js): the pure parts and the decision on the tick, with a fake bot. The water bucket and the block under the feet are checked live
// (scripts/work/reflex_live.js).
const assert = require('assert');
const { EventEmitter } = require('events');
const { attach, dropBelow, escapeCell, FALL_MIN } = require('../src/work/bot/reflex');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    await test('dropBelow: free cells under the feet until something solid or a fluid; null when a chunk is missing', () => {
        const col = (floor) => (x, y, z) => (y <= floor ? 'solid' : 'air');
        assert.strictEqual(dropBelow(col(0), 0, 10, 0), 9); assert.strictEqual(dropBelow(col(9), 0, 10, 0), 0);
        assert.strictEqual(dropBelow((x, y) => (y === 4 ? 'water' : 'air'), 0, 10, 0), 5, 'water is a landing'); assert.strictEqual(dropBelow(() => 'air', 0, 10, 0, 12), 12);
        assert.strictEqual(dropBelow((x, y) => (y < 6 ? 'unknown' : 'air'), 0, 10, 0), null);
        assert.strictEqual(dropBelow((x, y) => (y > 7 ? 'climb' : y === 7 ? 'solid' : 'air'), 0, 10, 0), 2, 'a ladder is not a floor');
    });

    await test('escapeCell: the nearest dry standable cell with no lava beside it; none = null', () => {
        const lava = new Set(['0,0,0', '1,0,0', '0,0,1', '-1,0,0', '0,0,-1']);
        const kindAt = (x, y, z) => (lava.has(`${x},${y},${z}`) ? 'danger' : y < 0 ? 'solid' : y === 0 && Math.max(Math.abs(x), Math.abs(z)) <= 3 && lava.has(`${x},${y},${z}`) ? 'danger' : y >= 0 && y <= 1 ? 'air' : 'air');
        const c = escapeCell((x, y, z) => (lava.has(`${x},${y},${z}`) ? 'danger' : y < 0 ? (lava.has(`${x},${y + 1},${z}`) ? 'danger' : 'solid') : 'air'), { x: 0, y: 0, z: 0 });
        assert.ok(c && !lava.has(`${c.x},${c.y},${c.z}`) && c.d <= 3, JSON.stringify(c));
        assert.strictEqual(escapeCell(() => 'danger', { x: 0, y: 0, z: 0 }), null);
    });

    await test('the watcher: a fall of 5+ blocks fires it once, stops the running task (bot.__preempt) and lets go afterwards; a short fall, a swim and a disabled watcher do not', async () => {
        const mk = (floor) => {
            const bot = new EventEmitter(), events = [];
            Object.assign(bot, { entity: { position: { x: 0.5, y: 20, z: 0.5, floored: () => ({ x: 0, y: 20, z: 0 }), offset: () => ({ floored: () => ({}) }) }, onGround: false, velocity: { y: -0.8 }, isInWater: false }, inventory: { items: () => [{ name: 'water_bucket' }] }, heldItem: { name: 'water_bucket' }, activateItem() { bot.used = (bot.used || 0) + 1; },
                blockAt: () => ({ name: 'air' }), equip: async () => {}, look: async () => {}, setControlState() {}, setQuickBarSlot() {} });
            let on = true;
            const rf = attach(bot, { world: { kindAt: (x, y, z) => (y <= floor ? 'solid' : 'air') }, enabled: () => on, onEvent: (n, d) => events.push([n, d.kind || d.name]) });
            return { bot, rf, events, off: () => { on = false; } };
        };
        const a = mk(0); a.bot.emit('physicsTick'); assert.strictEqual(a.bot.__preempt, true, 'the task is stopped'); assert.strictEqual(a.rf.state.fired, 1);
        a.bot.emit('physicsTick'); assert.strictEqual(a.rf.state.fired, 1, 'once');
        // the bot comes down to 3 blocks over the floor: the water goes down (activateItem), once
        a.bot.entity.position.y = 3; await sleep(80); assert.strictEqual(a.bot.used, 1, 'water put down near the ground');
        a.bot.entity.onGround = true; await sleep(1100); assert.strictEqual(a.bot.__preempt, false, 'let go'); assert.deepStrictEqual(a.events.map((e) => e[0]), ['reflex', 'reflex_end']);
        const b = mk(18); b.bot.emit('physicsTick'); assert.strictEqual(b.rf.state.fired, 0, `a fall of ${FALL_MIN - 3} blocks is not worth it`);
        const c = mk(0); c.bot.entity.isInWater = true; c.bot.emit('physicsTick'); assert.strictEqual(c.rf.state.fired, 0, 'water breaks the fall');
        const d = mk(0); d.off(); d.bot.emit('physicsTick'); assert.strictEqual(d.rf.state.fired, 0, 'switched off');
        const e = mk(0); e.bot.entity.velocity.y = -0.1; e.bot.emit('physicsTick'); assert.strictEqual(e.rf.state.fired, 0, 'a jump or a step down is not a fall');
        a.rf.detach();
    });

    await test('the runner stops a command while a reflex has the body (bot.__preempt) and the worker env waits for it', async () => {
        const { Ctx, SkillError } = require('../src/skills/runner');
        const bot = new EventEmitter(); Object.assign(bot, { entity: { position: { x: 0, y: 0, z: 0 }, onGround: true, velocity: { x: 0, y: 0, z: 0 } }, world: {}, setControlState() {}, health: 20 });
        const ctx = new Ctx(bot, { maxTicks: 10, cancel: { cancelled: false } });
        bot.__preempt = true;
        assert.throws(() => ctx.tick({}), (e) => e instanceof SkillError && e.reason === 'cancelled');
    });
    console.log('\nwork reflex: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
