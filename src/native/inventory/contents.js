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

// containers whose block entity `Items` the build sets (the screens set_contents can fill)
const CONTAINER = /^(chest|trapped_chest|barrel|hopper|dropper|dispenser|(?:[a-z]+_)?shulker_box)$/;

// A chest joined to its neighbour: the block's `type` names the half and the neighbour lies to the facing's clockwise side for `left`, counter-clockwise for `right`
// (ChestBlock.getConnectedDirection); the double screen shows the RIGHT half's 27 slots first, then the left half's (ChestBlock.getBlockType: RIGHT = FIRST,
// DoubleBlockCombiner: acceptDouble(first, second) -> CompoundContainer(first, second)), whichever half is clicked.
const STEP = { north: [0, -1], east: [1, 0], south: [0, 1], west: [-1, 0] };
const CW = { north: 'east', east: 'south', south: 'west', west: 'north' }, CCW = { north: 'west', west: 'south', south: 'east', east: 'north' };
function chestHalf(b, p) {
    const t = p.props && p.props.type, f = p.props && p.props.facing;
    if (!/^(chest|trapped_chest)$/.test(bare(p.name)) || (t !== 'left' && t !== 'right') || !STEP[f]) return null;
    const [dx, dz] = STEP[(t === 'left' ? CW : CCW)[f]];
    return { first: t === 'right', partner: `${b.x + dx},${b.y},${b.z + dz}` };
}

/**
 * THE BUILD JOB'S HOOK (TASK-20261125-076 for 075/081): the containers of a blueprint (src/work/jobs/blueprint.js form: { palette, blocks: [{x, y, z, s, nbt?}] }:
 * litematic.js keeps every block entity's typed NBT in `nbt` through parse, toBlueprint and place, rotation and mirror included) whose block entity holds items, as
 * set_contents goals in world cells (`origin` = the world cell of the blueprint's 0,0,0). The two halves of a double chest are ONE goal of 54 slots at the right
 * half's cell (one screen; with `exact` a goal per half would empty the other half). After the build has placed such a block (and before the cells that cover its
 * face close in), it runs `{name: 'set_contents', args}` through the router (env.command); the items come from the build's supply like its blocks: add
 * `containerMaterials(bp)` to the material list. A stack with components (a named item, a filled shulker box) is not made by a bot: left out of the goal and
 * counted in `skipped`.
 */
function blueprintContainers(bp, origin = { x: 0, y: 0, z: 0 }) {
    const out = [], at = new Map((bp.blocks || []).map((b) => [`${b.x},${b.y},${b.z}`, b])), done = new Set();
    const itemsOf = (b) => { const all = b && b.nbt ? fromBlockEntity(b.nbt) : []; return { keep: all.filter((c) => !c.comp), skipped: all.length - all.filter((c) => !c.comp).length }; };
    for (const b of bp.blocks || []) {
        const key = `${b.x},${b.y},${b.z}`;
        if (done.has(key)) continue;
        const p = bp.palette[b.s], name = bare(p && p.name);
        if (!CONTAINER.test(name)) continue;
        let cell = b, contents, skipped, double = false;
        const half = chestHalf(b, p), other = half && at.get(half.partner);
        const op = other && bp.palette[other.s], oh = other && chestHalf(other, op);
        if (oh && bare(op.name) === name && oh.first !== half.first && oh.partner === key) {
            done.add(half.partner); double = true;
            const [first, second] = half.first ? [b, other] : [other, b], a = itemsOf(first), c = itemsOf(second);
            cell = first; contents = [...a.keep, ...c.keep.map((s) => ({ ...s, slot: s.slot + 27 }))]; skipped = a.skipped + c.skipped;
        } else ({ keep: contents, skipped } = itemsOf(b));
        if (!contents.length) continue;
        const x = origin.x + cell.x, y = origin.y + cell.y, z = origin.z + cell.z;
        out.push({ x, y, z, block: name, ...(double ? { double: true } : {}), ...(skipped ? { skipped } : {}), args: { x, y, z, contents: contents.map(({ slot, item, count }) => ({ slot, item, count })), exact: true } });
    }
    return out;
}

/** The items the containers of a blueprint hold, per item: [{item, n}] (to add to the build's material list). */
function containerMaterials(bp) {
    const m = new Map();
    for (const g of blueprintContainers(bp)) for (const c of g.args.contents) m.set(c.item, (m.get(c.item) || 0) + c.count);
    return [...m].map(([item, n]) => ({ item, n })).sort((a, b) => b.n - a.n);
}

module.exports = { fromBlockEntity, signalOf, contentsForSignal, planClicks, compare, blueprintContainers, containerMaterials, CONTAINER };
