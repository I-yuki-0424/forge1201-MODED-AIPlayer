'use strict';
// Defence during a job (owner 2026-11-06, 2-4). A bot that is attacked while it works stops, kills what attacks it, and goes on.
// DEFENSIVE ONLY: a mob in sight is not a reason to stop the job (hunting every enemy in range would starve the work). A threat
// exists only when the bot lost health a moment ago AND a hostile mob is close enough to be the cause. The pure part (`Guard`)
// is told health readings and entity lists; `attach` wires it to a Mineflayer bot.
const HOSTILE = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|wither_skeleton|spider|cave_spider|creeper|witch|pillager|vindicator|evoker|vex|ravager|phantom|slime|magma_cube|blaze|ghast|piglin_brute|hoglin|zoglin|silverfish|endermite|guardian|elder_guardian|warden|shulker|enderman|zombified_piglin|piglin)$/;
const RANGED = /^(skeleton|stray|blaze|ghast|pillager|witch|guardian|elder_guardian|shulker|wither_skeleton)$/;
// Neutral until provoked: only a threat when they are the ones next to a hurt bot, which the proximity rule already says.
const MELEE_R = 5, RANGED_R = 20, HURT_MS = 4000;

const isHostile = (e) => !!e && (e.type === 'hostile' || HOSTILE.test(String(e.name || '')));

class Guard {
    /** @param now () -> ms */
    constructor({ now = Date.now } = {}) { this.now = now; this.hp = null; this.hurtAt = -Infinity; this.defending = false; this.fights = 0; }

    /** A health reading (called on every health packet). A drop is damage; the first reading only sets the baseline. */
    health(hp) {
        if (this.hp !== null && hp < this.hp) this.hurtAt = this.now();
        this.hp = hp;
    }

    /**
     * The mob to fight, or null. `me` {x, y, z}; `entities` [{id, name, type, x, y, z}]. Hurt recently, hostile, and near enough
     * to be the attacker (melee range, or a shooter within its range); nearest first.
     */
    threat(me, entities) {
        if (this.now() - this.hurtAt > HURT_MS || !(this.hp > 0)) return null;
        let best = null;
        for (const e of entities) {
            if (!isHostile(e)) continue;
            const d = Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z), r = RANGED.test(String(e.name || '')) ? RANGED_R : MELEE_R;
            if (d <= r && (!best || d < best.d)) best = { id: e.id, name: e.name, d };
        }
        return best;
    }
}

/**
 * Wire a Guard to a bot: `threat()` for the worker's checks, `interrupt` (a cancel-like object: `cancelled` is true while there is
 * a threat that is not being fought yet, so the running command stops within a tick), `defend(execute)` fights it.
 * `execute(name, args)` is the action layer with the worker's real cancel token.
 */
function attach(bot, { cancel = { cancelled: false }, onEvent = () => {} } = {}) {
    const g = new Guard(), look = () => {
        const p = bot.entity && bot.entity.position;
        if (!p) return null;
        const list = [];
        for (const e of Object.values(bot.entities || {})) if (e && e !== bot.entity && e.position && e.type !== 'player' && e.name !== 'item') list.push({ id: e.id, name: e.name, type: e.type, x: e.position.x, y: e.position.y, z: e.position.z });
        return g.threat(p, list);
    };
    g.health(bot.health);
    const onHealth = () => g.health(bot.health);
    bot.on('health', onHealth);
    const out = {
        guard: g,
        threat: () => (g.defending ? null : look()),
        interrupt: { get cancelled() { return cancel.cancelled || (!g.defending && !!look()); } },
        /** Fight until nothing attacks the bot any more (at most 8 rounds); eats when hurt and hungry. Returns {fought, killed, ended?}. */
        async defend(execute) {
            let fought = 0, killed = 0;
            g.defending = true;
            try {
                for (let i = 0; i < 8 && !cancel.cancelled; i++) {
                    const t = (() => { g.defending = false; try { return look(); } finally { g.defending = true; } })();
                    if (!t) break;
                    fought++;
                    onEvent('defend', { target: t.name, id: t.id, dist: Math.round(t.d * 10) / 10, hp: bot.health });
                    const r = await execute('attack', { entity: t.id });
                    if (r.ok) killed++;
                    else if (r.reason === 'died' || r.reason === 'disconnected' || r.reason === 'cancelled') return { fought, killed, ended: r.reason };
                    else if (r.reason === 'invalid_target') g.hurtAt = -Infinity;          // gone before the first blow (despawned, out of range): not a threat any more
                }
                if (bot.health <= 12 && bot.food < 20 && !cancel.cancelled) await execute('eat', {});          // heal a little before the work goes on
            } finally { g.defending = false; g.fights += fought; }
            return { fought, killed };
        },
        detach: () => bot.removeListener('health', onHealth),
    };
    return out;
}

module.exports = { Guard, attach, isHostile, HOSTILE, RANGED, MELEE_R, RANGED_R, HURT_MS };
