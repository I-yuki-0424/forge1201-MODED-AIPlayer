'use strict';
// The client side of the container protocol (TASK-20261125-076): the player's inventory and the open container as the SERVER last said, the carried
// stack, state ids, and clicks predicted with the game's own rules (menu.js) and sent with the slots they change, as the vanilla client does.
// The server's packets are the truth: every set_slot / window_items / cursor packet overwrites the prediction; a prediction the server corrected is
// counted (`stats.corrections`), and `sync()` asks for the full state (a no-op click with an impossible state id makes the server send window_items).
//
// Two causes of the click trouble seen with mineflayer (measured offline, scripts/native/probe_click_wire.js; docs/proposed/NATIVE-v1.md), both handled here:
//   - the carried-stack corrections: up to 1.21.1 set_slot(window -1, slot -1), from 1.21.2 set_cursor_item; mineflayer 4.39 handles neither, so after a
//     click the server corrected, its cursor stays wrong until the next full window_items and the next click carries the wrong cursor;
//   - from 1.21.5 the click carries HashedSlot (item, count, a CRC32C per component); mineflayer writes hash 0 for every component, so every click
//     involving an enchanted, damaged, named or filled item is a mismatch the server corrects. Here a stack without components is exact; a stack
//     with components is sent with the hash the server last gave for the same stack when known, else marked unknown (the server's correction is taken).
const { EventEmitter } = require('events');
const I = require('./items');
const { Menu, diff } = require('./menu');

// MenuType registry order (BuiltInRegistries.MENU); crafter_3x3 from 1.20.3 (data version 3698)
const MENUS = ['generic_9x1', 'generic_9x2', 'generic_9x3', 'generic_9x4', 'generic_9x5', 'generic_9x6', 'generic_3x3', 'crafter_3x3', 'anvil', 'beacon', 'blast_furnace', 'brewing_stand',
    'crafting', 'enchantment', 'furnace', 'grindstone', 'hopper', 'lectern', 'loom', 'merchant', 'shulker_box', 'smithing', 'smoker', 'cartography_table', 'stonecutter'];
const menuName = (id, dataVersion) => { const list = dataVersion >= 3698 ? MENUS : MENUS.filter((m) => m !== 'crafter_3x3'); return typeof id === 'string' ? id.replace(/^minecraft:/, '') : list[id]; };
// set_slot window -2 / set_player_inventory use Inventory indices: 0-8 hotbar, 9-35 main, 36-39 armour feet..head, 40 off hand
const same = (a, b) => (I.isEmpty(a) && I.isEmpty(b)) || (I.sameItemSameComponents(a, b) && a.count === b.count);
const fromInventoryIndex = (i) => (i <= 8 ? i + 36 : i <= 35 ? i : i <= 39 ? 44 - i : i === 40 ? 45 : -1);

class Windows extends EventEmitter {
    /**
     * registry: prismarine-registry of the connected version; send(name, params): writes a packet (bot._client.write). opts.protocol: minecraft-data
     * protocol of the version (to read the click packet's item type); opts.menu: Menu options (smeltable, isFuel).
     */
    constructor(registry, send, opts = {}) {
        super();
        this.registry = registry; this.send = send; this.opts = opts;
        this.items = I.itemsOf(registry);
        this.dataVersion = registry.version && registry.version.dataVersion;
        const proto = opts.protocol || (() => { try { return require('minecraft-data')(registry.version.minecraftVersion).protocol; } catch (_) { return null; } })();
        const click = proto && proto.play && proto.play.toServer.types.packet_window_click;
        this.hashed = !!click && JSON.stringify(click).includes('HashedSlot');
        this.inv = new Menu('inventory', this.items, [], opts.menu);
        this.cur = null;                                     // { id, type, menu }
        this.stateId = 0;
        this.stats = { clicks: 0, corrections: 0, syncs: 0, fullStates: 0 };
        this.pending = null;                                 // the last click's prediction: { windowId, slots: Map(index -> stack), carried }
    }
    attach(client) {
        const on = (n, f) => client.on(n, (p) => { try { f(p); } catch (e) { this.emit('error', e); } });
        on('open_window', (p) => this.onOpen(p.windowId, p.inventoryType, p.windowTitle));
        on('close_window', () => this.onClose());
        on('window_items', (p) => this.onItems(p.windowId, p.stateId, p.items, p.carriedItem));
        on('set_slot', (p) => this.onSlot(p.windowId, p.stateId, p.slot, p.item));
        on('set_cursor_item', (p) => this.onCarried(this.items.fromWire(this.Item().fromNotch(p.contents))));
        on('set_player_inventory', (p) => this.onPlayerSlot(fromInventoryIndex(p.slotId), p.contents));
        on('respawn', () => { this.cur = null; this.pending = null; });
        return this;
    }
    Item() { return require('prismarine-item')(this.registry); }
    menu() { return this.cur ? this.cur.menu : this.inv; }
    windowId() { return this.cur ? this.cur.id : 0; }

    // ---- server packets ----------------------------------------------------------------------------------------------
    onOpen(id, type, title) {
        const name = menuName(type, this.dataVersion);
        let menu = null;
        try { menu = new Menu(name, this.items, [], this.opts.menu); } catch (_) { menu = null; }      // a screen this layer does not model (anvil, beacon ...)
        this.cur = { id, type: name, title, menu, loaded: false };
        if (menu) this.copyInvInto(menu);
        this.emit('open', this.cur);
    }
    onClose() { this.cur = null; this.pending = null; this.emit('close'); }
    onItems(id, stateId, items, carried) {
        const m = id === 0 ? this.inv : this.cur && this.cur.id === id ? this.cur.menu : null;
        if (!m) return;
        const Item = this.Item();
        for (let i = 0; i < Math.min(items.length, m.slots.length); i++) m.slots[i] = this.items.fromWire(Item.fromNotch(items[i]));
        m.carried = this.items.fromWire(Item.fromNotch(carried));
        this.stateId = stateId;
        if (m !== this.inv) { this.copyInvFrom(m); this.cur.loaded = true; } else if (this.cur && this.cur.menu) this.copyInvInto(this.cur.menu);
        this.pending = null;
        this.stats.fullStates++;
        this.emit('items', id);
    }
    onSlot(id, stateId, slot, item) {
        this.stateId = stateId;
        const st = this.items.fromWire(this.Item().fromNotch(item));
        if (id === -1 && slot === -1) return this.onCarried(st);
        if (id === -2) return this.onPlayerSlot(fromInventoryIndex(slot), item);
        const m = id === 0 ? this.inv : this.cur && this.cur.id === id ? this.cur.menu : null;
        if (!m || slot < 0 || slot >= m.slots.length) return;
        if (this.pending && this.pending.windowId === id && !same(m.slots[slot], st)) this.stats.corrections++;     // the server's answer differs from the prediction
        m.slots[slot] = st;
        if (m === this.inv) { if (this.cur && this.cur.menu) this.copyInvInto(this.cur.menu); } else this.copyInvFrom(m);
        this.emit('slot', id, slot, st);
    }
    onCarried(st) {
        const m = this.menu();
        if (this.pending && !same(m.carried, st)) this.stats.corrections++;
        m.carried = st;
        this.emit('carried', st);
    }
    onPlayerSlot(i, item) {
        if (i < 0) return;
        this.inv.slots[i] = this.items.fromWire(this.Item().fromNotch(item));
        if (this.cur && this.cur.menu) this.copyInvInto(this.cur.menu);
        this.emit('slot', 0, i, this.inv.slots[i]);
    }
    /** The player's 36 slots are one inventory seen through every menu: keep the player menu and the open one equal. */
    copyInvFrom(m) { for (let k = 0; k < 36; k++) this.inv.slots[9 + k] = I.copy(m.slots[m.L.invStart + k]); }
    copyInvInto(m) { if (m === this.inv) return; for (let k = 0; k < 36; k++) m.slots[m.L.invStart + k] = I.copy(this.inv.slots[9 + k]); }

    // ---- clicks ------------------------------------------------------------------------------------------------------
    /** The wire item of a stack for the click packet: the version's Slot, or from 1.21.5 a HashedSlot (see the header). */
    wire(s) {
        if (!this.hashed) return this.Item().toNotch(this.items.toWire(s));
        if (I.isEmpty(s)) return undefined;
        const w = s.wire, comps = (w && w.components) || [], removed = (w && w.removedComponents) || [];
        return { itemId: s.id, itemCount: s.count, components: comps.map((c) => ({ type: c.type, hash: Number.isInteger(c.hash) ? c.hash : 0 })), removeComponents: removed.map((c) => ({ type: c.type || c })) };
    }
    /**
     * Click `slot` with `button` in `mode` in the open window (or the inventory): predict, send the changed slots and the carried stack, keep the
     * prediction until the server says otherwise. Returns { changed: [slots], carried, drops } of the prediction.
     */
    click(slot, button, mode) {
        const m = this.menu();
        if (!m) throw new Error('native inventory: the open screen is not a modelled menu');
        const before = m.clone();
        m.click(slot, button, mode);
        const d = diff(before, m);
        const changedSlots = d.slots.map((i) => ({ location: i, item: this.wire(m.slots[i]) }));
        this.send('window_click', { windowId: this.windowId(), stateId: this.stateId, slot, mouseButton: button, mode, changedSlots, cursorItem: this.wire(m.carried) });
        if (m !== this.inv) this.copyInvFrom(m); else if (this.cur && this.cur.menu) this.copyInvInto(this.cur.menu);
        this.pending = { windowId: this.windowId(), slots: d.slots };
        this.stats.clicks++;
        const drops = m.drops.splice(0);
        return { changed: d.slots, carried: I.copy(m.carried), drops };
    }
    /** Ask the server for the full state of the open window (no-op drag end with state id -1); resolves on its window_items. */
    sync(timeoutMs = 3000) {
        const id = this.windowId();
        this.stats.syncs++;
        return new Promise((resolve, reject) => {
            const done = (wid) => { if (wid !== id) return; clearTimeout(t); this.removeListener('items', done); resolve(this.menu()); };
            const t = setTimeout(() => { this.removeListener('items', done); reject(new Error('the server sent no window contents')); }, timeoutMs);
            this.on('items', done);
            this.send('window_click', { windowId: id, stateId: -1, slot: -999, mouseButton: 2, mode: 5, changedSlots: [], cursorItem: this.wire(this.menu().carried) });
        });
    }
    close() {
        if (!this.cur) return;
        this.send('close_window', { windowId: this.cur.id });
        this.onClose();
    }
}

module.exports = { Windows, MENUS, menuName, fromInventoryIndex };
