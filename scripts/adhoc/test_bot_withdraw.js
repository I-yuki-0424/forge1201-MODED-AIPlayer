const mineflayer = require('mineflayer');
console.log("mineflayer keys:", Object.keys(mineflayer));
const bot = mineflayer.createBot({ host: 'localhost', port: 12345, username: 'test', version: '1.20.1', hideErrors: true });
bot.once('inject_allowed', () => {
   console.log("bot.withdraw exists:", !!bot.withdraw);
   console.log("bot.openContainer exists:", !!bot.openContainer);
   bot.end();
});
