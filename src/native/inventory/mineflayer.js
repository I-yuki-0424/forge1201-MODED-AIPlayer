'use strict';
// The native inventory under a mineflayer bot (TASK-20261125-076): every window click goes through the native client (windows.js: the game's rules, the
// changed slots sent, the server's packets as the truth), and mineflayer's window objects (`bot.inventory`, `bot.currentWindow`, read by ~90 places in this
// repository) are kept equal to it: the predicted slots are written into them, and the cursor corrections mineflayer drops (set_slot -1 / set_cursor_item)
// are applied. mineflayer's own helpers that click (bot.craft, equip, toss, the furnace and chest helpers) call `bot.clickWindow`, `bot.transfer`,
// `bot.putAway`, `bot.moveSlotItem`, `bot.putSelectedItemRange` and the window's `deposit` / `withdraw`: those are replaced here with the same strategy
// (mineflayer 4.39's, MIT) on the native click. A screen the native client does not model (anvil, villager ...) keeps mineflayer's own click.
const { once } = require('events');
const W = require('./windows');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const onceOr = (em, ev, ms) => Promise.race([once(em, ev), sleep(ms)]);

function install(bot, opts = {}) {
    if (bot.__nativeInventory) return bot.__nativeInventory;
    const nw = bot.__nativeWindows || new W.Windows(bot.registry, (name, params) => bot._client.write(name, params), opts).attach(bot._client);
    bot.__nativeWindows = nw;
    const orig = { clickWindow: bot.clickWindow, transfer: bot.transfer, putAway: bot.putAway, moveSlotItem: bot.moveSlotItem, putSelectedItemRange: bot.putSelectedItemRange, openBlock: bot.openBlock };
    const toItem = (s) => nw.items.toWire(s);
    const modelled = (win) => (win.id === 0 ? !nw.cur : !!(nw.cur && nw.cur.id === win.id && nw.cur.menu && nw.cur.loaded));
    // the cursor corrections mineflayer drops
    nw.on('carried', (st) => { const win = bot.currentWindow || bot.inventory; if (win && modelled(win)) win.selectedItem = toItem(st); });
    // mineflayer closes a window on its own (window.close, bot.closeWindow): the native client follows
    bot.on('windowClose', () => { if (nw.cur) nw.onClose(); });

    async function clickWindow(slot, mouseButton, mode) {
        const win = bot.currentWindow || bot.inventory;
        if (!modelled(win)) return orig.clickWindow(slot, mouseButton, mode);
        const r = nw.click(slot, mouseButton, mode);
        const menu = nw.menu();
        for (const i of r.changed) win.updateSlot(i, toItem(menu.slots[i]));
        win.selectedItem = toItem(menu.carried);
        if (typeof bot.updateHeldItem === 'function') bot.updateHeldItem();
        // a click in a crafting grid or on its result: the server computes the new result (as mineflayer waits for it)
        const craft = (win.type === 'minecraft:inventory' && slot >= 0 && slot <= 4) || (/crafting/.test(win.type) && slot >= 0 && slot <= 9);
        if (craft) await onceOr(win, 'updateSlot:0', 1000);
    }

    // ---- mineflayer 4.39's strategies (lib/plugins/inventory.js, MIT), on the native click -------------------------------------------------------------
    async function putSelectedItemRange(start, end, window, slot) {
        for (let guard = 0; window.selectedItem && guard < 64; guard++) {
            const item = window.findItemRange(start, end, window.selectedItem.type, window.selectedItem.metadata, true, window.selectedItem.nbt);
            if (item && item.stackSize !== item.count) await clickWindow(item.slot, 0, 0);
            else {
                const empty = window.firstEmptySlotRange(start, end);
                if (empty === null) { if (slot !== null) await clickWindow(slot, 0, 0); if (window.selectedItem) await clickWindow(-999, 0, 0); } else await clickWindow(empty, 0, 0);
            }
        }
    }
    async function transfer(options) {
        const window = options.window || bot.currentWindow || bot.inventory;
        const { itemType, metadata, nbt, sourceStart, destStart } = options;
        let count = options.count === undefined || options.count === null ? 1 : options.count;
        const sourceEnd = options.sourceEnd === null ? sourceStart + 1 : options.sourceEnd, destEnd = options.destEnd === null ? destStart + 1 : options.destEnd;
        let firstSourceSlot = null;
        for (let guard = 0; guard < 4096; guard++) {
            if (count === 0) { await putSelectedItemRange(sourceStart, sourceEnd, window, firstSourceSlot); return; }
            if (!window.selectedItem || window.selectedItem.type !== itemType || (metadata != null && window.selectedItem.metadata !== metadata) || (nbt != null && window.selectedItem.nbt !== nbt)) {
                const src = window.findItemRange(sourceStart, sourceEnd, itemType, metadata, false, nbt);
                if (!src) { const e = bot.registry.items[itemType]; throw new Error(`Can't find ${e ? e.name : itemType} in slots [${sourceStart} - ${sourceEnd}], (item id: ${itemType})`); }
                if (firstSourceSlot === null) firstSourceSlot = src.slot;
                await clickWindow(src.slot, 0, 0);
            }
            let destItem = null, destSlot;
            if (destStart === -999) destSlot = -999;
            else {
                destItem = window.findItemRange(destStart, destEnd, window.selectedItem.type, window.selectedItem.metadata, true, nbt);
                destSlot = destItem ? destItem.slot : window.firstEmptySlotRange(destStart, destEnd);
                if (destSlot === null) throw new Error('destination full');
            }
            const have = destItem && destItem.count ? destItem.count : 0;
            const moved = Math.min(window.selectedItem.stackSize - have, window.selectedItem.count);
            if (moved <= count) { await clickWindow(destSlot, 0, 0); count -= moved; } else { await clickWindow(destSlot, 1, 0); count -= 1; }
        }
        throw new Error('transfer did not finish');
    }
    async function putAway(slot) {
        const window = bot.currentWindow || bot.inventory, start = window.inventoryStart, end = window.inventoryEnd, item = window.slots[slot];
        const resultSlot = slot === window.craftingResultSlot || (window.type === 'minecraft:merchant' && slot === 2);
        const room = item && (window.findItemRange(start, end, item.type, item.metadata, true, item.nbt) || window.firstEmptySlotRange(start, end) !== null);
        if (room && !resultSlot) await clickWindow(slot, 0, 1);
        else { await clickWindow(slot, 0, 0); await putSelectedItemRange(start, end, window, null); }
    }
    async function moveSlotItem(sourceSlot, destSlot) {
        await clickWindow(sourceSlot, 0, 0);
        await clickWindow(destSlot, 0, 0);
        const win = bot.currentWindow || bot.inventory;
        if (win.selectedItem) await clickWindow(sourceSlot, 0, 0);
    }
    function extend(window) {
        window.withdraw = async (itemType, metadata, count, nbt) => {
            if (bot.inventory.emptySlotCount() === 0) throw new Error('Unable to withdraw, Bot inventory is full.');
            await transfer({ window, itemType, metadata, count, nbt, sourceStart: 0, sourceEnd: window.inventoryStart, destStart: window.inventoryStart, destEnd: window.inventoryEnd });
        };
        window.deposit = async (itemType, metadata, count, nbt) => {
            await transfer({ window, itemType, metadata, count, nbt, sourceStart: window.inventoryStart, sourceEnd: window.inventoryEnd, destStart: 0, destEnd: window.inventoryStart });
        };
        return window;
    }
    async function openBlock(...args) { return extend(await orig.openBlock(...args)); }

    Object.assign(bot, { clickWindow, transfer, putAway, moveSlotItem, putSelectedItemRange, openBlock });
    const h = {
        windows: nw,
        restore() { Object.assign(bot, orig); delete bot.__nativeInventory; },
    };
    bot.__nativeInventory = h;
    return h;
}

module.exports = { install };
