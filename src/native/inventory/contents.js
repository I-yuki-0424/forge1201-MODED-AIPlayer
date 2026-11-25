'use strict';
// Container contents as a goal (TASK-20261125-076, owner Large 3.4): what a blueprint's block entity holds (Litematica / structure files keep the
// `Items` list), the comparator signal a container gives, the contents that give a chosen signal, and the clicks that turn what a container holds
// into the goal with items from the player's own slots. The clicks are planned on a copy of the menu with the game's rules (menu.js), so the plan is
// what the server will compute; the instruction (src/skills/commands/container.js) sends them and grades the result from the server's window contents.
const I = require('./items');

const bare = (n) => String(n || '').replace(/^minecraft:/, '');

/**
 * The `Items` of a block entity (prismarine-nbt typed compound, or an already simplified object) as [{slot, item, count, comp}], sorted by slot.
 * Reads both layouts: `count` (int, 1.20.5+) and `Count` (byte, before); `components` (1.20.5+) or `tag` (before) become `comp`.
 */
function fromBlockEntity(be) {
    if (!be) return [];
    let o = be;
    if (be.type === 'compound' || (be.value && be.type)) o = require('prismarine-nbt').simplify(be);
    const items = Array.isArray(o.Items) ? o.Items : [];
    const out = [];
    for (const it of items) {
        if (!it || !it.id) continue;
        const slot = Number(it.Slot), count = Number(it.count ?? it.Count ?? 1);
        if (!Number.isInteger(slot) || slot < 0 || !(count > 0)) continue;
        const extra = it.components ?? it.tag;
        out.push({ slot, item: bare(it.id), count, comp: extra === undefined ? '' : I.canon(extra) });
    }
    return out.sort((a, b) => a.slot - b.slot);
}

/** AbstractContainerMenu.getRedstoneSignalFromContainer: 1 + floor(14 * fullness) for a non-empty container, 0 for an empty one (float maths). */
function signalOf(contents, size, maxStackOf) {
    const f = Math.fround;
    let full = f(0);
    for (const c of contents) if (c && c.count > 0) full = f(full + f(f(c.count) / f(Math.min(99, maxStackOf(c.item)))));
    full = f(full / f(size));
    return Math.floor(f(full * 14)) + (full > 0 ? 1 : 0);
}

/**
 * The fewest items of `item` (stacks of `maxStack`) that give `strength` in a container of `size` slots, laid out from slot 0: full stacks, then the rest.
 * Strength 0 is an empty container. Throws when the strength cannot be reached with that item.
 */
function contentsForSignal({ size, item, maxStack = 64, strength }) {
    if (!Number.isInteger(strength) || strength < 0 || strength > 15) throw new Error('strength 0..15');
    if (strength === 0) return [];
    const ms = () => maxStack;
    for (let n = 1; n <= size * maxStack; n++) {
        const c = []; let left = n;
        for (let s = 0; s < size && left > 0; s++) { const k = Math.min(left, maxStack); c.push({ slot: s, item, count: k, comp: '' }); left -= k; }
        const got = signalOf(c, size, ms);
        if (got === strength) return c;
        if (got > strength) break;
    }
    throw new Error(`${item} cannot give strength ${strength} in ${size} slots`);
}

/**
 * The clicks (window slot, button, mode) that make the container part of `menu` (a Menu of the open container) hold `goal` ([{slot, item, count, comp?}];
 * slots not named are left alone, or emptied with `exact`), using the player's slots of the same menu. Planned on a copy, so the plan is checked against
 * the rules before anything is sent. Returns { clicks, menu (the predicted end state), missing: [{item, need}], noRoom: bool }.
 */
function planClicks(menu, goal, { exact = false } = {}) {
    const m = menu.clone(), n = m.L.n, inv0 = m.L.invStart, invEnd = inv0 + 36, clicks = [];
    const click = (s, b, md) => { m.click(s, b, md); clicks.push([s, b, md]); };
    const want = new Map(goal.map((g) => [g.slot, g]));
    const isGoal = (st, g) => st && st.name === g.item && (st.comp || '') === (g.comp || '');
    const missing = [];
    let noRoom = false;
    // somewhere in the player's slots for the carried stack: onto the same item with room, else an empty slot
    const stow = () => {
        for (let guard = 0; !I.isEmpty(m.carried) && guard < 40; guard++) {
            let at = -1;
            for (let i = inv0; i < invEnd && at < 0; i++) { const s = m.slots[i]; if (s && I.sameItemSameComponents(s, m.carried) && s.count < m.max(s)) at = i; }
            for (let i = inv0; i < invEnd && at < 0; i++) if (I.isEmpty(m.slots[i])) at = i;
            if (at < 0) { noRoom = true; return; }
            click(at, 0, 0);
        }
    };
    if (!I.isEmpty(m.carried)) stow();
    for (let i = 0; i < n; i++) {
        const g = want.get(i), cur = m.slots[i];
        if (I.isEmpty(cur)) continue;
        if ((!g && exact) || (g && !isGoal(cur, g))) {
            click(i, 0, 1);                                                     // shift-click it into the pack
            if (!I.isEmpty(m.slots[i])) { noRoom = true; return { clicks, menu: m, missing, noRoom }; }
        } else if (g && cur.count > g.count) {
            click(i, 0, 0);                                                     // take it all, give back one by one
            for (let k = 0; k < g.count; k++) click(i, 1, 0);
            stow();
            if (noRoom) return { clicks, menu: m, missing, noRoom };
        }
    }
    for (const g of goal) {
        if (g.slot < 0 || g.slot >= n) continue;
        let need = g.count - (isGoal(m.slots[g.slot], g) ? m.slots[g.slot].count : 0);
        for (let guard = 0; need > 0 && guard < 200; guard++) {
            const srcs = [];
            for (let i = inv0; i < invEnd; i++) if (isGoal(m.slots[i], g)) srcs.push(i);
            if (!srcs.length) { missing.push({ item: g.item, need }); break; }
            // a stack no larger than what is needed (largest first) is placed whole; else the smallest larger one gives `need` one by one
            const whole = srcs.filter((i) => m.slots[i].count <= need).sort((a, b) => m.slots[b].count - m.slots[a].count)[0];
            const src = whole !== undefined ? whole : srcs.sort((a, b) => m.slots[a].count - m.slots[b].count)[0];
            click(src, 0, 0);
            if (whole !== undefined) click(g.slot, 0, 0);
            else for (let k = 0; k < need; k++) click(g.slot, 1, 0);
            if (!I.isEmpty(m.carried)) click(src, 0, 0);                       // the rest back where it came from (the slot is empty or the same item)
            if (!I.isEmpty(m.carried)) stow();
            const now = isGoal(m.slots[g.slot], g) ? m.slots[g.slot].count : 0;
            if (g.count - now >= need) { missing.push({ item: g.item, need, why: 'the slot takes no more' }); break; }
            need = g.count - now;
        }
    }
    return { clicks, menu: m, missing, noRoom };
}

/** Does the container part of `menu` hold `goal` (and, with `exact`, nothing else)? Returns [] or the differing slots {slot, want, have}. */
function compare(menu, goal, { exact = false } = {}) {
    const n = menu.L.n, want = new Map(goal.map((g) => [g.slot, g])), out = [];
    for (let i = 0; i < n; i++) {
        const g = want.get(i), s = menu.slots[i];
        const have = I.isEmpty(s) ? null : { item: s.name, count: s.count, comp: s.comp || '' };
        if (g) { if (!have || have.item !== g.item || have.count !== g.count || have.comp !== (g.comp || '')) out.push({ slot: i, want: { item: g.item, count: g.count }, have }); }
        else if (exact && have) out.push({ slot: i, want: null, have });
    }
    return out;
}

module.exports = { fromBlockEntity, signalOf, contentsForSignal, planClicks, compare };
