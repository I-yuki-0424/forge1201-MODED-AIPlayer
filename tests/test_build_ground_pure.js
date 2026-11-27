'use strict';
// Nothing of the build lies on the ground until it despawns (TASK-20261125-081; b081u4, Fabric 1.21.1, native: 128 smooth stone of a hand-over and a stack at the chest
// despawned): (1) a toss gives no more than the asker's pack takes now (pool.room); (2) a build item lying on the site for 15 s is picked up by the nearest bot with room
// (drive.recoverGround); (3) a window is closed with nothing on the cursor (supply.closeSafe, through deposit). Negative controls: a full pack takes nothing more; a young stack, a
// stack of rubble, a stack another bot went for, a bot without room are left alone.
const assert = require('assert');
const { Vec3 } = require('vec3');
const { room } = require('../src/build/pool');
const D = require('../src/build/drive');
const SUP = require('../src/build/supply');

const inv = (stacks) => ({ registry: { itemsByName: { smooth_stone: { stackSize: 64 }, glass: { stackSize: 64 }, white_bed: { stackSize: 1 } } }, inventory: { items: () => stacks.map(([name, count], i) => ({ name, count, slot: 9 + i })) } });

(async () => {
    // 1. room
    {
        const full = Array.from({ length: 33 }, () => ['dirt', 64]);
        const bot = inv([...full, ['smooth_stone', 60]]);          // 34 slots used: 2 free, one kept: 1 usable + 4 on the partial stack
        assert.deepStrictEqual(room(bot, { smooth_stone: 100, glass: 30 }), { smooth_stone: 68 }, 'the partial stack topped up, one free slot, the last one kept');
        assert.deepStrictEqual(room(inv(Array.from({ length: 36 }, () => ['dirt', 64])), { glass: 10 }), {}, 'negative control: a full pack takes nothing');
        assert.deepStrictEqual(room(inv([]), { white_bed: 3, glass: 100 }), { white_bed: 3, glass: 100 }, 'an empty pack takes it all');
    }
    console.log('  ok a toss gives what the asker\'s pack takes now');

    // 2. recoverGround
    {
        const now = Date.now(), logs = [];
        const mk = (id, item, ageS, x, extra = {}) => ({ id: String(id), at: now - ageS * 1000, item, count: 64, cause: 'toss', by: 'B', fate: null, ent: { position: new Vec3(x, 64, 0) }, ...extra });
        const W = { recs: new Map([['1', mk(1, 'smooth_stone', 40, 6)], ['2', mk(2, 'smooth_stone', 5, 2)], ['3', mk(3, 'dirt', 40, 1)], ['4', mk(4, 'glass', 40, 3)]]), claims: new Map([['4', { by: 'C', at: now }]]) };
        const job = { itemWatch: W, t: { items: new Map([['smooth_stone', 1], ['glass', 1]]) }, stats: {}, log: (m) => logs.push(m) };
        const stacks = [];
        const bot = { entity: { position: new Vec3(0, 64, 0) }, entities: {}, inventory: { items: () => stacks.map(([name, count], i) => ({ name, count, slot: 9 + i })) } };
        let went = null;
        const mv = { goto: async (q) => { went = q; W.recs.get('1').fate = 'picked'; stacks.push(['smooth_stone', 64]); return { ok: true }; } };
        assert.strictEqual(await D.recoverGround(job, 'A', bot, mv, { cancelled: false }), true);
        assert.deepStrictEqual({ x: went.x, z: went.z }, { x: 6, z: 0 }, 'the old build stack, not the young one (2), the rubble (3) or the one C went for (4)');
        assert.deepStrictEqual(job.stats.ground, { tried: 1, picked: 64 });
        assert.ok(/picked up 64/.test(logs[0]), logs.join('\n'));
        assert.strictEqual(await D.recoverGround(job, 'A', bot, mv, { cancelled: false }), false, 'negative control: nothing else old enough and free');
        const fullBot = { ...bot, inventory: { items: () => Array.from({ length: 35 }, (_, i) => ({ name: 'dirt', count: 64, slot: 9 + i })) } };
        W.recs.get('2').at = now - 40000;
        assert.strictEqual(await D.recoverGround(job, 'A', fullBot, mv, { cancelled: false }), false, 'negative control: a bot without room does not go');
    }
    console.log('  ok a build stack lying 15 s is picked up by the nearest bot with room; young, rubble, claimed stacks and a full pack are left');

    // 3. a deposit closes its window with nothing on the cursor
    {
        const clicks = []; let closed = false;
        const win = { inventoryStart: 27, inventoryEnd: 63, slots: Array(63).fill(null), selectedItem: { name: 'glass', count: 12 }, containerItems: () => [] };
        win.slots[0] = { name: 'smooth_stone', count: 64 };
        const bot = { registry: { items: {} }, inventory: { items: () => [] }, clickWindow: async (slot, b, mode) => { clicks.push([slot, b, mode]); win.selectedItem = null; },
            closeWindow: () => { closed = true; }, openContainer: async () => win, openChest: async () => win, blockAt: () => ({ name: 'chest', position: new Vec3(0, 64, 0) }) };
        await SUP.deposit(bot, { x: 0, y: 64, z: 0 }, []);
        assert.ok(closed);
        assert.deepStrictEqual(clicks[0], [1, 0, 0], 'the cursor stack into the first empty slot of the chest before the close');
        win.selectedItem = null; clicks.length = 0; closed = false;
        await SUP.deposit(bot, { x: 0, y: 64, z: 0 }, []);
        assert.ok(closed && clicks.length === 0, 'negative control: an empty cursor, no click');
        console.log('  ok a window closes with an empty cursor');
    }
    console.log('test_build_ground_pure: 3 passed');
})().catch((e) => { console.error(e); process.exit(1); });
