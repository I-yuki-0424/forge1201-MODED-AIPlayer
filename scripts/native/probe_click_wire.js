'use strict';
// Probe (TASK-20261125-076): what mineflayer's clickWindow puts on the wire for window_click, per protocol version, offline.
// Since 1.21.5 the client sends HashedSlot (item id, count and a CRC32C per component) in changedSlots / cursorItem, not full items.
// Run: docker run --rm --network none -v "$PWD":/w -w /w node:20-slim node scripts/native/probe_click_wire.js [version ...]
const { createSerializer, createDeserializer, states } = require('minecraft-protocol');

const versions = process.argv.slice(2).length ? process.argv.slice(2) : ['1.20.1', '1.21.1', '26.1'];
for (const v of versions) {
    const Item = require('prismarine-item')(v);
    const reg = require('prismarine-registry')(v);
    const ser = createSerializer({ state: states.PLAY, isServer: false, version: v });
    const des = createDeserializer({ state: states.PLAY, isServer: true, version: v });
    const tryOne = (label, cursor, changed) => {
        try {
            const buf = ser.createPacketBuffer({ name: 'window_click', params: { windowId: 1, stateId: 3, slot: 0, mouseButton: 0, mode: 0, changedSlots: changed, cursorItem: cursor } });
            const back = des.parsePacketBuffer(buf).data.params;
            console.log(v, '|', label, '| bytes', buf.length, '| server reads', JSON.stringify({ cursor: back.cursorItem, changed: back.changedSlots }));
        } catch (e) { console.log(v, '|', label, '| THROWS', e.message.split('\n')[0].slice(0, 200)); }
    };
    tryOne('empty cursor', Item.toNotch(null), []);
    tryOne('5 dirt on cursor, slot 0 emptied', Item.toNotch(new Item(reg.itemsByName.dirt.id, 5)), [{ location: 0, item: Item.toNotch(null) }]);
    if (reg.supportFeature('itemsWithComponents')) {
        const pick = Item.fromNotch({ itemId: reg.itemsByName.iron_pickaxe.id, itemCount: 1, components: [{ type: 'damage', data: 12 }], removeComponents: [] });
        tryOne('damaged pickaxe on cursor', Item.toNotch(pick), []);
    }
}
