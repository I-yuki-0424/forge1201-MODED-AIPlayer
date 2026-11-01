'use strict';
// The body: applies one frame of player input per physics tick. A frame is what a person holds or presses during one
// tick, nothing more:
//   forward back left right jump sprint sneak   movement keys (held = true)
//   attack use                                  left / right mouse button (held = true; edges matter)
//   yaw pitch                                   absolute look (Mineflayer radians); omitted = unchanged
//   hotbar                                      0..8 selected hotbar slot; omitted = unchanged
//   drop ('one'|'stack'), swap (true)           the Q and F keys, pressed this tick
// Keys not named in a frame are released. Every command in src/skills/commands is a sequence of frames plus waits,
// so this file is the only place where input becomes packets (window clicks excepted: commands/gui.js).
const Vec3 = require('vec3');
const { isInteractive, fromBot } = require('./world');
const { EYE, BLOCK_REACH, ENTITY_REACH, FACES, viewDir, raycast, rayBox, entityBox } = require('./geometry');

const MOVE = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'];
// After a finish-dig packet the client waits this long for the server's verdict before it may start the same block again.
const DIG_CONFIRM_TICKS = 20;
const SNEAK_EYE = 1.27;
// Entities the crosshair passes through (vanilla cannot hit them either).
const UNHITTABLE = new Set(['item', 'experience_orb', 'arrow', 'spectral_arrow', 'trident', 'snowball', 'egg', 'ender_pearl',
    'fishing_bobber', 'area_effect_cloud', 'marker', 'falling_block', 'item_display', 'block_display', 'text_display', 'interaction']);

class Body {
    constructor(bot) {
        this.bot = bot;
        this.prev = {};        // last applied frame (for press edges)
        this.dig = null;       // {pos, face, left, finished}
        this.using = false;    // an item is in use (eating, drawing a bow)
        this.tickNo = 0;
    }

    /** What the crosshair hits: {kind:'block', block, face, point, dist} | {kind:'entity', entity, dist} | null. */
    crosshair() {
        const b = this.bot, e = b.entity;
        const eye = this.eye();
        const d = viewDir(e.yaw, e.pitch);
        const hit = raycast(eye, d, BLOCK_REACH, fromBot(b).shapesAt);
        const ent = this.entityOnRay(eye, d, Math.min(ENTITY_REACH, hit ? hit.t : ENTITY_REACH));
        if (ent) return ent;
        if (!hit) return null;
        const block = b.blockAt(new Vec3(hit.x, hit.y, hit.z));
        return { kind: 'block', block, face: hit.face, point: hit.point, dist: hit.t };
    }

    /** Eye position as the server computes it (sneaking lowers the eye). */
    eye() {
        const p = this.bot.entity.position;
        return { x: p.x, y: p.y + (this.bot.getControlState('sneak') ? SNEAK_EYE : EYE), z: p.z };
    }

    /** Nearest hittable entity whose box the ray from `eye` along unit `d` enters within `maxDist`, as a crosshair hit. */
    entityOnRay(eye, d, maxDist) {
        let best = null;
        for (const ent of Object.values(this.bot.entities)) {
            if (ent === this.bot.entity || !ent.position || UNHITTABLE.has(ent.name)) continue;
            const r = rayBox(eye, d, entityBox(ent.position, ent.width || 0.6, ent.height || 1.8));
            if (r && r.t <= maxDist && (!best || r.t < best.dist)) best = { kind: 'entity', entity: ent, dist: r.t };
        }
        return best;
    }

    /** Apply `frame` now; it governs the next physics tick. */
    apply(frame) {
        const b = this.bot, prev = this.prev;
        this.tickNo++;
        if (Number.isInteger(frame.hotbar) && frame.hotbar !== b.quickBarSlot) b.setQuickBarSlot(frame.hotbar);
        if (frame.yaw !== undefined || frame.pitch !== undefined) {
            const yaw = frame.yaw ?? b.entity.yaw, pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, frame.pitch ?? b.entity.pitch));
            if (yaw !== b.entity.yaw || pitch !== b.entity.pitch) b.look(yaw, pitch, true).catch(() => {});
        }
        for (const k of MOVE) {
            const v = !!frame[k];
            if (b.getControlState(k) !== v) b.setControlState(k, v);
        }
        if (frame.drop) this._dropHeld(frame.drop === 'stack');
        if (frame.swap) this._swapHands();
        this._attack(!!frame.attack, !prev.attack);
        this._use(!!frame.use, !prev.use);
        this.prev = { ...frame };
    }

    /** All keys up, digging and item use stopped. */
    release() {
        this.apply({});
        this._cancelDig();
    }

    _send(name, data) { this.bot._client.write(name, data); }

    // Q and F change the inventory on the server without a slot update back (the vanilla client predicts them; measured
    // 2026-10-31: after Q the server had 40 of 41 dirt and sent nothing). The client copy is updated here the same way.
    _dropHeld(stack) {
        const inv = this.bot.inventory, slot = inv.hotbarStart + this.bot.quickBarSlot, item = inv.slots[slot];
        this._send('block_dig', { status: stack ? 3 : 4, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 });
        if (!item) return;
        if (stack || item.count <= 1) inv.updateSlot(slot, null);
        else { item.count--; inv.updateSlot(slot, item); }
    }

    _swapHands() {
        const inv = this.bot.inventory, main = inv.hotbarStart + this.bot.quickBarSlot, off = 45;
        this._send('block_dig', { status: 6, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 });
        const a = inv.slots[main], b = inv.slots[off];
        inv.updateSlot(main, b); inv.updateSlot(off, a);
    }

    _cancelDig() {
        if (!this.dig) return;
        if (!this.dig.finished) this._send('block_dig', { status: 1, location: this.dig.pos, face: 0, sequence: 0 });
        this.dig = null;
    }

    _attack(down, edge) {
        const b = this.bot;
        if (!down) return this._cancelDig();
        const target = this.crosshair();
        if (target && target.kind === 'entity') {
            this._cancelDig();
            if (edge) { b.attack(target.entity); }          // a held button does not repeat entity hits (vanilla)
            return;
        }
        const block = target && target.block;
        const same = this.dig && block && block.position.equals(this.dig.pos);
        if (this.dig && !same) this._cancelDig();
        if (this.dig) {
            if (this.dig.finished) {
                // Waiting for the server: the block update to air arrives as a normal block change. If it never comes the
                // server refused the break; start over.
                if (this.tickNo - this.dig.finished > DIG_CONFIRM_TICKS) this.dig = null;
                return;
            }
            b.swingArm();
            if (--this.dig.left <= 0) this._finishDig();
            return;
        }
        if (!block || !block.diggable) return;
        const ms = b.digTime(block);
        if (!Number.isFinite(ms)) return;
        this._send('block_dig', { status: 0, location: block.position, face: target.face, sequence: 0 });
        b.swingArm();
        // The server counts its own ticks from the start packet; one spare tick absorbs the network delay.
        this.dig = { pos: block.position.clone(), face: target.face, left: Math.ceil(ms / 50) + 1, finished: 0 };
        if (ms === 0) this._finishDig();                     // instant break (creative or insta-mine)
    }

    _finishDig() {
        this._send('block_dig', { status: 2, location: this.dig.pos, face: this.dig.face, sequence: 0 });
        this.dig.finished = this.tickNo;
    }

    _use(down, edge) {
        const b = this.bot;
        if (!down) {
            if (this.using) { b.deactivateItem(); this.using = false; }
            return;
        }
        if (!edge) return;                                    // held: an item already in use stays in use
        const target = this.crosshair();
        const held = b.heldItem;
        if (target && target.kind === 'block') {
            const p = target.block.position, h = target.point;
            this._send('block_place', { location: p, direction: target.face, hand: 0,
                cursorX: h.x - p.x, cursorY: h.y - p.y, cursorZ: h.z - p.z, insideBlock: false, sequence: 0 });
            b.swingArm();
            // Vanilla then also uses the item itself when the block did not consume the click: food, potions, bows.
            const placeable = held && b.registry.blocksByName[held.name];
            if (held && !placeable && !(isInteractive(target.block.name) && !b.getControlState('sneak'))) { b.activateItem(); this.using = true; }
            return;
        }
        if (target && target.kind === 'entity') {
            b.useOn(target.entity);
            return;
        }
        if (held) { b.activateItem(); this.using = true; }
    }
}

module.exports = { Body, FACES };
