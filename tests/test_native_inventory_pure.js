'use strict';
// Native inventory (src/native/inventory, TASK-20261125-076): every click mode on the game's rules, quick-move per menu, the protocol client (prediction,
// corrections from set_slot / set_cursor_item, the full-state sync), the click packet on the wire per version, container contents from block entities,
// comparator signal strength, and the click plans that set a container's contents.
const assert = require('assert');
const { EventEmitter } = require('events');
const nbt = require('prismarine-nbt');
const N = require('../src/native/inventory');

let n = 0;
const t = (name, fn) => { const r = fn(); if (r && r.then) return r.then(() => { n++; console.log(`  ok  ${name}`); }); n++; console.log(`  ok  ${name}`); return null; };
const reg = require('prismarine-registry')('1.21.1');
const items = N.itemsOf(reg), S = items.stack;
const view = (m, a, b) => m.slots.slice(a, b).map((s) => (s ? `${s.name}x${s.count}` : '-'));
const chest = (stacks = {}) => { const arr = []; for (const [k, v] of Object.entries(stacks)) arr[Number(k)] = v; return new N.Menu('generic_9x3', items, arr); };

console.log('native inventory');
(async () => {
    // ---- PICKUP -----------------------------------------------------------------------------------------------------------
    t('PICKUP: left takes the stack, right takes half (rounded up), left puts all, right puts one', () => {
        const m = chest({ 0: S('dirt', 7) });
        m.click(0, 1, 0); assert.deepStrictEqual([m.carried.count, m.slots[0].count], [4, 3]);
        m.click(1, 1, 0); assert.deepStrictEqual([m.carried.count, m.slots[1].count], [3, 1]);
        m.click(0, 0, 0); assert.deepStrictEqual([m.carried, m.slots[0].count], [null, 6]);
        m.click(0, 0, 0); assert.strictEqual(m.carried.count, 6);
    });
    t('PICKUP: a different item swaps with the carried one; the same item merges up to 64 and keeps the rest', () => {
        const m = chest({ 0: S('dirt', 60), 1: S('stone', 10) });
        m.click(1, 0, 0); m.click(0, 0, 0);
        assert.deepStrictEqual([m.slots[0].name, m.carried.name, m.carried.count], ['stone', 'dirt', 60]);
        const k = chest({ 0: S('dirt', 60) }); k.carried = S('dirt', 10); k.click(0, 0, 0);
        assert.deepStrictEqual([k.slots[0].count, k.carried.count], [64, 6]);
    });
    t('PICKUP: a crafting result gives its whole stack and uses one of each ingredient; nothing can be put into it', () => {
        const m = new N.Menu('crafting', items, [S('oak_planks', 4), S('oak_log', 3)]);
        m.click(0, 1, 0);                                                          // right click: still the whole result
        assert.deepStrictEqual([m.carried.count, m.slots[0], m.slots[1].count], [4, null, 2]);
        m.click(0, 0, 0); assert.strictEqual(m.slots[0], null, 'the result slot takes nothing');
    });
    t('PICKUP: a shulker box cannot go into a shulker box; armour slots take only their part, one at a time', () => {
        const b = new N.Menu('shulker_box', items); b.carried = S('white_shulker_box', 1); b.click(0, 0, 0);
        assert.strictEqual(b.slots[0], null);
        const p = new N.Menu('inventory', items); p.carried = S('iron_boots', 1); p.click(5, 0, 0);
        assert.strictEqual(p.slots[5], null, 'boots do not go on the head'); p.click(8, 0, 0); assert.strictEqual(p.slots[8].name, 'iron_boots');
    });
    t('outside the window (-999): left drops the carried stack, right drops one', () => {
        const m = chest(); m.carried = S('dirt', 5);
        m.click(-999, 1, 0); assert.strictEqual(m.carried.count, 4); m.click(-999, 0, 0); assert.strictEqual(m.carried, null);
        assert.deepStrictEqual(m.drops.map((d) => d.count), [1, 4]);
    });
    // ---- QUICK_MOVE -------------------------------------------------------------------------------------------------------
    t('QUICK_MOVE chest -> pack fills from the END (hotbar right to left), stacking first; pack -> chest from the start', () => {
        const m = chest({ 0: S('dirt', 30), [27 + 27 + 3]: S('dirt', 60) });
        m.click(0, 0, 1);
        assert.deepStrictEqual([m.slots[0], m.slots[57].count, m.slots[62].name, m.slots[62].count], [null, 64, 'dirt', 26]);
        m.click(62, 0, 1); assert.deepStrictEqual(view(m, 0, 2), ['dirtx26', '-']);
    });
    t('QUICK_MOVE in the player inventory: armour to its slot, main to hotbar, hotbar to main', () => {
        const p = new N.Menu('inventory', items, Object.assign([], { 9: S('iron_helmet', 1), 10: S('dirt', 5), 36: S('stone', 3) }));
        p.click(9, 0, 1); assert.strictEqual(p.slots[5].name, 'iron_helmet');
        p.click(10, 0, 1); assert.strictEqual(p.slots[36].name, 'stone'); assert.strictEqual(p.slots[37].name, 'dirt');
        p.click(36, 0, 1); assert.strictEqual(p.slots[9].name, 'stone');
    });
    t('QUICK_MOVE in a furnace: coal to the fuel slot, raw iron to the input, the result to the pack', () => {
        const f = new N.Menu('furnace', items, Object.assign([], { 2: S('iron_ingot', 3), 3: S('coal', 8), 4: S('raw_iron', 5) }));
        f.click(3, 0, 1); f.click(4, 0, 1); f.click(2, 0, 1);
        assert.deepStrictEqual(view(f, 0, 3), ['raw_ironx5', 'coalx8', '-']); assert.strictEqual(f.slots[38].name, 'iron_ingot');
    });
    // ---- SWAP, THROW, QUICK_CRAFT, PICKUP_ALL -------------------------------------------------------------------------------------
    t('SWAP: a number key swaps the slot with that hotbar slot; 40 with the off hand', () => {
        const m = chest({ 0: S('dirt', 5), [27 + 27 + 2]: S('stone', 1) });
        m.click(0, 2, 2); assert.deepStrictEqual([m.slots[0].name, m.slots[56].name], ['stone', 'dirt']);
        m.click(0, 40, 2); assert.deepStrictEqual([m.slots[0], m.offhand.name], [null, 'stone']);
    });
    t('THROW: button 0 drops one, 1 the stack', () => {
        const m = chest({ 0: S('dirt', 5) });
        m.click(0, 0, 4); assert.strictEqual(m.slots[0].count, 4); m.click(0, 1, 4); assert.strictEqual(m.slots[0], null);
        assert.deepStrictEqual(m.drops.map((d) => d.count), [1, 4]);
    });
    t('QUICK_CRAFT: a left drag splits evenly (64 over 3 = 21 each, 1 kept), a right drag puts one each', () => {
        const m = chest(); m.carried = S('dirt', 64);
        for (const [s, b] of [[-999, 0], [0, 1], [1, 1], [2, 1], [-999, 2]]) m.click(s, b, 5);
        assert.deepStrictEqual([view(m, 0, 3), m.carried.count], [['dirtx21', 'dirtx21', 'dirtx21'], 1]);
        const r = chest(); r.carried = S('dirt', 5);
        for (const [s, b] of [[-999, 4], [3, 5], [4, 5], [-999, 6]]) r.click(s, b, 5);
        assert.deepStrictEqual([view(r, 3, 5), r.carried.count], [['dirtx1', 'dirtx1'], 3]);
    });
    t('PICKUP_ALL: a double click gathers the same item into the carried stack, non-full stacks first', () => {
        const m = chest({ 0: S('dirt', 10), 1: S('dirt', 64), 2: S('dirt', 20) }); m.carried = S('dirt', 1);
        m.click(5, 0, 6);
        assert.deepStrictEqual([m.carried.count, view(m, 0, 3)], [64, ['-', 'dirtx31', '-']]);
    });
    t('PICKUP and THROW agree with prismarine-windows (mineflayer\'s predictor) on 400 random clicks in a chest of plain items', () => {
        const W = require('prismarine-windows')('1.21.1'), Item = require('prismarine-item')(reg);
        const pw = W.createWindow(1, 'minecraft:generic_9x3', 'c', 27), m = chest();
        let seed = 7; const rnd = (k) => { seed = (seed + 0x6D2B79F5) | 0; let z = Math.imul(seed ^ (seed >>> 15), 1 | seed); z ^= z + Math.imul(z ^ (z >>> 7), 61 | z); return ((z ^ (z >>> 14)) >>> 0) % k; };   // mulberry32
        for (let i = 0; i < 12; i++) { const s = rnd(63), name = ['dirt', 'stone', 'stick'][rnd(3)], c = 1 + rnd(64); m.slots[s] = S(name, c); pw.updateSlot(s, new Item(reg.itemsByName[name].id, c)); }
        for (let k = 0; k < 400; k++) {
            const slot = rnd(63), button = rnd(2), mode = rnd(5) === 0 && !m.carried ? 4 : 0;
            m.click(slot, button, mode); pw.acceptClick({ slot, mouseButton: button, mode, windowId: 1, item: pw.slots[slot] });   // mineflayer passes the slot's item
            const a = view(m, 0, 63), b = pw.slots.map((s) => (s ? `${s.name}x${s.count}` : '-'));
            assert.deepStrictEqual(a, b, `click ${k}: slot ${slot} button ${button} mode ${mode}`);
            assert.strictEqual(m.carried ? `${m.carried.name}x${m.carried.count}` : '-', pw.selectedItem ? `${pw.selectedItem.name}x${pw.selectedItem.count}` : '-', `cursor after click ${k}`);
        }
    });
    // ---- the protocol client ------------------------------------------------------------------------------------------------
    function fake(version = '1.21.1') {
        const r = require('prismarine-registry')(version), Item = require('prismarine-item')(r), it = N.itemsOf(r);
        const client = new EventEmitter(), sent = [];
        const w = new N.Windows(r, (name, params) => sent.push({ name, params })).attach(client);
        const wire = (name, c) => Item.toNotch(name ? new Item(r.itemsByName[name].id, c) : null);
        return { r, Item, it, client, sent, w, wire };
    }
    await t('client: open + window_items, a click sends the changed slots and the cursor with the state id; set_slot corrections win', () => {
        const f = fake();
        f.client.emit('open_window', { windowId: 3, inventoryType: 2, windowTitle: '' });
        const items27 = Array.from({ length: 63 }, (_, i) => f.wire(i === 0 ? 'cobblestone' : null, 20));
        f.client.emit('window_items', { windowId: 3, stateId: 7, items: items27, carriedItem: f.wire(null) });
        assert.strictEqual(f.w.cur.type, 'generic_9x3');
        f.w.click(0, 0, 0);
        const p = f.sent[0].params;
        assert.deepStrictEqual([f.sent[0].name, p.windowId, p.stateId, p.slot, p.mouseButton, p.mode], ['window_click', 3, 7, 0, 0, 0]);
        assert.deepStrictEqual(p.changedSlots.map((c) => c.location), [0]); assert.strictEqual(p.cursorItem.itemCount, 20);
        // the server disagrees: it put 19 back (e.g. a mod) and says the cursor holds 1
        f.client.emit('set_slot', { windowId: 3, stateId: 8, slot: 0, item: f.wire('cobblestone', 19) });
        f.client.emit('set_slot', { windowId: -1, stateId: 9, slot: -1, item: f.wire('cobblestone', 1) });
        assert.deepStrictEqual([f.w.menu().slots[0].count, f.w.menu().carried.count, f.w.stateId, f.w.stats.corrections], [19, 1, 9, 2]);
    });
    await t('client: each window keeps its own state id (after a chest closes, a click in the inventory carries the inventory\'s id)', () => {
        const f = fake();
        f.client.emit('window_items', { windowId: 0, stateId: 40, items: Array.from({ length: 46 }, (_, i) => f.wire(i === 36 ? 'dirt' : null, 3)), carriedItem: f.wire(null) });
        f.client.emit('open_window', { windowId: 5, inventoryType: 2, windowTitle: '' });
        f.client.emit('window_items', { windowId: 5, stateId: 2, items: Array.from({ length: 63 }, () => f.wire(null)), carriedItem: f.wire(null) });
        f.w.click(0, 0, 0); assert.strictEqual(f.sent[0].params.stateId, 2);
        f.client.emit('close_window', { windowId: 5 });
        f.w.click(36, 0, 0); assert.strictEqual(f.sent[1].params.stateId, 40);
    });
    await t('client: 1.21.2+ set_cursor_item corrects the carried stack (mineflayer 4.39 has no handler for it)', () => {
        const f = fake('1.21.4');
        f.w.inv.carried = f.it.stack('dirt', 3); f.w.pending = { windowId: 0, slots: [] };
        f.client.emit('set_cursor_item', { contents: f.wire(null) });
        assert.deepStrictEqual([f.w.inv.carried, f.w.stats.corrections], [null, 1]);
    });
    await t('client: the player inventory is one: a container\'s pack slots and window 0 agree after a click', () => {
        const f = fake();
        f.client.emit('open_window', { windowId: 4, inventoryType: 16, windowTitle: '' });                   // hopper (16 in the 1.21.1 menu order)
        const its = Array.from({ length: 41 }, (_, i) => f.wire(i === 5 ? 'stick' : null, 4));
        f.client.emit('window_items', { windowId: 4, stateId: 1, items: its, carriedItem: f.wire(null) });
        assert.strictEqual(f.w.cur.type, 'hopper'); assert.strictEqual(f.w.inv.slots[9].name, 'stick');
        f.w.click(5, 0, 1);                                                                                  // shift-click the sticks into the hopper
        assert.deepStrictEqual([f.w.menu().slots[0].name, f.w.inv.slots[9]], ['stick', null]);
    });
    await t('client: sync() sends the impossible state id and resolves on the full window contents', async () => {
        const f = fake();
        const p = f.w.sync(500);
        assert.deepStrictEqual([f.sent[0].params.stateId, f.sent[0].params.slot, f.sent[0].params.mode, f.sent[0].params.mouseButton], [-1, -999, 5, 2]);
        f.client.emit('window_items', { windowId: 0, stateId: 12, items: Array.from({ length: 46 }, () => f.wire(null)), carriedItem: f.wire(null) });
        await p; assert.strictEqual(f.w.stateId, 12);
    });
    await t('wire: the click packet encodes on 1.21.1 (full items) and 26.1 (HashedSlot: no components = exact, empty = absent)', () => {
        const { createSerializer, createDeserializer, states } = require('minecraft-protocol');
        for (const v of ['1.21.1', '26.1']) {
            const f = fake(v);
            f.w.inv.slots[36] = f.it.stack('dirt', 5);
            f.w.click(36, 0, 0);
            const ser = createSerializer({ state: states.PLAY, isServer: false, version: v }), des = createDeserializer({ state: states.PLAY, isServer: true, version: v });
            const back = des.parsePacketBuffer(ser.createPacketBuffer({ name: 'window_click', params: f.sent[0].params })).data.params;
            assert.strictEqual(back.cursorItem.itemCount, 5, v);
            const emptied = back.changedSlots.find((c) => c.location === 36).item;
            if (v === '26.1') assert.strictEqual(emptied, undefined, 'an empty slot is the absent option'); else assert.ok(!emptied || !emptied.itemCount, 'empty slot');
        }
    });
    // ---- contents, signal, plans ------------------------------------------------------------------------------------------------
    t('block entity Items: 1.20.5+ (count, components) and older (Count, tag) layouts', () => {
        const be = nbt.comp({ Items: nbt.list(nbt.comp([{ Slot: nbt.byte(0), id: nbt.string('minecraft:cobblestone'), count: nbt.int(18) }, { Slot: nbt.byte(2), id: nbt.string('minecraft:stick'), Count: nbt.byte(1) }])) });
        assert.deepStrictEqual(N.fromBlockEntity(be).map((x) => [x.slot, x.item, x.count]), [[0, 'cobblestone', 18], [2, 'stick', 1]]);
    });
    t('comparator signal: 1 + floor(14 x fullness); a sorter filter hopper (18 + 4 x 1) gives 1, one more item 2', () => {
        const ms = (name) => reg.itemsByName[name].stackSize;
        const filter = [{ item: 'cobblestone', count: 18 }, { item: 'stick', count: 1 }, { item: 'stick', count: 1 }, { item: 'stick', count: 1 }, { item: 'stick', count: 1 }];
        assert.strictEqual(N.signalOf(filter, 5, ms), 1);
        assert.strictEqual(N.signalOf([{ ...filter[0], count: 19 }, ...filter.slice(1)], 5, ms), 2);
        assert.strictEqual(N.signalOf([], 27, ms), 0);
        assert.strictEqual(N.signalOf([{ item: 'iron_sword', count: 1 }], 5, ms), 3);                       // 1/1 of a slot: 0.2 x 14 = 2.8 -> 2 + 1
        assert.strictEqual(N.signalOf(Array.from({ length: 27 }, () => ({ item: 'dirt', count: 64 })), 27, ms), 15);
    });
    t('contents for a signal: the fewest items (barrel, cobblestone: 3 needs 247, 2 needs 124)', () => {
        const c3 = N.contentsForSignal({ size: 27, item: 'cobblestone', strength: 3 });
        assert.strictEqual(c3.reduce((a, b) => a + b.count, 0), 247);
        assert.deepStrictEqual(c3.map((x) => x.count), [64, 64, 64, 55]);
        assert.strictEqual(N.contentsForSignal({ size: 27, item: 'cobblestone', strength: 2 }).reduce((a, b) => a + b.count, 0), 124);
        assert.throws(() => N.contentsForSignal({ size: 5, item: 'iron_sword', maxStack: 1, strength: 4 }));      // swords in a hopper: 3, 6, 9, 12, 15 only
    });
    t('plan: a filter hopper set from a mixed pack (18 from a stack of 40, sticks one by one), what is not wanted taken out first', () => {
        const h = new N.Menu('hopper', items, Object.assign([], { 1: S('dirt', 3), 5: S('cobblestone', 40), 6: S('stick', 10), 7: S('cobblestone', 7) }));
        const goal = [{ slot: 0, item: 'cobblestone', count: 18 }, ...[1, 2, 3, 4].map((s) => ({ slot: s, item: 'stick', count: 1 }))];
        const p = N.planClicks(h, goal, { exact: true });
        assert.deepStrictEqual([p.missing, p.noRoom], [[], false]);
        assert.deepStrictEqual(N.compare(p.menu, goal, { exact: true }), []);
        // replayed on a fresh copy, the clicks give the same end state (they are plain clicks, nothing else)
        const again = h.clone(); for (const [s, b, md] of p.clicks) again.click(s, b, md);
        assert.deepStrictEqual(N.compare(again, goal, { exact: true }), []);
        const total = (m, name) => m.slots.reduce((a, s) => a + (s && s.name === name ? s.count : 0), 0);
        assert.strictEqual(total(again, 'cobblestone'), 47, 'no cobblestone lost or made'); assert.strictEqual(again.carried, null);
    });
    t('plan: too many of the right item is trimmed; missing items and a full pack are reported', () => {
        const h = new N.Menu('hopper', items, Object.assign([], { 0: S('cobblestone', 30) }));
        const p = N.planClicks(h, [{ slot: 0, item: 'cobblestone', count: 18 }]);
        assert.deepStrictEqual(N.compare(p.menu, [{ slot: 0, item: 'cobblestone', count: 18 }]), []);
        assert.strictEqual(p.menu.slots.slice(5).reduce((a, s) => a + (s ? s.count : 0), 0), 12);
        const q = N.planClicks(new N.Menu('hopper', items), [{ slot: 0, item: 'stick', count: 2 }]);
        assert.deepStrictEqual(q.missing.map((x) => [x.item, x.need]), [['stick', 2]]);
        const full = new N.Menu('hopper', items, Object.assign([], { 0: S('dirt', 5) }, Object.fromEntries(Array.from({ length: 36 }, (_, i) => [5 + i, S('stone', 64)]))));
        assert.ok(N.planClicks(full, [], { exact: true }).noRoom, 'no room for the dirt');
    });
    t('plan: a barrel at signal 3 from stacks of cobblestone', () => {
        const b = new N.Menu('generic_9x3', items, Object.assign([], ...[0, 1, 2, 3, 4].map((k) => ({ [27 + k]: S('cobblestone', 64) }))));
        const goal = N.contentsForSignal({ size: 27, item: 'cobblestone', strength: 3 });
        const p = N.planClicks(b, goal, { exact: true });
        assert.deepStrictEqual(N.compare(p.menu, goal, { exact: true }), []);
        assert.strictEqual(N.signalOf(p.menu.slots.slice(0, 27).filter(Boolean).map((s) => ({ item: s.name, count: s.count })), 27, (x) => reg.itemsByName[x].stackSize), 3);
        assert.ok(p.clicks.length <= 3 * 2 + 2 + 55 + 2, `clicks ${p.clicks.length}`);
    });
    console.log(`native inventory: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
