'use strict';
// Transport for a Fabric server (the vanilla protocol): createBot and nothing else. No FML3 host marker, no handshake, no packet or NBT
// bypasses (those are Forge's, src/transport/forge_bot.js), no mod registry: a Fabric server's blocks and items are the vanilla ones, and
// the mods it runs are server-side (Syncmatica, Servux) or talk over their own plugin channels (src/transport/syncmatica.js).
// Differences of newer versions that the bots absorb here, so nothing above this file knows the version:
//   26.1  item components: `item.enchants` is {enchantments: [{id, level}]}, not [{name, lvl}] (fixDigTime).
const mineflayer = require('mineflayer');
const { gameVersion } = require('./platform');

/** createBot against a Fabric server. `host` is the plain host name. */
function createBot({ host = 'localhost', port = 25565, username, viewDistance, checkTimeoutInterval }) {
    require('./time_scale').fromEnv();    // GAME_SPEED: a server running tools/tickrate needs the client clock to match
    const bot = mineflayer.createBot({
        host, port, username,
        version: gameVersion(),
        maxPacketSize: 10 * 1024 * 1024,
        disableChatSigning: true,
        hideErrors: true,
        ...(viewDistance ? { viewDistance } : {}),
        ...(checkTimeoutInterval ? { checkTimeoutInterval } : {}),
    });
    bot.once('login', () => fixDigTime(bot));
    return bot;
}

/**
 * 26.1 (prismarine-item with item components): `item.enchants` is the raw component {enchantments: [{id, level}]}, not the list [{name, lvl}] that prismarine-block's digTime
 * iterates, so every dig with an enchanted tool threw "enchantments is not iterable" (T26 Mine B, 2026-11-14: each unit of the pit failed `internal`). The same computation as
 * mineflayer's digTime with the list normalised.
 */
function fixDigTime(bot) {
    const norm = (e) => (Array.isArray(e) ? e : e && Array.isArray(e.enchantments) ? e.enchantments.map((x) => ({ name: (bot.registry.enchantments[x.id] || {}).name || null, lvl: x.level })) : []);
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
    bot.once('login', () => bot.emit('mod_registry', { mode: 'vanilla', content: false, version: gameVersion() }));
    if (process.env.SYNCMATICA !== '0' && !bot.syncmatica) bot.syncmatica = require('./syncmatica').attach(bot);
}

module.exports = { createBot, attach, fixDigTime };
