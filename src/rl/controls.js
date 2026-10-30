'use strict';
// Applies one action of the RL action space to a Mineflayer bot, tick by tick.
// The environment owns the clock (it enables physics for `ticks_per_step` ticks), so everything here advances per
// physics tick and never on wall-clock timers: digging is the one place where Mineflayer's own `bot.dig` uses a timer,
// hence the tick-counted digger below.
const Vec3 = require('vec3');
const { keySchedule, validate } = require('./action_spec');

const MOVE_KEYS = { forward: 'forward', back: 'back', left: 'left', right: 'right', jump: 'jump', sprint: 'sprint', sneak: 'sneak' };
const FACE_VEC = { 0: [0, -1, 0], 1: [0, 1, 0], 2: [0, 0, -1], 3: [0, 0, 1], 4: [-1, 0, 0], 5: [1, 0, 0] };
const DIG_REACH = 4.5;
const ATTACK_REACH = 3;
const ATTACK_COOLDOWN_TICKS = 10;

class Controls {
    constructor(bot, spec, mcData) {
        this.bot = bot; this.spec = spec; this.mcData = mcData;
        this.schedule = []; this.dig = null; this.placing = false; this.cooldown = 0; this.activated = false;
    }

    /** Tick 0 of a step: look, hotbar and the first key state. */
    begin(action) {
        validate(this.spec, action);
        this.action = action;
        this.schedule = keySchedule(this.spec, action);
        const b = this.bot;
        if ('yaw_delta_deg' in action || 'pitch_delta_deg' in action) {
            // Signs follow the F3 screen: yaw_delta_deg > 0 turns right, pitch_delta_deg > 0 looks down (Mineflayer's are the opposite).
            const dy = ((action.yaw_delta_deg || 0) * Math.PI) / 180, dp = ((action.pitch_delta_deg || 0) * Math.PI) / 180;
            const pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, b.entity.pitch - dp));
            if (dy || dp) b.look(b.entity.yaw - dy, pitch, true).catch(() => {});
        }
        if ('hotbar' in action && action.hotbar > 0) b.setQuickBarSlot(action.hotbar - 1);
        this.tick(0);
    }

    /** Set the keys for tick `t` of the current step; called before the physics tick `t` runs. */
    tick(t) {
        const keys = this.schedule[t];
        for (const k of Object.keys(MOVE_KEYS)) if (k in keys) this.bot.setControlState(MOVE_KEYS[k], keys[k]);
        if ('attack' in keys) this._attack(keys.attack);
        if ('use' in keys) this._use(keys.use);
        if (this.cooldown > 0) this.cooldown--;
    }

    /** All keys up and digging cancelled (used at reset and when the run ends). */
    release() {
        for (const k of Object.values(MOVE_KEYS)) this.bot.setControlState(k, false);
        this._cancelDig();
        if (this.activated) { this.bot.deactivateItem(); this.activated = false; }
    }

    _cancelDig() {
        if (!this.dig) return;
        this.bot._client.write('block_dig', { status: 1, location: this.dig.block.position, face: 0 });
        this.dig = null;
    }

    _attack(down) {
        const b = this.bot;
        if (!down) return this._cancelDig();
        const block = b.blockAtCursor(DIG_REACH);
        const sameTarget = this.dig && block && block.position.equals(this.dig.block.position);
        if (this.dig && !sameTarget) this._cancelDig();
        if (this.dig) {
            b.swingArm();
            if (--this.dig.ticks <= 0) this._finishDig();
            return;
        }
        if (block && b.canDigBlock(block)) {
            const ms = b.digTime(block);
            if (!Number.isFinite(ms)) return;
            b._client.write('block_dig', { status: 0, location: block.position, face: block.face });
            b.swingArm();
            this.dig = { block, face: block.face, ticks: Math.max(1, Math.ceil(ms / 50)) };
            if (this.dig.ticks <= 1) this._finishDig();
            return;
        }
        const ent = !block || block.intersect.distanceTo(b.entity.position) > ATTACK_REACH ? b.entityAtCursor(ATTACK_REACH) : null;
        if (ent && this.cooldown === 0) { b.attack(ent); this.cooldown = ATTACK_COOLDOWN_TICKS; }
    }

    _finishDig() {
        const { block, face } = this.dig;
        this.bot._client.write('block_dig', { status: 2, location: block.position, face });
        this.bot._updateBlockState(block.position, 0);
        this.dig = null;
    }

    _use(down) {
        const b = this.bot;
        if (!down) {
            if (this.activated) { b.deactivateItem(); this.activated = false; }
            return;
        }
        if (this.activated || this.placing) return;
        const held = b.heldItem;
        if (!held) return;
        const block = b.blockAtCursor(DIG_REACH);
        if (block && this.mcData.blocksByName[held.name] && FACE_VEC[block.face]) {
            this.placing = true;
            const [x, y, z] = FACE_VEC[block.face];
            b.placeBlock(block, new Vec3(x, y, z))
                .catch(() => {}).finally(() => { this.placing = false; });
        } else {
            b.activateItem();
            this.activated = true;
        }
    }
}

module.exports = { Controls };
