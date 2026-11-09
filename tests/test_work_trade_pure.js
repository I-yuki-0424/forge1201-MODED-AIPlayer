// Trading with a villager (src/work/bot/trade.js; WIP, owner 2026-11-09): choosing a trade by what the operator names, price and stock, the buying loop against a fake
// villager window shaped like Mineflayer's, and every failure with its reason.
const assert = require('assert');
const trade = require('../src/work/bot/trade');

function test(name, fn) { console.log(`--- test: ${name} ---`); return Promise.resolve(fn()).then(() => console.log('[OK]')); }
const item = (name, count) => ({ name, count, type: name.length });
/** A trade as Mineflayer's villager window has it (price already with demand: realPrice). */
const T = (give, get, { price, give2, uses = 0, max = 12, disabled = false } = {}) => ({
    inputItem1: item(give[0], give[1]), realPrice: price === undefined ? give[1] : price, hasItem2: !!give2, inputItem2: give2 ? item(give2[0], give2[1]) : undefined,
    outputItem: item(get[0], get[1]), nbTradeUses: uses, maximumNbTradeUses: max, tradeDisabled: disabled,
});
const LIST = () => [
    T(['wheat', 20], ['emerald', 1]),                                  // 0
    T(['emerald', 1], ['bread', 6]),                                   // 1
    T(['emerald', 3], ['bread', 6], { price: 2 }),                     // 2: cheaper than 1? no: price 2 vs 1; kept to test ordering
    T(['paper', 24], ['emerald', 1], { uses: 12 }),                    // 3: sold out
    T(['emerald', 5], ['enchanted_book', 1], { give2: ['book', 1] }),  // 4: two payments
    T(['emerald', 1], ['bread', 6], { price: 1, disabled: true }),     // 5: disabled
];

/** deps over a fake world: a villager window that applies a trade to the fake inventory. */
function deps({ trades = LIST(), inv = { emerald: 10, book: 3, wheat: 5 }, villagers = [{ id: 7, dist: 2 }, { id: 9, dist: 5 }], approach = { ok: true }, openFails = null, tradeFails = null } = {}) {
    const log = [], have = (i) => inv[i] || 0;
    return {
        log, inv, have, pause: async () => {},
        villagers: () => villagers,
        approach: async (v) => { log.push(['approach', v.id]); return approach; },
        open: async (v) => {
            log.push(['open', v.id]); if (openFails) throw new Error(openFails);
            return {
                trades,
                trade: async (i, n) => {
                    log.push(['trade', i, n]); if (tradeFails) throw new Error(tradeFails);
                    const t = trades[i]; inv[t.inputItem1.name] = have(t.inputItem1.name) - t.realPrice * n; if (t.hasItem2) inv[t.inputItem2.name] = have(t.inputItem2.name) - t.inputItem2.count * n;
                    inv[t.outputItem.name] = have(t.outputItem.name) + t.outputItem.count * n; t.nbTradeUses += n;
                },
                close: async () => { log.push(['close']); },
            };
        },
    };
}

(async () => {
    await test('describe: price now, payments, stock left (a disabled trade has none)', () => {
        const d = LIST().map((t, i) => trade.describe(t, i));
        assert.deepStrictEqual(d[2], { index: 2, give: [{ item: 'emerald', count: 2 }], get: { item: 'bread', count: 6 }, uses: 0, max: 12, left: 12 });
        assert.strictEqual(d[3].left, 0); assert.strictEqual(d[5].left, 0);
        assert.deepStrictEqual(d[4].give, [{ item: 'emerald', count: 5 }, { item: 'book', count: 1 }]);
    });

    await test('select: by index, by what it gives or takes, cheapest open one first, price limit; sold out and unknown are said', () => {
        const d = LIST().map((t, i) => trade.describe(t, i));
        assert.strictEqual(trade.select(d, { get: 'bread' }).trade.index, 1, 'the cheapest open bread trade (the disabled one costs 1 too but is shut)');
        assert.strictEqual(trade.select(d, { get: 'minecraft:emerald' }).trade.index, 0, 'minecraft: prefix tolerated; paper is sold out, wheat is open');
        assert.strictEqual(trade.select(d, { give: 'book' }).trade.index, 4);
        assert.strictEqual(trade.select(d, { index: 4 }).trade.index, 4);
        assert.strictEqual(trade.select(d, { get: 'bread', maxPrice: 1 }).trade.index, 1);
        const dear = trade.select(d, { get: 'enchanted_book', maxPrice: 3 }); assert.strictEqual(dear.ok, false); assert.match(dear.detail.why, /offers no such trade/);
        const sold = trade.select(d, { give: 'paper' }); assert.strictEqual(sold.ok, false); assert.match(sold.detail.why, /sold out/);
        assert.match(trade.select(d, { index: 99 }).detail.why, /no trade 99 \(the villager offers 6\)/);
        assert.match(trade.select(d, { index: 0, get: 'bread' }).detail.why, /not what was asked for/);
        const none = trade.select(d, { get: 'diamond' }); assert.strictEqual(none.reason, 'invalid_target'); assert.ok(none.detail.offers.length === 6 && /^0: 20 wheat -> 1 emerald/.test(none.detail.offers[0]));
        assert.strictEqual(trade.select(d, {}).reason, 'invalid_args');
    });

    await test('affordable: stock and what the bot carries of each payment', () => {
        const d = LIST().map((t, i) => trade.describe(t, i));
        assert.strictEqual(trade.affordable(d[4], (i) => ({ emerald: 12, book: 1 })[i] || 0), 1, 'one book is the limit');
        assert.strictEqual(trade.affordable(d[1], () => 100), 12, 'the stock is the limit');
        assert.strictEqual(trade.affordable(d[0], () => 59), 2);
    });

    await test('trades (list): nearest villager, approached and opened, the list returned, the window always closed', async () => {
        const dp = deps(); const r = await trade.run(dp, { list: true });
        assert.ok(r.ok); assert.strictEqual(r.detail.villager, 7); assert.strictEqual(r.detail.trades.length, 6);
        assert.deepStrictEqual(dp.log.map((l) => l[0]), ['approach', 'open', 'close']);
        const other = await trade.run(deps(), { list: true, entity: 9 }); assert.strictEqual(other.detail.villager, 9);
    });

    await test('trade: buys the chosen trade the asked number of times, spends and gets what the list says, confirmed by the inventory', async () => {
        const dp = deps();
        const r = trade.confirm(await trade.run(dp, { get: 'bread', count: 3 }), dp.have);
        assert.ok(r.ok, JSON.stringify(r)); assert.deepStrictEqual(r.detail.bought, { trade: 1, uses: 3, item: 'bread', items: 18, spent: ['3 emerald'], got: 18 });
        assert.strictEqual(dp.inv.emerald, 7); assert.strictEqual(dp.inv.bread, 18);
        assert.deepStrictEqual(dp.log.filter((l) => l[0] === 'trade'), [['trade', 1, 3]]); assert.strictEqual(dp.log[dp.log.length - 1][0], 'close');
        const two = deps(); const t2 = await trade.run(two, { index: 4 }); assert.ok(t2.ok); assert.strictEqual(two.inv.book, 2); assert.strictEqual(two.inv.emerald, 5);
    });

    await test('trade: less than asked is said (stock or payment ran out); nothing at all is a failure with the reason', async () => {
        const part = await trade.run(deps({ inv: { emerald: 2 } }), { get: 'bread', count: 5 });
        assert.ok(part.ok); assert.strictEqual(part.detail.bought.uses, 2); assert.match(part.detail.short, /only 2 of 5/);
        const poor = await trade.run(deps({ inv: { emerald: 0 } }), { get: 'bread' });
        assert.deepStrictEqual([poor.ok, poor.reason, poor.detail.item], [false, 'missing_item', 'emerald']);
        const noBook = await trade.run(deps({ inv: { emerald: 50 } }), { index: 4 }); assert.deepStrictEqual([noBook.reason, noBook.detail.item], ['missing_item', 'book']);
        const shut = await trade.run(deps(), { index: 5 }); assert.strictEqual(shut.reason, 'invalid_target'); assert.match(shut.detail.why, /sold out/);
    });

    await test('trade: bad arguments, no villager, a walk that fails, a window that does not open, a trade the server refuses: each has its reason and the window is closed', async () => {
        assert.strictEqual((await trade.run(deps(), { get: 'bread', count: 0 })).reason, 'invalid_args');
        assert.strictEqual((await trade.run(deps(), { get: 'bread', count: 65 })).reason, 'invalid_args');
        const none = await trade.run(deps({ villagers: [] }), { get: 'bread' }); assert.deepStrictEqual([none.reason, none.detail.why], ['invalid_target', 'no villager near the bot (32 blocks)']);
        assert.match((await trade.run(deps(), { get: 'bread', entity: 123 })).detail.why, /no villager #123/);
        const far = await trade.run(deps({ approach: { ok: false, reason: 'unreachable', detail: { why: 'no free cell beside the villager' } } }), { get: 'bread' });
        assert.deepStrictEqual([far.reason, far.detail.stage], ['unreachable', 'approach']);
        const dp = deps({ openFails: 'timeout opening the villager' }); const op = await trade.run(dp, { get: 'bread' });
        assert.deepStrictEqual([op.reason, op.detail.stage], ['timeout', 'open']);
        const refused = deps({ tradeFails: 'Not enough item 1 to trade' }); const rf = await trade.run(refused, { get: 'bread' });
        assert.deepStrictEqual([rf.reason, rf.detail.stage], ['missing_item', 'trade']); assert.strictEqual(refused.log[refused.log.length - 1][0], 'close');
        const blocked = await trade.run(deps({ tradeFails: 'trade blocked' }), { get: 'bread' }); assert.strictEqual(blocked.reason, 'invalid_target');
        const odd = await trade.run(deps({ tradeFails: 'something else' }), { get: 'bread' }); assert.strictEqual(odd.reason, 'not_confirmed');
    });

    await test('confirm: a trade that ran but whose items did not arrive is not_confirmed', async () => {
        const dp = deps(); const r = await trade.run(dp, { get: 'bread', count: 2 });
        dp.inv.bread = 5;                                                 // the pack lost them again (full inventory, dropped on the floor)
        const c = trade.confirm(r, dp.have); assert.deepStrictEqual([c.ok, c.reason], [false, 'not_confirmed']); assert.match(c.detail.why, /5 of 12 bread/);
        const l = await trade.run(deps(), { list: true }); assert.strictEqual(trade.confirm(l, () => 0), l, 'a list needs no confirmation');
    });

    console.log('\nwork trade: all tests passed');
    process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
