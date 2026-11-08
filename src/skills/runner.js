'use strict';
// Runs one command on the live game clock and records what happened, tick by tick.
// A command is `async (ctx, args) => detail`: it advances the game only through ctx.tick(frame) (one physics tick with
// the given input frame, see body.js) and ends by returning (success) or by throwing SkillError(reason) with a reason
// from the closed list below. Nothing else ends a command: the runner turns budget overruns, death, disconnects and
// unexpected exceptions into reasons too, so every outcome is named.
const { Body } = require('./body');
const timeScale = require('../transport/time_scale');
const world = require('./world');

// Closed failure taxonomy shared by every command (docs/implemented/SKILLS-v1.md).
const REASONS = Object.freeze({
    invalid_args: 'arguments fail the command schema',
    invalid_target: 'the target does not exist or is not of the required kind or state',
    missing_item: 'a required item is not in the inventory',
    missing_tool: 'no tool in the inventory can harvest the block',
    missing_materials: 'the inventory lacks the ingredients or fuel',
    no_station: 'no crafting table / furnace / container within range',
    unreachable: 'no walking path to a position from which the target can be reached',
    stuck: 'a path exists but the bot stopped making progress along it',
    protected: 'the block is a fixture the owner placed (a chest, ender chest or shulker box the bot did not place, or a tagged block): it is never broken',
    not_visible: 'no unobstructed line from the eye to the target',
    not_confirmed: 'the input was sent but the server did not confirm the expected change',
    target_lost: 'the target entity disappeared without being killed or picked up',
    timeout: 'the tick budget of the command ran out',
    died: 'the bot died during the command',
    disconnected: 'the connection ended during the command',
    cancelled: 'the caller cancelled the command',
    internal: 'an unexpected exception (a bug: the trace holds the stack)',
});

class SkillError extends Error {
    constructor(reason, detail = {}) {
        if (!REASONS[reason]) throw new Error(`SkillError: unknown reason ${reason}`);
        super(`${reason}: ${REASONS[reason]}`);
        this.reason = reason; this.detail = detail;
    }
}

const TRACE_CAP = 6000;   // 5 minutes of ticks
const keyBits = (f) => ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak', 'attack', 'use'].map((k, i) => (f[k] ? 'FBLRJSNAU'[i] : '.')).join('');
const r3 = (v) => Math.round(v * 1000) / 1000;

class Ctx {
    constructor(bot, { maxTicks, cancel, onEvent }) {
        this.bot = bot;
        this.body = bot.__skillBody || (bot.__skillBody = new Body(bot));
        this.world = world.fromBot(bot);
        this.maxTicks = maxTicks; this.cancel = cancel || { cancelled: false }; this.onEvent = onEvent || (() => {});
        this.t = 0; this.trace = []; this.phases = []; this.phaseName = 'start';
        this.dead = false; this.ended = false;
        this._onDeath = () => { this.dead = true; };
        this._onEnd = () => { this.ended = true; };
        bot.on('death', this._onDeath); bot.on('end', this._onEnd);
    }

    dispose() { this.bot.removeListener('death', this._onDeath); this.bot.removeListener('end', this._onEnd); }

    /** Name the current step of the command (shows in the trace and the event log). */
    phase(name, data = {}) {
        this.phaseName = name;
        const ev = { t: this.t, phase: name, ...data };
        this.phases.push(ev);
        this.onEvent('phase', ev);
        if (this.bot.__onPhase) { try { this.bot.__onPhase(ev); } catch (_) { /* an observer (the work display) must not break a command */ } }
    }

    /** Apply `frame` and wait for the physics tick that uses it. */
    tick(frame = {}) {
        if (this.cancel.cancelled) throw new SkillError('cancelled');
        if (this.ended) throw new SkillError('disconnected');
        if (this.dead) throw new SkillError('died');
        if (this.t >= this.maxTicks) throw new SkillError('timeout', { ticks: this.t, phase: this.phaseName });
        this.body.apply(frame);
        const e = this.bot.entity;
        if (this.trace.length < TRACE_CAP) {
            this.trace.push([this.t, this.phaseName, keyBits(frame) + (frame.drop ? 'Q' : '') + (frame.swap ? 'X' : ''),
                r3(e.position.x), r3(e.position.y), r3(e.position.z), r3(e.velocity.x), r3(e.velocity.y), r3(e.velocity.z),
                r3(e.yaw), r3(e.pitch), e.onGround ? 1 : 0, this.bot.quickBarSlot]);
        }
        this.t++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.bot.removeListener('physicsTick', done); reject(new SkillError('disconnected', { why: 'no physics tick for 3 s' })); }, 3000);
            const done = () => { clearTimeout(timer); resolve(); };
            this.bot.once('physicsTick', done);
        });
    }

    /** `n` ticks with no keys (look unchanged). */
    async idle(n) { for (let i = 0; i < n; i++) await this.tick({}); }

    /**
     * Tick with `frame` until pred() holds; throws SkillError(reason) after `ticks`. Waits are mostly for the server's reply
     * (a window click, a block change, an item), which takes wall time, not ticks: with a faster clock (GAME_SPEED=k) the
     * budget is k times as many ticks (bench full-x2 #75: craft confirmation missed after 20 ticks = 0.5 s at 2x).
     */
    async until(pred, ticks, reason = 'not_confirmed', frame = {}) {
        ticks = Math.ceil(ticks * timeScale.scale);
        for (let i = 0; i < ticks; i++) {
            if (pred()) return i;
            await this.tick(typeof frame === 'function' ? frame() : frame);
        }
        if (pred()) return ticks;
        throw new SkillError(reason, { waited_ticks: ticks, phase: this.phaseName });
    }

    /** Await a promise (window clicks, window open) while the clock keeps ticking with an empty frame. */
    async during(promise, ticks, reason = 'not_confirmed') {
        let settled = false, value, error;
        promise.then((v) => { settled = true; value = v; }, (e) => { settled = true; error = e; });
        await this.until(() => settled, ticks, reason);
        if (error) throw error instanceof SkillError ? error : new SkillError(reason, { error: String(error.message || error).slice(0, 200) });
        return value;
    }
}

/**
 * Run `command` with `args` on `bot`. Resolves (never rejects) to
 * {ok, reason, detail, ticks, ms, phases, trace}; `trace` rows are
 * [t, phase, keys, x, y, z, vx, vy, vz, yaw, pitch, onGround, hotbar] (keys: FBLRJSNAU, Q drop, X swap).
 */
async function run(bot, command, args, { maxTicks = 1200, cancel, onEvent } = {}) {
    const ctx = new Ctx(bot, { maxTicks, cancel, onEvent });
    const t0 = Date.now();
    let out;
    try {
        const detail = await command(ctx, args);
        out = { ok: true, reason: null, detail: detail || {} };
    } catch (e) {
        if (e instanceof SkillError) out = { ok: false, reason: e.reason, detail: e.detail };
        else out = { ok: false, reason: 'internal', detail: { error: String(e && e.stack || e).slice(0, 1500) } };
    } finally {
        try { ctx.body.release(); } catch (_) { /* connection gone */ }
        if (bot.currentWindow) try { bot.closeWindow(bot.currentWindow); } catch (_) { /* ditto */ }
        ctx.dispose();
    }
    return { ...out, ticks: ctx.t, ms: Date.now() - t0, phases: ctx.phases, trace: ctx.trace };
}

module.exports = { run, Ctx, SkillError, REASONS };
