'use strict';
// The game's container menus and every click mode, as the 1.21.1 server computes them (AbstractContainerMenu.doClick, Slot, quickMoveStack of the chest,
// hopper, dispenser, shulker box, player inventory, crafting table and furnace menus; TASK-20261125-076). The client predicts a click with this and sends
// the slots it changed; the server's answer stays the truth (src/native/inventory/windows.js). A menu is a list of slots of a kind plus the carried stack.
//
// Modes (ClickType): 0 PICKUP (button 0 left, 1 right), 1 QUICK_MOVE (shift), 2 SWAP (button 0-8 hotbar key, 40 off hand), 3 CLONE (creative only: no-op
// here), 4 THROW (button 0 one, 1 the stack), 5 QUICK_CRAFT (drag: button = type << 2 | stage; stage 0 start, 1 add slot, 2 end; type 0 split, 1 one each,
// 2 clone), 6 PICKUP_ALL (double click). Slot -999 is outside the window (drop).
const I = require('./items');

const ARMOR = [['head', /(_helmet|_head|_skull)$|^(turtle_helmet|carved_pumpkin)$/], ['chest', /(_chestplate)$|^elytra$/], ['legs', /_leggings$/], ['feet', /_boots$/]];
const equipmentOf = (name) => { for (const [k, re] of ARMOR) if (re.test(name)) return k; return name === 'shield' ? 'offhand' : 'mainhand'; };
// AbstractFurnaceBlockEntity fuels (by name; mod items: none) and smeltable inputs (a heuristic of the vanilla recipes: the server corrects a wrong guess)
const FUEL = /^(lava_bucket|coal_block|coal|charcoal|blaze_rod|dried_kelp_block|stick|bamboo|scaffolding|bowl|ladder|crafting_table|cartography_table|fletching_table|smithing_table|loom|composter|barrel|chest|trapped_chest|lectern|note_block|jukebox|bookshelf|chiseled_bookshelf|daylight_detector|bow|crossbow|fishing_rod|.*_log|.*_wood|.*_stem|.*_hyphae|.*_planks|.*_slab|.*_stairs|.*_fence|.*_fence_gate|.*_trapdoor|.*_door|.*_sign|.*_hanging_sign|.*_pressure_plate|.*_button|.*_boat|.*_chest_boat|.*_sapling|.*_wool|.*_carpet|.*_banner|wooden_.*|.*_shelf|azalea|flowering_azalea|mangrove_roots)$/;
const NOT_WOOD_FUEL = /^(crimson|warped)_|^(stone|polished_blackstone|iron|gold|light_weighted|heavy_weighted)_|^(.*stone.*|.*brick.*|.*copper.*|.*deepslate.*|.*quartz.*|.*purpur.*|.*prismarine.*|.*andesite.*|.*diorite.*|.*granite.*|.*tuff.*|.*blackstone.*|.*sandstone.*|.*mud.*|.*bamboo_mosaic.*)_(slab|stairs|wall|pressure_plate|button)$/;
const isFuel = (name) => FUEL.test(name) && !NOT_WOOD_FUEL.test(name) && !/^(iron|copper.*)_(door|trapdoor)$/.test(name);
const SMELTABLE = /^(raw_(iron|gold|copper)|.*_ore|ancient_debris|sand|red_sand|cobblestone|cobbled_deepslate|stone|stone_bricks|deepslate_bricks|deepslate_tiles|polished_blackstone_bricks|nether_bricks|clay_ball|clay|netherrack|cactus|kelp|sea_pickle|wet_sponge|chorus_fruit|quartz_block|sandstone|red_sandstone|basalt|potato|beef|porkchop|chicken|mutton|rabbit|cod|salmon|.*_log|.*_wood|.*_terracotta|terracotta|iron_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots|horse_armor)|golden_(sword|pickaxe|axe|shovel|hoe|helmet|chestplate|leggings|boots|horse_armor)|chainmail_.*)$/;
const isShulker = (name) => /(^|_)shulker_box$/.test(name);

/**
 * Slot kinds: 'any', 'result' (take only; the whole stack), 'craft' (a crafting grid cell), 'fuel', 'input' (furnace), 'armor:<part>', 'offhand',
 * 'box' (a shulker box's own slot: no shulker boxes). `inv` marks the player's 36 slots of the menu (27 main then 9 hotbar).
 */
function layout(type, size) {
    const t = String(type || '').replace(/^minecraft:/, '');
    const inv = (n, start) => { const s = []; for (let i = 0; i < 36; i++) s.push({ kind: 'any', inv: true, hotbar: i >= 27 ? i - 27 : -1, at: start + i }); return s; };
    const any = (n, kind = 'any') => Array.from({ length: n }, () => ({ kind }));
    if (t === 'inventory' || t === 'player') {
        const s = [{ kind: 'result' }, ...any(4, 'craft'), { kind: 'armor:head' }, { kind: 'armor:chest' }, { kind: 'armor:legs' }, { kind: 'armor:feet' }];
        const iv = inv(36, 9).map((x, i) => ({ ...x, hotbar: i >= 27 ? i - 27 : -1 }));
        return { type: 'player', n: 5, invStart: 9, slots: [...s, ...iv, { kind: 'offhand' }] };
    }
    if (t === 'crafting' || t === 'crafting_table') return { type: 'crafting', n: 10, invStart: 10, slots: [{ kind: 'result' }, ...any(9, 'craft'), ...inv(36, 10)] };
    if (/^(furnace|smoker|blast_furnace)$/.test(t)) return { type: t, n: 3, invStart: 3, slots: [{ kind: 'input' }, { kind: 'fuel' }, { kind: 'result' }, ...inv(36, 3)] };
    if (t === 'shulker_box') return { type: 'shulker_box', n: 27, invStart: 27, slots: [...any(27, 'box'), ...inv(36, 27)] };
    if (t === 'hopper') return { type: 'hopper', n: 5, invStart: 5, slots: [...any(5), ...inv(36, 5)] };
    if (/^(generic_3x3|dispenser|dropper|crafter_3x3)$/.test(t)) return { type: 'generic_3x3', n: 9, invStart: 9, slots: [...any(9), ...inv(36, 9)] };
    const m = /^generic_9x([1-6])$/.exec(t);
    const n = m ? 9 * Number(m[1]) : /^(chest|container|barrel)$/.test(t) && Number.isInteger(size) ? size - 36 : null;
    if (n !== null && n > 0) return { type: `generic_9x${n / 9}`, n, invStart: n, slots: [...any(n), ...inv(36, n)] };
    throw new Error(`native inventory: no layout for menu ${type}`);
}

class Menu {
    /** `items`: itemsOf(registry); `stacks`: the slots' stacks (null = empty); opts.smeltable(name), opts.isFuel(name) override the tables. */
    constructor(type, items, stacks = [], opts = {}) {
        this.L = layout(type, stacks.length || undefined);
        this.items = items;
        this.slots = this.L.slots.map((_, i) => I.copy(stacks[i]));
        this.carried = null;
        this.offhand = null;                 // the off hand outside the player menu (SWAP button 40)
        this.drops = [];                     // what left through -999 / THROW (for the caller's bookkeeping)
        this.qc = { status: 0, type: 0, slots: [] };
        this.opts = opts;
    }
    clone() { const m = Object.create(Menu.prototype); Object.assign(m, this, { slots: this.slots.map((s) => I.copy(s)), carried: I.copy(this.carried), offhand: I.copy(this.offhand), drops: [], qc: { ...this.qc, slots: [...this.qc.slots] } }); return m; }
    get size() { return this.slots.length; }
    kind(i) { return this.L.slots[i].kind; }
    max(s) { return this.items.maxStack(s); }

    // ---- Slot --------------------------------------------------------------------------------------------------------
    mayPlace(i, s) {
        const k = this.kind(i), n = s.name;
        if (k === 'result') return false;
        if (k === 'fuel') return (this.opts.isFuel || isFuel)(n) || n === 'bucket';
        if (k.startsWith('armor:')) return equipmentOf(n) === k.slice(6);
        if (k === 'box') return !isShulker(n);
        return true;
    }
    mayPickup() { return true; }                                           // curse of binding on worn armour is not modelled (survival bots wear none)
    slotMax(i, s) { const k = this.kind(i); if (k.startsWith('armor:')) return 1; if (k === 'fuel' && s && s.name === 'bucket') return 1; return Math.min(99, this.max(s)); }
    allowModification(i) { const s = this.slots[i]; return this.mayPickup(i) && (I.isEmpty(s) || this.mayPlace(i, s)); }
    /** Slot.remove: a result slot gives its whole stack (ResultContainer.removeItem ignores the amount). */
    remove(i, n) {
        const s = this.slots[i];
        if (I.isEmpty(s)) return null;
        if (this.kind(i) === 'result') { this.slots[i] = null; return s; }
        const t = Math.min(n, s.count), out = I.copy(s, t);
        this.slots[i] = s.count - t > 0 ? I.copy(s, s.count - t) : null;
        return out;
    }
    tryRemove(i, count, decrement) {
        if (!this.mayPickup(i)) return null;
        const s = this.slots[i];
        if (!this.allowModification(i) && decrement < (s ? s.count : 0)) return null;
        const got = this.remove(i, Math.min(count, decrement));
        if (I.isEmpty(got)) return null;
        this.onTake(i, got);
        return got;
    }
    /** Slot.safeInsert: put up to `n` of `s` (the carried stack, shrunk in place); returns what is left of `s`. */
    safeInsert(i, s, n) {
        if (I.isEmpty(s) || !this.mayPlace(i, s)) return s;
        const cur = this.slots[i], k = Math.min(Math.min(n, s.count), this.slotMax(i, s) - (cur ? cur.count : 0));
        if (k <= 0) return s;
        if (I.isEmpty(cur)) this.slots[i] = I.copy(s, k);
        else if (I.sameItemSameComponents(cur, s)) this.slots[i] = I.copy(cur, cur.count + k);
        else return s;
        return s.count - k > 0 ? I.copy(s, s.count - k) : null;
    }
    /** ResultSlot.onTake of a crafting result: one of every ingredient is used (remainders such as buckets are the server's to send). */
    onTake(i) {
        if (this.kind(i) !== 'result' || !(this.L.type === 'crafting' || this.L.type === 'player')) return;
        for (let j = 1; j < this.L.n; j++) { const g = this.slots[j]; if (!I.isEmpty(g)) this.slots[j] = g.count > 1 ? I.copy(g, g.count - 1) : null; }
    }

    // ---- moveItemStackTo / quickMoveStack ------------------------------------------------------------------------------
    moveTo(s, start, end, reverse) {
        let moved = false;
        if (this.max(s) > 1) {
            for (let i = reverse ? end - 1 : start; !I.isEmpty(s) && (reverse ? i >= start : i < end); i += reverse ? -1 : 1) {
                const t = this.slots[i];
                if (I.isEmpty(t) || !I.sameItemSameComponents(s, t)) continue;
                const j = t.count + s.count, k = this.slotMax(i, t);
                if (j <= k) { this.slots[i] = I.copy(t, j); s.count = 0; moved = true; } else if (t.count < k) { s.count -= k - t.count; this.slots[i] = I.copy(t, k); moved = true; }
            }
        }
        if (!I.isEmpty(s)) {
            for (let i = reverse ? end - 1 : start; reverse ? i >= start : i < end; i += reverse ? -1 : 1) {
                if (!I.isEmpty(this.slots[i]) || !this.mayPlace(i, s)) continue;
                const k = Math.min(s.count, this.slotMax(i, s));
                this.slots[i] = I.copy(s, k); s.count -= k; moved = true;
                break;
            }
        }
        return moved;
    }
    /** quickMoveStack of the menu type: returns a copy of what was in the slot when anything moved, else null. */
    quickMove(i) {
        const L = this.L, size = this.size, src = this.slots[i];
        if (I.isEmpty(src)) return null;
        const s = I.copy(src), orig = I.copy(src), inv0 = L.invStart, hot0 = inv0 + 27, end = inv0 + 36;
        const done = (ok, takeCheck) => {
            if (!ok) { return null; }
            this.slots[i] = I.isEmpty(s) ? null : I.copy(s);
            if (takeCheck && s.count === orig.count) return null;
            if (takeCheck) this.onTake(i, s);
            return orig;
        };
        if (L.type === 'player') {
            const es = equipmentOf(s.name), armorAt = { head: 5, chest: 6, legs: 7, feet: 8 }[es];
            let ok;
            if (i === 0) ok = this.moveTo(s, 9, 45, true);
            else if (i >= 1 && i < 9) ok = this.moveTo(s, 9, 45, false);
            else if (armorAt && I.isEmpty(this.slots[armorAt])) ok = this.moveTo(s, armorAt, armorAt + 1, false);
            else if (es === 'offhand' && I.isEmpty(this.slots[45])) ok = this.moveTo(s, 45, 46, false);
            else if (i >= 9 && i < 36) ok = this.moveTo(s, 36, 45, false);
            else if (i >= 36 && i < 45) ok = this.moveTo(s, 9, 36, false);
            else ok = this.moveTo(s, 9, 45, false);
            const r = done(ok, true);
            if (r && i === 0 && !I.isEmpty(s)) { this.drops.push(I.copy(s)); this.slots[i] = null; }
            return r;
        }
        if (L.type === 'crafting') {
            let ok;
            if (i === 0) ok = this.moveTo(s, 10, 46, true);
            else if (i >= 10 && i < 46) ok = this.moveTo(s, 1, 10, false) || (i < 37 ? this.moveTo(s, 37, 46, false) : this.moveTo(s, 10, 37, false));
            else ok = this.moveTo(s, 10, 46, false);
            return done(ok, true);
        }
        if (/furnace|smoker/.test(L.type)) {
            let ok;
            if (i === 2) ok = this.moveTo(s, 3, 39, true);
            else if (i !== 1 && i !== 0) {
                if ((this.opts.smeltable || ((n) => SMELTABLE.test(n)))(s.name)) ok = this.moveTo(s, 0, 1, false);
                else if ((this.opts.isFuel || isFuel)(s.name)) ok = this.moveTo(s, 1, 2, false);
                else if (i >= 3 && i < 30) ok = this.moveTo(s, 30, 39, false);
                else ok = i >= 30 && i < 39 ? this.moveTo(s, 3, 30, false) : false;
            } else ok = this.moveTo(s, 3, 39, false);
            return done(ok, true);
        }
        // chest, hopper, dispenser, shulker box: the container part to the player's slots (from the end), and back
        const ok = i < L.n ? this.moveTo(s, L.n, size, true) : this.moveTo(s, 0, L.n, false);
        void hot0; void end;
        return done(ok, false);
    }

    // ---- doClick -------------------------------------------------------------------------------------------------------
    /** The player's inventory stack of a hotbar key (0-8) or the off hand (40) in this menu: [get, set]. */
    hotbarRef(b) {
        if (b === 40) return this.L.type === 'player' ? [() => this.slots[45], (v) => { this.slots[45] = v; }] : [() => this.offhand, (v) => { this.offhand = v; }];
        const at = this.L.invStart + 27 + b;
        return [() => this.slots[at], (v) => { this.slots[at] = v; }];
    }
    canQuickReplace(i, s, ignoreCount) {
        const t = this.slots[i];
        if (I.isEmpty(t)) return true;
        return I.sameItemSameComponents(t, s) && t.count + (ignoreCount ? 0 : s.count) <= this.max(s);
    }
    resetQC() { this.qc = { status: 0, type: 0, slots: [] }; }
    click(slot, button, mode) {
        if (mode === 5) return this.quickCraft(slot, button);
        if (this.qc.status !== 0) { this.resetQC(); return; }
        if ((mode === 0 || mode === 1) && (button === 0 || button === 1)) {
            const primary = button === 0;
            if (slot === -999) {
                if (!I.isEmpty(this.carried)) { if (primary) { this.drops.push(this.carried); this.carried = null; } else { this.drops.push(I.copy(this.carried, 1)); this.carried = this.carried.count > 1 ? I.copy(this.carried, this.carried.count - 1) : null; } }
                return;
            }
            if (slot < 0 || slot >= this.size) return;
            if (mode === 1) {
                if (!this.mayPickup(slot)) return;
                let r = this.quickMove(slot);
                for (let guard = 0; !I.isEmpty(r) && I.sameItem(this.slots[slot], r) && guard < 64; guard++) r = this.quickMove(slot);
                return;
            }
            const st = this.slots[slot], c = this.carried;
            if (I.isEmpty(st)) {
                if (!I.isEmpty(c)) this.carried = this.safeInsert(slot, c, primary ? c.count : 1);
            } else if (this.mayPickup(slot)) {
                if (I.isEmpty(c)) {
                    const got = this.tryRemove(slot, primary ? st.count : Math.floor((st.count + 1) / 2), Infinity);
                    if (got) this.carried = got;
                } else if (this.mayPlace(slot, c)) {
                    if (I.sameItemSameComponents(st, c)) this.carried = this.safeInsert(slot, c, primary ? c.count : 1);
                    else if (c.count <= this.slotMax(slot, c)) { this.carried = st; this.slots[slot] = c; }
                } else if (I.sameItemSameComponents(st, c)) {
                    const got = this.tryRemove(slot, st.count, this.max(c) - c.count);
                    if (got) this.carried = I.copy(c, c.count + got.count);
                }
            }
            return;
        }
        if (mode === 2 && ((button >= 0 && button < 9) || button === 40)) {
            if (slot < 0 || slot >= this.size) return;
            const [get, set] = this.hotbarRef(button), h = get(), st = this.slots[slot];
            if (I.isEmpty(h) && I.isEmpty(st)) return;
            if (I.isEmpty(h)) { if (this.mayPickup(slot)) { set(st); this.slots[slot] = null; this.onTake(slot, st); } }
            else if (I.isEmpty(st)) {
                if (this.mayPlace(slot, h)) { const o = this.slotMax(slot, h); if (h.count > o) { this.slots[slot] = I.copy(h, o); set(I.copy(h, h.count - o)); } else { set(null); this.slots[slot] = h; } }
            } else if (this.mayPickup(slot) && this.mayPlace(slot, h)) {
                const o = this.slotMax(slot, h);
                if (h.count > o) { this.slots[slot] = I.copy(h, o); set(I.copy(h, h.count - o)); this.onTake(slot, st); this.addToInventory(st); }
                else { set(st); this.slots[slot] = h; this.onTake(slot, st); }
            }
            return;
        }
        if (mode === 3) return;                                              // CLONE: creative only
        if (mode === 4 && I.isEmpty(this.carried) && slot >= 0 && slot < this.size) {
            const st = this.slots[slot]; if (I.isEmpty(st)) return;
            const got = this.tryRemove(slot, button === 0 ? 1 : st.count, Infinity);
            if (got) this.drops.push(got);
            return;
        }
        if (mode === 6 && slot >= 0 && slot < this.size) {
            const c = this.carried;
            if (I.isEmpty(c) || (!I.isEmpty(this.slots[slot]) && this.mayPickup(slot))) return;
            const k = button === 0 ? 0 : this.size - 1, o = button === 0 ? 1 : -1;
            for (let pass = 0; pass < 2; pass++) {
                for (let p = k; p >= 0 && p < this.size && c.count < this.max(c); p += o) {
                    const t = this.slots[p];
                    if (I.isEmpty(t) || !this.canQuickReplace(p, c, true) || !this.mayPickup(p) || (this.kind(p) === 'result' && /crafting|player/.test(this.L.type))) continue;
                    if (pass !== 0 || t.count !== this.max(t)) { const got = this.tryRemove(p, t.count, this.max(c) - c.count); if (got) c.count += got.count; }
                }
            }
        }
    }
    /** Inventory.add, simplified: stack onto a matching stack of the 36 slots, else the first empty one, else drop. */
    addToInventory(s) {
        const a = this.L.invStart, b = a + 36;
        if (!this.moveTo(s, a, b, false) || !I.isEmpty(s)) if (!I.isEmpty(s)) this.drops.push(s);
    }
    quickCraft(slot, button) {
        const prev = this.qc.status, stage = button & 3, type = (button >> 2) & 3;
        this.qc.status = stage;
        if ((prev !== 1 || stage !== 2) && prev !== stage) { this.resetQC(); return; }
        if (I.isEmpty(this.carried)) { this.resetQC(); return; }
        if (stage === 0) { if (type === 0 || type === 1) { this.qc = { status: 1, type, slots: [] }; } else this.resetQC(); return; }
        if (stage === 1) {
            if (slot < 0 || slot >= this.size) return;
            const c = this.carried;
            const dragOk = !(this.kind(slot) === 'result');
            if (this.canQuickReplace(slot, c, true) && this.mayPlace(slot, c) && (this.qc.type === 2 || c.count > this.qc.slots.length) && dragOk && !this.qc.slots.includes(slot)) this.qc.slots.push(slot);
            return;
        }
        if (stage === 2) {
            const list = this.qc.slots, t = this.qc.type;
            if (list.length === 1) { const k = list[0]; this.resetQC(); this.click(k, t, 0); return; }
            if (list.length) {
                const s2 = I.copy(this.carried); let l = this.carried.count;
                for (const p of list) {
                    const c = this.carried;
                    if (this.canQuickReplace(p, c, true) && this.mayPlace(p, c) && (t === 2 || c.count >= list.length)) {
                        const m = I.isEmpty(this.slots[p]) ? 0 : this.slots[p].count, cap = Math.min(this.max(s2), this.slotMax(p, s2));
                        const o = Math.min((t === 0 ? Math.floor(s2.count / list.length) : t === 1 ? 1 : this.max(s2)) + m, cap);
                        l -= o - m;
                        this.slots[p] = I.copy(s2, o);
                    }
                }
                this.carried = l > 0 ? I.copy(s2, l) : null;
            }
            this.resetQC();
            return;
        }
        this.resetQC();
    }
}

/** The slots whose stacks differ between two menus (by item, count, components), and whether the carried stack differs. */
function diff(a, b) {
    const same = (x, y) => (I.isEmpty(x) && I.isEmpty(y)) || (I.sameItemSameComponents(x, y) && x.count === y.count);
    const slots = [];
    for (let i = 0; i < Math.max(a.slots.length, b.slots.length); i++) if (!same(a.slots[i], b.slots[i])) slots.push(i);
    return { slots, carried: !same(a.carried, b.carried) };
}

module.exports = { Menu, layout, diff, equipmentOf, isFuel, isShulker, SMELTABLE };
