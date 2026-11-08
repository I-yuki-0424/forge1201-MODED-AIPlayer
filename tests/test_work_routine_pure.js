// Routines (owner 2026-11-08): the same script over and over until stopped, with the chest and the table named in the script. The nuggets example end to end on a fake bot.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const script = require('../src/work/bot/script');
const { Sites } = require('../src/work/bot/sites');
const { WorkService } = require('../src/work/service');

setTimeout(() => { console.error('test watchdog: still running after 30 s'); process.exit(2); }, 30000).unref();
function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const EXAMPLE = {
    name: 'nuggets-to-blocks',
    steps: [
        { if: { not: { has: { item: 'iron_nugget', min: 9 } } }, then: [{ take: { item: 'iron_nugget', count: 9, from: 'nugget-chest' }, optional: true }] },
        { if: { has: { item: 'iron_nugget', min: 9 } }, then: [{ cmd: 'craft', args: { item: 'iron_ingot', count: 1 }, at: 'nugget-table' }] },
        { if: { has: { item: 'iron_ingot', min: 9 } }, then: [{ cmd: 'craft', args: { item: 'iron_block', count: 1 }, at: 'nugget-table' }, { cmd: 'deposit', args: { item: 'iron_block', count: 1 }, at: 'nugget-chest' }] },
        { return: 'ok' },
    ],
};

/** A bot next to a chest with nuggets and a table: take/craft/deposit change a pack and a chest the way the real ones do. */
function fake(chestNuggets) {
    const inv = {}, chest = { iron_nugget: chestNuggets }, calls = [];
    const sites = new Sites([{ name: 'nugget-chest', x: 1, y: 64, z: 0, purpose: 'any' }, { name: 'nugget-table', x: 2, y: 64, z: 0, purpose: 'other', label: 'table' }]);
    const env = { sites, inv: () => ({ items: [], slotsFree: 20 }), here: () => ({ x: 0, y: 64, z: 0 }), pos: () => ({ x: 0, z: 0 }), w: {}, have: (n) => inv[n] || 0, canCraft: () => true, itemExists: () => true,
        exec: async (n, a) => {
            calls.push([n, a.item, a.x]);
            if (n === 'withdraw') { if ((chest[a.item] || 0) < a.count) return { ok: false, reason: 'missing_item' }; chest[a.item] -= a.count; inv[a.item] = (inv[a.item] || 0) + a.count; return { ok: true }; }
            if (n === 'craft') {
                if (a.x !== 2) return { ok: false, reason: 'no_station' };
                if (a.item === 'iron_ingot') { if ((inv.iron_nugget || 0) < 9) return { ok: false, reason: 'missing_item' }; inv.iron_nugget -= 9; inv.iron_ingot = (inv.iron_ingot || 0) + 1; }
                if (a.item === 'iron_block') { inv.iron_ingot -= 9; inv.iron_block = (inv.iron_block || 0) + 1; }
                return { ok: true };
            }
            if (n === 'deposit') { if (a.x !== 1) return { ok: false, reason: 'invalid_target' }; inv[a.item] -= a.count; chest[a.item] = (chest[a.item] || 0) + a.count; return { ok: true }; }
            return { ok: true };
        } };
    return { env, inv, chest, calls };
}

(async () => {
    await test('script: a step names a tagged block (or a purpose); the grammar still refuses nonsense', () => {
        assert.ok(script.validate(EXAMPLE));
        for (const bad of [{ name: 'a', steps: [{ cmd: 'craft', at: 'Bad Name' }] }, { name: 'a', steps: [{ take: { item: 'stone', from: 'x' } }] }, { name: 'a', steps: [{ cmd: 'craft', at: '../x' }] }]) assert.throws(() => script.validate(bad), script.ScriptError);
        const s = new Sites([{ name: 'nugget-chest', x: 1, y: 64, z: 0, purpose: 'any' }, { name: 'other-any', x: 9, y: 64, z: 0, purpose: 'any' }]);
        assert.strictEqual(s.pick('other-any').x, 9, 'by name'); assert.strictEqual(s.pick('any', { x: 8, z: 0 }).name, 'other-any', 'by purpose: the nearest'); assert.strictEqual(s.pick('nothing'), null);
    });

    await test('the example, one round: nine nuggets become an ingot; eight rounds more and nine ingots become a block that goes back into the chest', async () => {
        const f = fake(81);                                                         // 81 nuggets = 9 ingots = one block
        const sc = script.validate(EXAMPLE);
        const r1 = await script.runScript(sc, f.env); assert.ok(r1.ok, JSON.stringify(r1)); assert.deepStrictEqual([f.inv.iron_ingot, f.inv.iron_nugget, f.chest.iron_nugget], [1, 0, 72]);
        for (let i = 0; i < 8; i++) await script.runScript(sc, f.env);
        assert.deepStrictEqual([f.inv.iron_block, f.inv.iron_ingot, f.chest.iron_block, f.chest.iron_nugget], [0, 0, 1, 0], 'the block went back into the chest');
    });

    await test('runLoop: repeats until cancelled; a round with nothing to do ends well and waits; five failed rounds in a row end it with the reason; progress is reported', async () => {
        const f = fake(81), cancel = { cancelled: false }, seen = [];
        const res = await script.runLoop(script.validate(EXAMPLE), f.env, { cancel, pauseMs: 1, sleep: () => Promise.resolve(), onRound: (r) => { seen.push(r.rounds); if (r.rounds === 12) cancel.cancelled = true; } });
        assert.deepStrictEqual([res.ok, res.ended, res.rounds], [true, 'stopped', 12]); assert.strictEqual(f.chest.iron_block, 1, 'one block made in the first nine rounds, the rest waited'); assert.strictEqual(seen.length, 12);
        const bad = fake(81); bad.env.exec = async () => ({ ok: false, reason: 'unreachable' });
        const g = await script.runLoop(script.validate({ name: 'x', steps: [{ cmd: 'mine', args: { x: 1, y: 2, z: 3 } }] }), bad.env, { pauseMs: 1, sleep: () => Promise.resolve() });
        assert.deepStrictEqual([g.ok, g.ended, g.rounds, g.reason], [false, 'gave_up', 5, 'unreachable']);
    });

    await test('service: startRoutine runs in the background, shows rounds, stops with the stop command, refuses a busy bot', async () => {
        const f = fake(0), d = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-'));
        const svc = new WorkService({ dataDir: d, factory: () => ({}), restore: false, envFactory: () => f.env });
        svc.sites.add({ name: 'nugget-chest', x: 1, y: 64, z: 0, purpose: 'any' }); svc.sites.add({ name: 'nugget-table', x: 2, y: 64, z: 0, purpose: 'other', label: 'table' });
        svc.bots.set('R', { name: 'R', bot: { entity: {} }, state: 'online' });
        svc.putScript(EXAMPLE);
        const r = svc.startRoutine('R', 'nuggets-to-blocks', { pauseMs: 500 });
        assert.deepStrictEqual(r, { started: true, bot: 'R', script: 'nuggets-to-blocks' });
        await sleep(300); const rec = svc.bots.get('R');
        assert.ok(rec.script && rec.script.routine && rec.script.routine.rounds >= 1, JSON.stringify(rec.script && rec.script.routine));
        assert.throws(() => svc.startRoutine('R', 'nuggets-to-blocks'), /busy/);
        const st = await svc.runCommand({ bots: ['R'], command: 'stop' }); assert.deepStrictEqual(st.started, ['R']);
        await sleep(900); assert.strictEqual(rec.script, null, 'ended after Stop');
        assert.throws(() => svc.startRoutine('R', 'nope'), /no script/); assert.throws(() => svc.startRoutine('R', 'nuggets-to-blocks', { pauseMs: 5 }), /pauseMs/);
        fs.rmSync(d, { recursive: true });
    });
    console.log('\nwork routine: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
