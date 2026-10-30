'use strict';
// RL environment over a live Forge server: reset() / step(action) with the policy-visible observation of observation.js.
//   - The bot's physics is paused between steps, so one step is exactly `ticks_per_step` client physics ticks and the
//     policy may think as long as it likes. The server keeps running in real time (documented limit, RL-INTERFACE-v1.md).
//   - Episodes are reset by the harness over RCON (teleport, clear, heal, rebuild the arena). The bot never gets operator
//     rights and issues no cheat commands itself.
const Vec3 = require('vec3');
const { Controls } = require('./controls');
const { validateGoal, assess } = require('./goal');
const { observe, inventoryCounts } = require('./observation');

const ARENA_R = 12;          // blocks cleared / rebuilt around the origin on every reset
const COLLECT_MAX = 8;       // the scenario builder places one log per requested item
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ResetError extends Error {}

class McEnv {
    /**
     * @param o {bot, rcon, spec, mcData, events, groundY, settleMs}
     * `groundY` is the y of the top solid layer (flat world: -61, so the bot stands at y = groundY + 1).
     * `originX/originZ` is this bot's arena centre; bots sharing a server need arenas more than ~2 view distances apart.
     */
    constructor({ bot, rcon, spec, mcData, events, groundY = -61, settleMs = 25, originX = 0.5, originZ = 0.5 }) {
        Object.assign(this, { bot, rcon, spec, mcData, events, groundY, settleMs, originX, originZ });
        this.controls = new Controls(bot, spec, mcData);
        this.ep = null;
        this.dead = false;
        bot.on('death', () => { this.dead = true; });
        bot.on('spawn', () => { this.dead = false; });
    }

    async cmd(c) {
        const out = await this.rcon.command(c);
        if (/^(Unknown|Incorrect|Expected|No entity|Could not|That position)/i.test(out)) throw new ResetError(`rcon "${c}": ${out}`);
        return out;
    }

    /** Wait until cond() is truthy; throws ResetError on timeout. */
    async waitFor(what, cond, timeoutMs = 8000) {
        const t0 = Date.now();
        while (!cond()) {
            if (Date.now() - t0 > timeoutMs) throw new ResetError(`reset sync timeout: ${what}`);
            await sleep(10);
        }
    }

    /** Advance the client by n physics ticks with `before(t)` called ahead of each tick t >= 1. Resolves false on death. */
    runTicks(n, before = () => {}) {
        const bot = this.bot;
        return new Promise((resolve, reject) => {
            let done = 0;
            const finish = (alive) => {
                clearTimeout(timer);
                bot.removeListener('physicsTick', onTick);
                bot.removeListener('death', onDeath);
                bot.physicsEnabled = false;
                resolve(alive);
            };
            const onTick = () => { if (++done >= n) finish(true); else before(done); };
            const onDeath = () => finish(false);
            const timer = setTimeout(() => {
                bot.removeListener('physicsTick', onTick);
                bot.removeListener('death', onDeath);
                bot.physicsEnabled = false;
                reject(new Error(`physics stalled after ${done}/${n} ticks`));
            }, 10000 + n * 100);
            bot.on('physicsTick', onTick);
            bot.on('death', onDeath);
            bot.physicsEnabled = true;
        });
    }

    /**
     * Registry check before any training: a dirt item must be named `dirt` on the client (BUGFIX-20261030-015 / LESSONS L4).
     * Throws ResetError otherwise. Leaves the inventory empty.
     */
    async preflight() {
        const b = this.bot, name = b.username;
        await this.cmd(`clear ${name}`);
        await this.cmd(`give ${name} minecraft:dirt 1`);
        let seen = [];
        await this.waitFor('dirt item to arrive', () => (seen = b.inventory.items().map((i) => i.name)).length > 0, 5000);
        await this.cmd(`clear ${name}`);
        if (seen.length !== 1 || seen[0] !== 'dirt') throw new ResetError(`registry check failed: gave dirt, client sees ${JSON.stringify(seen)}`);
        this.events.emit('preflight', { check: 'dirt_stays_dirt', ok: true });
    }

    snapshot() {
        const p = this.bot.entity.position;
        return { pos: { x: p.x, y: p.y, z: p.z }, origin: this.ep.origin, inv: inventoryCounts(this.bot), dead: this.dead || !(this.bot.health > 0) };
    }

    _observation() { return observe(this.bot, this.ep); }

    /**
     * Start an episode. `rng` is a function returning [0,1) (seeded by the caller) used for the initial heading.
     * Returns the step-0 observation message body {obs, reward, reward_terms, terminated, truncated}.
     */
    async reset(goalIn, rng, episode) {
        const goal = validateGoal(goalIn);
        if (goal.type === 'collect' && goal.count > COLLECT_MAX) throw new ResetError(`collect count ${goal.count} > scenario limit ${COLLECT_MAX}`);
        const t0 = Date.now();
        const b = this.bot, name = b.username, gy = this.groundY;
        this.controls.release();
        b.physicsEnabled = false;
        const origin = { x: this.originX, y: gy + 1, z: this.originZ };
        const cx = Math.floor(origin.x), cz = Math.floor(origin.z);
        const heading = Math.floor(rng() * 8) * 45;              // Minecraft yaw in degrees, 8 headings
        const a = ARENA_R;
        // Order matters: players first (so the arena chunks stay loaded), then the arena, then the scenario.
        await this.cmd(`gamemode survival ${name}`);
        await this.cmd(`clear ${name}`);
        await this.cmd(`effect clear ${name}`);
        await this.cmd(`tp ${name} ${origin.x} ${origin.y} ${origin.z} ${heading} 0`);
        await this.cmd(`fill ${cx - a} ${gy + 1} ${cz - a} ${cx + a} ${gy + 6} ${cz + a} air`);
        await this.cmd(`fill ${cx - a} ${gy - 1} ${cz - a} ${cx + a} ${gy - 1} ${cz + a} dirt`);
        await this.cmd(`fill ${cx - a} ${gy} ${cz - a} ${cx + a} ${gy} ${cz + a} grass_block`);
        await this.cmd(`kill @e[type=item,x=${origin.x},y=${origin.y},z=${origin.z},distance=..${a + 6}]`).catch(() => {});   // "no entity" when none: not an error here
        await this.cmd(`effect give ${name} minecraft:instant_health 1 10 true`);
        await this.cmd(`effect give ${name} minecraft:saturation 1 10 true`);
        const logs = [];
        if (goal.type === 'collect') {
            // A row of logs, 3 blocks ahead of the initial heading, one per requested item.
            const rad = (heading * Math.PI) / 180, fwd = [-Math.sin(rad), Math.cos(rad)], side = [fwd[1], -fwd[0]];
            for (let i = 0; i < goal.count; i++) {
                const off = i - (goal.count - 1) / 2;
                const x = Math.floor(origin.x + 3 * fwd[0] + off * side[0]), z = Math.floor(origin.z + 3 * fwd[1] + off * side[1]);
                await this.cmd(`setblock ${x} ${gy + 1} ${z} minecraft:oak_log`);
                logs.push([x, gy + 1, z]);
            }
        }
        // Sync barrier: the client must have seen every change before the first observation.
        await this.waitFor('respawn', () => !this.dead && b.health > 0);
        await this.waitFor('teleport', () => Math.hypot(b.entity.position.x - origin.x, b.entity.position.z - origin.z) < 0.3 && Math.abs(b.entity.position.y - origin.y) < 0.6);
        await this.waitFor('inventory cleared', () => b.inventory.items().length === 0);
        await this.waitFor('health', () => b.health >= 19.9);
        await this.waitFor('arena', () => logs.every(([x, y, z]) => b.blockAt(new Vec3(x, y, z))?.name === 'oak_log'));
        const ground = b.blockAt(new Vec3(cx, gy, cz));
        if (!ground || ground.name !== 'grass_block') throw new ResetError(`ground at y=${gy} is ${ground && ground.name}; set RL_GROUND_Y`);
        this.ep = { goal, origin, step: 0, episode, heading, prev: null, ret: 0 };
        await this.runTicks(3);                                    // settle: gravity, on_ground
        await sleep(this.settleMs);
        this.ep.prev = this.snapshot();
        this.events.emit('reset', { episode, goal, heading, reset_ms: Date.now() - t0 });
        return { obs: this._observation(), reward: 0, reward_terms: { task: 0, shaping: 0 }, terminated: false, truncated: false };
    }

    /** Apply one validated action for `ticks_per_step` ticks and return the next observation message body. */
    async step(action) {
        const ep = this.ep, t0 = Date.now();
        this.controls.begin(action);
        const alive = await this.runTicks(this.spec.ticks_per_step, (t) => this.controls.tick(t));
        await sleep(this.settleMs);
        ep.step++;
        const snap = this.snapshot();
        if (!alive) snap.dead = true;
        const r = assess(ep.goal, snap, ep.prev);
        ep.prev = snap;
        const truncated = !r.terminated && ep.step >= ep.goal.max_steps;
        const reward = r.task + r.shaping;
        ep.ret += reward;
        const terminal = r.terminated || truncated;
        if (terminal) this.controls.release();
        this.events.emit('step', { episode: ep.episode, step: ep.step, reward, task: r.task, shaping: r.shaping, outcome: truncated ? 'timeout' : r.outcome, step_ms: Date.now() - t0 });
        if (terminal) this.events.emit('episode_end', { episode: ep.episode, steps: ep.step, outcome: truncated ? 'timeout' : r.outcome, return: ep.ret });
        return { obs: this._observation(), reward, reward_terms: { task: r.task, shaping: r.shaping }, terminated: r.terminated, truncated };
    }
}

module.exports = { McEnv, ResetError, ARENA_R, COLLECT_MAX };
