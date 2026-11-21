'use strict';
// One bot's hands in creative mode, as packets: an item into the hotbar (the creative inventory, what pick-block does), a look that the server has before the next packet, sneak,
// a use on a block face (a placement into the air or a click on a block), a break (creative: one packet), a use of the held item (buckets), and the read-back of a cell.
const { Vec3 } = require('vec3');
const R = require('./rules');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMPTY_SLOT = 8;
const LOOK_MS = 80;                   // one server tick and a margin                 // kept empty: clicks on blocks (note blocks, repeaters, gates) with nothing in hand

/** The hand of one bot. */
class Hand {
    constructor(bot) {
        this.bot = bot;
        this.seq = 1;
        this.slots = Array.from({ length: 9 }, (_, i) => { const it = bot.inventory && bot.inventory.slots[36 + i]; return it ? it.name : null; });       // what each hotbar slot holds, kept by the hand (no wait for the server's echo)
        this.lru = [0, 1, 2, 3, 4, 5, 6, 7];
        this.sneaking = false;
        this.aimed = null;
        this.Item = require('prismarine-item')(bot.registry);
    }

    /** Put `item` (a name) into a hotbar slot and select it. The creative slot packet and the selection reach the server before the next use packet. */
    hold(item) {
        const b = this.bot;
        let slot = item === null ? EMPTY_SLOT : this.slots.indexOf(item);
        if (item !== null && slot < 0) {
            const def = b.registry.itemsByName[item];
            if (!def) throw new Error(`no item ${item}`);
            slot = this.lru.shift(); this.lru.push(slot);
            const it = new this.Item(def.id, 1);
            b._client.write('set_creative_slot', { slot: 36 + slot, item: this.Item.toNotch(it) });
            this.slots[slot] = item;
        } else if (item !== null) { this.lru.splice(this.lru.indexOf(slot), 1); this.lru.push(slot); }
        if (item === null && this.slots[EMPTY_SLOT] !== null) { b._client.write('set_creative_slot', { slot: 36 + EMPTY_SLOT, item: this.Item.toNotch(null) }); this.slots[EMPTY_SLOT] = null; }
        if (b.quickBarSlot !== slot) b.setQuickBarSlot(slot);
    }

    /**
     * Look and sneak for the next uses. The server applies a new rotation (and the sneak input) one tick after it arrives (look_probe.js, 2026-11-21: a use sent in the same tick was
     * judged with the previous look, 0 of 24; one tick later 24 of 24), so a change costs one tick and uses that share a look share it (the builder groups them).
     */
    async aim(spec, sneak = false) {
        const a = R.lookAngles(spec); if (spec && spec.yaw16 !== undefined) a.yaw = Math.PI - (spec.yaw16 * Math.PI) / 8;
        const k = `${a.yaw.toFixed(4)},${a.pitch.toFixed(4)},${!!sneak}`;
        if (k === this.aimed) return;
        const b = this.bot, p = b.entity.position;
        b.look(a.yaw, a.pitch, true).catch(() => {});
        b.entity.yaw = a.yaw; b.entity.pitch = a.pitch;
        b._client.write('position_look', { x: p.x, y: p.y, z: p.z, yaw: (180 - (a.yaw * 180) / Math.PI) % 360, pitch: (-a.pitch * 180) / Math.PI, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } });
        if (this.sneaking !== !!sneak) { b.setControlState('sneak', !!sneak); this.sneaking = !!sneak; }
        this.aimed = k;
        await sleep(LOOK_MS);
    }
    async aimAngles(yaw, pitch) {
        const b = this.bot, p = b.entity.position;
        b.look(yaw, pitch, true).catch(() => {}); b.entity.yaw = yaw; b.entity.pitch = pitch;
        b._client.write('position_look', { x: p.x, y: p.y, z: p.z, yaw: (180 - (yaw * 180) / Math.PI) % 360, pitch: (-pitch * 180) / Math.PI, onGround: false, flags: { onGround: false, hasHorizontalCollision: false } });
        if (this.sneaking) { b.setControlState('sneak', false); this.sneaking = false; }
        this.aimed = null;
        await sleep(LOOK_MS);
    }
    /** A key for grouping recipes by the aim they need. */
    static aimKey(r) { const a = R.lookAngles(r.look); return `${a.yaw.toFixed(4)},${a.pitch.toFixed(4)},${!!r.sneak}`; }
    /** The bot moved: the aim is whatever mineflayer sends now. */
    moved() { this.aimed = null; }

    /** A use packet on face `face` of cell `c` with the hit point c + cursor. Into the air when the cell is empty (the server replaces it), a click on the block when it holds one. */
    use(c, face, cursor = [0.5, 0.5, 0.5]) {
        this.bot._client.write('block_place', { hand: 0, location: new Vec3(c.x, c.y, c.z), direction: face, cursorX: cursor[0], cursorY: cursor[1], cursorZ: cursor[2], insideBlock: false, worldBorderHit: false, sequence: this.seq++ });
        this.bot.swingArm();
    }

    /** Break the block at `c` (creative: the start packet breaks it). Nothing must be held that cannot break blocks in creative (swords, tridents, maces): the hand is emptied. */
    dig(c, face = 1) {
        this.hold(null);
        this.bot._client.write('block_dig', { status: 0, location: new Vec3(c.x, c.y, c.z), face, sequence: this.seq++ });
        this.bot.swingArm();
    }

    /** Use the held item into the air with the given rotation (buckets: the server traces the ray itself from the eyes). */
    async useItem(yaw, pitch) {
        await this.aimAngles(yaw, pitch);
        this.bot._client.write('use_item', { hand: 0, sequence: this.seq++, rotation: { x: (180 - (yaw * 180) / Math.PI) % 360, y: (-pitch * 180) / Math.PI } });
        this.bot.swingArm();
    }

    /** A placement by recipe `r` at cell `c` (the aim set before: `aim(r.look, r.sneak)`): hold, use, the second use of a double slab, the extra uses of candles and pickles. */
    place(c, r) {
        this.hold(r.item);
        this.use(c, r.face, r.cursor);
        if (r.again) this.use(c, r.again.face, [0.5, 0.99, 0.5]);
        for (let k = 0; k < (r.repeat || 0); k++) this.use(c, 1, [0.5, 0.99, 0.5]);
    }

    /** `n` right-clicks on the block at `c` with an empty hand (aim first: no sneak; a fence gate opens away from the player). */
    click(c, n) {
        this.hold(null);
        for (let i = 0; i < n; i++) this.use(c, 1, [0.5, 0.99, 0.5]);
    }
}

/** The state the bot sees at a cell: {name, props (strings)} or null when the chunk is not loaded. */
const AIR_SEEN = Object.freeze({ name: 'air', props: Object.freeze({}), shape: 'empty' });
function seen(bot, c) {
    const b = bot.blockAt(new Vec3(c.x, c.y, c.z), false);
    if (!b) return null;
    if (b.name === 'air') return AIR_SEEN;                      // most of a box: no property object to build
    const p = {}; for (const [k, v] of Object.entries(b.getProperties())) p[k] = String(v);
    return { name: b.name, props: p, shape: b.boundingBox };
}

/** Wait until the cell satisfies `ok(state)` or `ms` pass; returns the last state. */
async function settle(bot, c, ok, ms = 600) {
    const t0 = Date.now();
    let s = seen(bot, c);
    while (!(s && ok(s)) && Date.now() - t0 < ms) { await sleep(25); s = seen(bot, c); }
    return s;
}

/** Eye position of a body with its feet at `p` (flying: no crouch, even with sneak). */
const eyeOf = (p) => new Vec3(p.x, p.y + 1.62, p.z);
/** Distance from an eye to the nearest point of cell c's box (the server's reach test is box distance < range + 1). */
function boxDist(eye, c) {
    const dx = Math.max(c.x - eye.x, 0, eye.x - (c.x + 1)), dy = Math.max(c.y - eye.y, 0, eye.y - (c.y + 1)), dz = Math.max(c.z - eye.z, 0, eye.z - (c.z + 1));
    return Math.hypot(dx, dy, dz);
}

module.exports = { Hand, seen, settle, eyeOf, boxDist, sleep, EMPTY_SLOT };
