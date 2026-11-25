'use strict';
// The one entry point for logging a bot in: picks the Forge or the Fabric transport by MC_PLATFORM (src/transport/platform.js).
//   const { createBot, attachHandshake } = require('./transport');
//   const bot = createBot({ host, port, username }); attachHandshake(bot, { registry });
const { platform, gameVersion } = require('./platform');

const impl = () => (platform() === 'fabric' ? require('./fabric_bot') : require('./forge_bot'));

// Every bot gets the repository's own physics, inventory clicks and dig time (src/native, TASK-20261125-076); NATIVE_PHYSICS / NATIVE_INVENTORY / NATIVE_DIG=0 switch one back to mineflayer's.
const createBot = (o) => {
    const bot = platform() === 'fabric' ? require('./fabric_bot').createBot(o) : require('./forge_bot').createForgeBot(o);
    require('../native').wire(bot, o && o.native ? o.native : {});
    return bot;
};
const attachHandshake = (bot, o) => (platform() === 'fabric' ? require('./fabric_bot').attach(bot) : require('./forge_bot').attachForgeHandshake(bot, o));

module.exports = { platform, gameVersion, createBot, attachHandshake, impl };
