'use strict';
// Native inventory and windows (TASK-20261125-076): the game's click rules (menu.js), the protocol client that keeps the server's state and sends
// predicted clicks (windows.js), and container contents as a goal (contents.js). Wiring into the bot (replacing mineflayer's clickWindow and window
// tracking behind the NATIVE_INVENTORY setting: inventory/mineflayer.js, wired by src/native/index.js; docs/implemented/NATIVE-v1.md).
const items = require('./items');
const menu = require('./menu');
const windows = require('./windows');
const contents = require('./contents');

/** Attach the native windows to a mineflayer bot's protocol client (no mineflayer state is read or changed). */
function attach(bot, opts = {}) {
    if (bot.__nativeWindows) return bot.__nativeWindows;
    const w = new windows.Windows(bot.registry, (name, params) => bot._client.write(name, params), opts).attach(bot._client);
    bot.__nativeWindows = w;
    return w;
}

module.exports = { ...items, ...menu, ...windows, ...contents, attach };
