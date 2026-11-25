'use strict';
// Transport for a Fabric server (the vanilla protocol): createBot and nothing else. No FML3 host marker, no handshake, no packet or NBT
// bypasses (those are Forge's, src/transport/forge_bot.js), no mod registry: a Fabric server's blocks and items are the vanilla ones, and
// the mods it runs are server-side (Syncmatica, Servux) or talk over their own plugin channels (src/transport/syncmatica.js).
// Differences between versions that the bots absorb here, so nothing above this file knows the version (each keyed on the data, never on a version number):
//   item components (1.20.5 and later: 1.21.1, 26.1): `item.enchants` is {enchantments: [{id, level}]} or {levels: {name: level}}, not [{name, lvl}] (fixDigTime).
const mineflayer = require('mineflayer');
const { gameVersion } = require('./platform');

/** createBot against a Fabric server. `host` is the plain host name. */
function createBot({ host = 'localhost', port = 25565, username, viewDistance, checkTimeoutInterval }) {
    const clock = require('./time_scale');
    clock.fromEnv();                      // GAME_SPEED: the start value of the client clock
    const bot = mineflayer.createBot({
        host, port, username,
        version: gameVersion(),
        maxPacketSize: 10 * 1024 * 1024,
        ...clock.botOptions(),               // one physics tick per poll: each tick gets its own input frame (time_scale.js)
        disableChatSigning: true,
        hideErrors: true,
        ...(viewDistance ? { viewDistance } : {}),
        ...(checkTimeoutInterval ? { checkTimeoutInterval } : {}),
    });
    clock.follow(bot);                    // then the server's own tick rate (set_ticking_state, `/tick rate`): the bots tick as the server does
    bot.once('login', () => fixDigTime(bot));
    return bot;
}

/**
 * Item components (prismarine-item on 1.20.5 and later): `item.enchants` is the raw component, not the list [{name, lvl}] that prismarine-block's digTime iterates, so every dig
 * with an enchanted tool threw "enchantments is not iterable" (T26 Mine B on 26.1, 2026-11-14: each unit of the pit failed `internal`). The same computation as mineflayer's
 * digTime with the list normalised from whichever shape the connected version sends.
 */
function normEnchants(e, registry) {
    if (Array.isArray(e)) return e;
    if (!e || typeof e !== 'object') return [];
    const name = (id) => (typeof id === 'string' ? id.replace(/^minecraft:/, '') : ((registry && registry.enchantments && registry.enchantments[id]) || {}).name || null);
    if (Array.isArray(e.enchantments)) return e.enchantments.map((x) => ({ name: name(x.id), lvl: x.level }));
    if (e.levels && typeof e.levels === 'object') return Object.entries(e.levels).map(([k, v]) => ({ name: name(k), lvl: v }));
    return [];
}
function fixDigTime(bot) {
    const norm = (e) => normEnchants(e, bot.registry);
    bot.digTime = function digTime(block) {
        const held = bot.heldItem, head = bot.inventory.slots[bot.getEquipmentDestSlot('head')];
        const ench = [...(held ? norm(held.enchants) : []), ...(head ? norm(head.enchants) : [])];
        const eye = bot._getBlockAtEyeLevel ? bot._getBlockAtEyeLevel() : null;
        return block.digTime(held ? held.type : null, bot.game.gameMode === 'creative', ['water', 'flowing_water'].includes(eye && eye.name), !bot.entity.onGround, ench, bot.entity.effects);
    };
}

/**
 * A Fabric server sends no registry handshake: the registry of the game version is the server's. Announced once for the callers that wait for it.
 * Also attaches the Syncmatica client (`bot.syncmatica`, src/transport/syncmatica.js) before the login: the channel must be announced in the configuration phase, and
 * the server's handshake starts when the bot joins. On a server without the mod it does nothing. SYNCMATICA=0 leaves it off.
 */
function attach(bot) {
    bot.once('login', () => bot.emit('mod_registry', { mode: 'vanilla', content: false, version: bot.version || gameVersion() }));
    if (process.env.SYNCMATICA !== '0' && !bot.syncmatica) bot.syncmatica = require('./syncmatica').attach(bot);
}

module.exports = { createBot, attach, fixDigTime, normEnchants };
