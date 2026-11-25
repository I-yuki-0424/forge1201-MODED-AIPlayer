'use strict';
// The bot's own physics, inventory and dig time under a mineflayer bot (TASK-20261125-076, docs/implemented/NATIVE-v1.md). The transport calls `wire(bot)` right
// after creating a bot (src/transport/index.js). Each part is OFF until the live comparison has been accepted (orchestrator, 2026-11-26: other tasks are
// measuring and must not get a second changed variable); a setting switches it on:
//   NATIVE_PHYSICS=1     native physics        NATIVE_INVENTORY=1   native window clicks       NATIVE_DIG=1   native dig time
// (NATIVE_INPUTS=1: force.js / reflex.js / bed.js use the body's inputs instead of mineflayer's dig / placeBlock / activateBlock, src/skills/inputs.js)
// (or `wire(bot, { physics: false, ... })`). mineflayer stays the protocol client, chunk and entity store; see the dependence list in the doc.
const physics = require('./physics');
const dig = require('./dig');

const on = (env, opt) => (opt !== undefined ? !!opt : process.env[env] === '1');

/** Physics: native simulatePlayer under mineflayer's loop (before the fall guard wraps it), and the server told when the sprint the physics allows changes. */
function wirePhysics(bot) {
    const h = physics.install(bot);
    if (!h) return null;
    let told = false;                                       // what the server was last told about sprinting (mineflayer tells it on every sprint key change)
    const setControl = bot.setControlState;
    bot.setControlState = (k, v) => { if (k === 'sprint' && bot.getControlState(k) !== v) told = v; return setControl(k, v); };
    const sim = bot.physics.simulatePlayer;
    bot.physics.simulatePlayer = (state, world) => {
        const out = sim(state, world);
        const s = out || state;
        if (typeof s.sprinting === 'boolean' && s.sprinting !== told && bot.entity) {
            told = s.sprinting;
            bot._client.write('entity_action', { entityId: bot.entity.id, actionId: bot.supportFeature('entityActionUsesStringMapper') ? (told ? 'start_sprinting' : 'stop_sprinting') : (told ? 3 : 4), jumpBoost: 0 });
        }
        return out;
    };
    return h;
}

/**
 * Wire the native parts into a freshly created bot (before its login). Returns { physics, inventory, dig } (each true when on).
 */
function wire(bot, o = {}) {
    const want = { physics: on('NATIVE_PHYSICS', o.physics), inventory: on('NATIVE_INVENTORY', o.inventory), dig: on('NATIVE_DIG', o.dig) };
    const done = { physics: false, inventory: false, dig: false };
    // mineflayer's plugins are injected before the login (loader.js: inject_allowed once the version is known): at the login packet bot.physics and
    // bot.clickWindow exist and no window packet has come yet (the player's inventory follows the login)
    bot.once('login', () => {
        if (want.inventory) { try { require('./inventory/mineflayer').install(bot); done.inventory = true; } catch (e) { bot.emit('native_error', e); } }
    });
    const late = () => {
        if (want.physics && !done.physics && bot.physics) { done.physics = !!wirePhysics(bot); }
        if (want.dig && !done.dig && bot.registry) { bot.digTime = dig.botDigTime(bot); done.dig = true; }
    };
    // after mineflayer's plugins (the physics plugin builds bot.physics for the version) and after the transport's own login handlers (fabric_bot's digTime fix)
    bot.once('login', () => setImmediate(late));
    bot.once('spawn', late);
    bot.__native = { want, done };
    return bot.__native;
}

module.exports = { wire, wirePhysics };
