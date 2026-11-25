'use strict';
// Which kind of server the bots log in to. The two modes share nothing at the wire level, so they are two modules:
//   forge  (src/transport/forge_bot.js)   Forge 1.20.1: FML3 host marker, login handshake proxy, registry sync, packet bypasses, chat hardening.
//   fabric (src/transport/fabric_bot.js)  Fabric, any version mineflayer speaks: the vanilla protocol, nothing to bypass; the differences of the
//                                         versions (item components, ...) are absorbed there, keyed on what the connected version's registry says.
// MC_PLATFORM=forge|fabric decides. Without it (the old switches): MC_FORGE=0, or MC_VERSION other than 1.20.1, means fabric.
function platform() {
    const p = (process.env.MC_PLATFORM || '').toLowerCase();
    if (p === 'forge' || p === 'fabric') return p;
    if (p) throw new Error(`MC_PLATFORM must be forge or fabric, not ${JSON.stringify(p)}`);
    if (process.env.MC_FORGE === '0') return 'fabric';
    return (process.env.MC_VERSION || '1.20.1') === '1.20.1' ? 'forge' : 'fabric';
}

/**
 * The game version the bots speak: Forge is 1.20.1; Fabric is MC_VERSION (the test-world profile sets it, docker/tw/<profile>.json `bot`), and without it `false`:
 * mineflayer asks the server (a status ping) and speaks its version. No version is assumed here (TASK-20261125-074: the system must not depend on one version).
 */
function gameVersion() {
    if (platform() === 'forge') return '1.20.1';
    return process.env.MC_VERSION || false;
}

module.exports = { platform, gameVersion };
