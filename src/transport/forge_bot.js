'use strict';
// Transport layer: everything needed to get a Mineflayer bot logged in to a Forge 1.20.1 server.
// Extracted from bot_actuator.js (TASK-20261030-009 first step) so the RL environment (src/rl) and the actuator share it.
const mineflayer = require('mineflayer');
const nbt = require('prismarine-nbt');
const ForgeHandshakeStateMachine = require('../forge_handshake_state_machine');
const DynamicRegistryInjector = require('../dynamic_registry_injector');
const modRegistry = require('./mod_registry');

let bypassesApplied = false;

/** Protocol & NBT bypasses: ignore packets that desync on Forge (process-global, call before createBot). */
function applyProtocolBypasses() {
    if (bypassesApplied) return;
    bypassesApplied = true;
    try {
        const mcDataGlobal = require('minecraft-data')('1.20.1');
        const types = mcDataGlobal.protocol.play.toClient.types;
        // Suppress partial packet read exceptions by ignoring packets known to desync.
        // NOTE: Do NOT bypass inbound chat packets here. Doing so prevents the bot
        // from receiving player commands (e.g. "-hi", "-follow me").
        // Chat packets (player_chat, system_chat) must flow normally so bot.on('chat') fires.
        const bypass = ['declare_recipes', 'tags', 'advancements', 'declare_commands', 'unlock_recipes', 'craft_recipe_response', 'nbt_query_response', 'world_particles'];
        // Dynamically bypass chat-named packet variants ONLY if they are NOT the
        // core mineflayer chat event sources. This prevents Forge-specific rare packet
        // variants from crashing without silencing player command delivery.
        // IMPORTANT: minecraft-data type keys are prefixed with 'packet_' (e.g. 'packet_player_chat')
        // so we must include both bare and packet_-prefixed forms in CHAT_EVENTS_KEEP.
        const CHAT_EVENTS_KEEP = new Set([
            'player_chat', 'system_chat', 'profileless_chat', 'disguised_chat', 'chat_message', 'chat',
            'packet_player_chat', 'packet_system_chat', 'packet_profileless_chat', 'packet_disguised_chat',
        ]);
        const dynamicChatBypass = Object.keys(types).filter(name => /(^|_)chat($|_)/i.test(name) && !CHAT_EVENTS_KEEP.has(name));
        const bypassAll = Array.from(new Set([...bypass, ...dynamicChatBypass]));
        bypassAll.forEach(p => {
            types[p] = 'restBuffer';
            if (types['packet_' + p]) types['packet_' + p] = 'restBuffer';
        });

        const nbtProto = nbt.protos.big;
        const originalRead = nbtProto.read;
        nbtProto.read = function (buffer, offset) {
            try { return originalRead.call(this, buffer, offset); } catch (e) { return nbtProto.readAnon(buffer, offset); }
        };
        console.log('[Actuator] Protocol bypasses and NBT leniency applied.');
    } catch (e) { console.error(`[Actuator] Patch failed: ${e.message}`); }
}

function hardenClientChatParsers(bot) {
    const client = bot && bot._client;
    if (!client) return;

    if (!client.__forgeAipEmitPatchApplied) {
        // Keep inbound chat event flow intact so bot.on('chat') continues to work.
        // Only block declare_commands which is known to be noisy/fragile on modded stacks.
        const blockedEvents = new Set(['declare_commands']);
        const originalEmit = client.emit;
        // CHAT SAFETY: Forge 1.20.1 player_chat packets include BigInt fields (index/timestamp/salt)
        // that cause "Cannot mix BigInt" crashes in minecraft-protocol/src/client/chat.js.
        // Wrap those specific events with try-catch to prevent process crashes.
        // On parse failure, fall back to extracting the raw message field for bot.on('chat').
        const CHAT_SAFE_EVENTS = new Set(['player_chat', 'system_chat', 'profileless_chat', 'disguised_chat']);
        client.emit = function patchedEmit(eventName, ...args) {
            if (blockedEvents.has(eventName)) return false;
            if (CHAT_SAFE_EVENTS.has(eventName)) {
                try {
                    return originalEmit.call(this, eventName, ...args);
                } catch (e) {
                    // Suppress BigInt or other parse errors from Forge chat packets.
                    // Attempt a manual fallback so player commands still reach bot.on('chat').
                    if (eventName === 'player_chat') {
                        try {
                            const pkt = args[0];
                            // 1.20.1 player_chat packet fields: plainMessage, networkName, senderUuid
                            const msgText = pkt && (pkt.plainMessage || pkt.message);
                            if (typeof msgText === 'string' && msgText.length > 0) {
                                let senderName = 'Player';
                                try {
                                    // networkName is a JSON text component e.g. {"text":"PlayerName"}
                                    const parsed = JSON.parse(pkt.networkName || '{}');
                                    senderName = parsed.text || parsed.translate || String(pkt.networkName);
                                } catch (_) {
                                    const senderUuid = String(pkt.senderUuid || '');
                                    const sender = Object.values(bot.players || {}).find(p =>
                                        p && p.uuid && p.uuid.toLowerCase() === senderUuid.toLowerCase()
                                    );
                                    senderName = sender?.username || 'Player';
                                }
                                // Manually synthesize bot's 'chat' event for command processing
                                bot.emit('chat', senderName, msgText, null, Buffer.alloc(0), null);
                            }
                        } catch (_) {}
                    }
                    return false;
                }
            }
            return originalEmit.call(this, eventName, ...args);
        };
        client.__forgeAipEmitPatchApplied = true;
    }

    // Do not detach mineflayer's chat listeners; bot.on('chat') depends on them.
    // Only remove declare_commands listeners to suppress Forge protocol spam.
    const fragileChatEvents = ['declare_commands'];

    for (const ev of fragileChatEvents) {
        try {
            client.removeAllListeners(ev);
            client.on(ev, () => {});
        } catch (_) {}
    }
}

/** createBot with the FML3 host marker, then the chat hardening. `host` is the plain host name. */
function createForgeBot({ host = 'localhost', port = 25565, username, viewDistance }) {
    applyProtocolBypasses();
    require('./time_scale').fromEnv();    // GAME_SPEED: a server running tools/tickrate needs the client clock to match
    const bot = mineflayer.createBot({
        host: host + '\0FML3\0',
        port,
        username,
        version: '1.20.1',
        maxPacketSize: 10 * 1024 * 1024,
        disableChatSigning: true,
        hideErrors: true,
        ...(viewDistance ? { viewDistance } : {})
    });
    hardenClientChatParsers(bot);
    return bot;
}

/**
 * Run the FML3 handshake on `inject_allowed` and make Prismarine's registry match the server.
 * registry 'auto' (default): on a server with content mods, install the exact mod blocks and items
 *   (src/transport/mod_registry.js: the handshake's registry ids + the mod set's dump table); a vanilla Forge server needs
 *   nothing. 'vanilla': never touch the registry. 'legacy': the old heuristic byte scan (src/dynamic_registry_injector.js),
 *   which mislabels vanilla items (dirt -> "forge:modid4") and names every Create block "decorated_pot" (2026-10-31).
 * The result is emitted once as bot 'mod_registry' {mode, content, blocks, states, items, missing, error?}.
 */
function attachForgeHandshake(bot, { registry = 'auto', table } = {}) {
    bot.on('inject_allowed', () => {
        hardenClientChatParsers(bot);
        const handshake = new ForgeHandshakeStateMachine(bot._client);
        handshake.on('handshake_complete', (payloads) => {
            if (registry === 'legacy') {
                const injector = new DynamicRegistryInjector(bot.registry);
                injector.injectBlockToRegistry(injector.parseRegistryPayload(payloads));
                return bot.emit('mod_registry', { mode: registry });
            }
            let sync;
            try { sync = modRegistry.parseRegistrySync(payloads); } catch (e) {
                return bot.emit('mod_registry', { mode: registry, error: e.message });
            }
            bot.forgeRegistrySync = sync;   // server registry name -> id maps (statistics ids, src/rl/progress.js)
            const content = modRegistry.hasContentMods(sync);
            if (registry !== 'auto' || !content) return bot.emit('mod_registry', { mode: registry, content });
            const tab = table === undefined ? modRegistry.loadTable() : table;
            bot.emit('mod_registry', { mode: registry, content, table: !!tab, ...modRegistry.install(bot.registry, sync, tab) });
        });
    });
}

module.exports = { applyProtocolBypasses, hardenClientChatParsers, createForgeBot, attachForgeHandshake };
