'use strict';
// The bot's own physics, inventory and dig time under a mineflayer bot (TASK-20261125-076, docs/implemented/NATIVE-v1.md). The transport calls `wire(bot)` right
// after creating a bot (src/transport/index.js). The parts:
//   NATIVE_PHYSICS     native physics           NATIVE_INVENTORY   native window clicks       NATIVE_DIG   native dig time
//   NATIVE_INPUTS      force.js / reflex.js / bed.js use the body's inputs instead of mineflayer's dig / placeBlock / activateBlock (src/skills/inputs.js)
// Default: ON where the live comparison with mineflayer's was made and accepted (orchestrator 2026-11-27: Fabric 1.21.1, the test worlds and its creative console), OFF
// everywhere else (the Forge 1.20.1 play console with its mod items and FML3 registry, the 26.1.2 consoles: nothing compared there yet, NATIVE-v1 section 7).
// This is the ONE place that decides; =1 / =0 force a part on or off on any version (or `wire(bot, { physics: false, ... })`).
// mineflayer stays the protocol client, chunk and entity store; see the dependence list in the doc.
const physics = require('./physics');
const dig = require('./dig');

const ENV = { physics: 'NATIVE_PHYSICS', inventory: 'NATIVE_INVENTORY', dig: 'NATIVE_DIG', inputs: 'NATIVE_INPUTS' };
const ACCEPTED = new Set(['fabric 1.21.1']);          // `<platform> <version>` where native was compared on the same seeds and found not worse

/** Native by default on this bot? Its platform (src/transport/platform.js) and the version it speaks (bot.version, known from the login on). */
function accepted(bot) { return ACCEPTED.has(`${require('../transport/platform').platform()} ${bot && bot.version}`); }

/** Is a part (physics | inventory | dig | inputs) on for this bot: the option, else NATIVE_<PART>=1 / =0, else the accepted versions. */
function enabled(part, bot, opt) {
    if (opt !== undefined) return !!opt;
    const v = process.env[ENV[part]];
    return v === '1' ? true : v === '0' ? false : accepted(bot);
}

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
    const want = { physics: false, inventory: false, dig: false };
    const done = { physics: false, inventory: false, dig: false };
    // decided at the login: then the version the bot speaks is known (MC_VERSION may be unset: mineflayer asks the server)
    bot.once('login', () => { for (const k of Object.keys(want)) want[k] = enabled(k, bot, o[k]); });
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

module.exports = { wire, wirePhysics, enabled, accepted, ACCEPTED };
