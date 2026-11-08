'use strict';
// Screens that a mod opens through its own channel instead of the vanilla open_window packet.
// CodeChickenLib (Ender Storage and every other CCL mod) sends `ccl:internal` { 0x0a, varint menuTypeId, varint windowId, varint titleLength, title (JSON), extra data }
// and then the ordinary window_items / set_slot packets for that window id; no open_window ever arrives, so Mineflayer's openBlock waits for nothing.
// Measured 2026-11-09 on Ender Storage 2.11.0: 0a 33 01 2e {"translate":"block.enderstorage.ender_chest"} 01 <frequency NBT> .. followed by window_items(windowId 1, 63 items).
// Here the packet is read, and when the window's items arrive (they say how many slots the menu has: items - 36 for the player's inventory) an open_window
// is raised for Mineflayer with that slot count, so it builds a generic window of the right size: openBlock / click / close all work as for a chest.
const CHANNELS = new Set(['ccl:internal']);
const OPEN_CONTAINER = 0x0a;

/** Read a varint at `at`; {value, next} or null when the buffer ends. */
function varint(buf, at) {
    let value = 0, shift = 0;
    for (let i = at; i < buf.length && shift < 35; i++) { const b = buf[i]; value |= (b & 0x7f) << shift; if (!(b & 0x80)) return { value, next: i + 1 }; shift += 7; }
    return null;
}

/** {menuType, windowId, title} from the payload of an "open container" message, or null when it is anything else or damaged. */
function parseOpen(data) {
    const buf = Buffer.from(data || []);
    if (!buf.length || buf[0] !== OPEN_CONTAINER) return null;
    const t = varint(buf, 1), w = t && varint(buf, t.next), n = w && varint(buf, w.next);
    if (!n || n.value < 0 || n.value > 4096 || n.next + n.value > buf.length) return null;
    const title = buf.toString('utf8', n.next, n.next + n.value);
    if (w.value < 1 || w.value > 100) return null;
    return { menuType: t.value, windowId: w.value, title };
}

/** Raise open_window for the menus a CCL mod opens. Idempotent per bot. */
function attach(bot) {
    if (bot._forgeWindows) return;
    bot._forgeWindows = true;
    let pending = null;
    bot._client.on('custom_payload', (p) => {
        if (!p || !CHANNELS.has(p.channel)) return;
        const o = parseOpen(p.data);
        if (o) pending = o;
    });
    bot._client.on('window_items', (pk) => {
        if (!pending || pk.windowId !== pending.windowId) return;
        const o = pending;
        pending = null;
        const slots = pk.items.length - 36;
        if (slots < 1) return;                                                      // not a container with a player inventory below it
        bot._client.emit('open_window', { windowId: o.windowId, inventoryType: `forge:menu_${o.menuType}`, windowTitle: o.title, slotCount: slots });
    });
}

module.exports = { attach, parseOpen, varint };
