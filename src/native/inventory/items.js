'use strict';
// Item stacks as the container logic needs them (TASK-20261125-076): { id, name, count, comp } where `comp` is the stack's identity beyond the item
// (data components from 1.20.5, NBT before) as a canonical string, so ItemStack.isSameItemSameComponents is a string compare. Max stack sizes come from the
// connected version's registry (minecraft-data) unless a component overrides them. The wire form stays prismarine-item's (the protocol's item codec):
// `fromWire` / `toWire` convert, nothing else here knows a version.

const EMPTY = null;
const isEmpty = (s) => !s || s.count <= 0;
const copy = (s, count) => (isEmpty(s) ? EMPTY : { ...s, count: count === undefined ? s.count : count });
const sameItem = (a, b) => !isEmpty(a) && !isEmpty(b) && a.name === b.name;
const sameItemSameComponents = (a, b) => sameItem(a, b) && (a.comp || '') === (b.comp || '');

/** Canonical string of components / NBT (key order fixed), '' for none. */
function canon(v) {
    if (v === undefined || v === null) return '';
    const walk = (x) => (Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])])) : x);
    const s = JSON.stringify(walk(v));
    return s === '[]' || s === '{}' ? '' : s;
}

/** A registry-backed stack factory: stack('dirt', 5), maxStack(stack). */
function itemsOf(registry) {
    const byName = registry.itemsByName || {}, byId = registry.items || {};
    const maxStack = (s) => {
        if (isEmpty(s)) return 64;
        if (Number.isInteger(s.maxStack)) return s.maxStack;
        const it = byName[s.name];
        return it && Number.isInteger(it.stackSize) ? it.stackSize : 64;
    };
    const stack = (name, count = 1, comp = '') => {
        const n = String(name).replace(/^minecraft:/, ''), it = byName[n];
        if (!it) throw new Error(`no item ${name} in ${registry.version && registry.version.minecraftVersion}`);
        return { id: it.id, name: n, count, comp };
    };
    /** prismarine-item Item (or null) -> stack. */
    const fromWire = (item) => {
        if (!item || item.count <= 0) return EMPTY;
        const it = byId[item.type];
        const comp = item.components && item.components.length ? canon(item.components) : item.nbt ? canon(item.nbt) : '';
        const s = { id: item.type, name: item.name || (it && it.name), count: item.count, comp, wire: item };
        if (Number.isInteger(item.stackSize) && it && item.stackSize !== it.stackSize) s.maxStack = item.stackSize;
        return s;
    };
    /** stack -> prismarine-item Item (or null): the wire object of the same item with this count. */
    const toWire = (s) => {
        if (isEmpty(s)) return null;
        const Item = require('prismarine-item')(registry);
        if (s.wire) { const w = Object.assign(Object.create(Object.getPrototypeOf(s.wire)), s.wire); w.count = s.count; return w; }
        return new Item(s.id, s.count);
    };
    return { stack, maxStack, fromWire, toWire };
}

module.exports = { EMPTY, isEmpty, copy, sameItem, sameItemSameComponents, canon, itemsOf };
