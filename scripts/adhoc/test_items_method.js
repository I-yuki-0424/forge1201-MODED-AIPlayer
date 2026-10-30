const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({ host: 'localhost', port: 12345, username: 'test', version: '1.20.1', hideErrors: true });
bot.once('spawn', () => {
  // Wait to load, then test what Window has
  const win = bot.inventory;
  console.log("items exists:", !!win.items);
  console.log("containerItems exists:", !!win.containerItems);
  bot.end();
});
