const mineflayer = require('mineflayer');
// createBot injects plugins synchronously so we can inspect its prototype
const bot = mineflayer.createBot({ host: 'localhost', port: 12345, username: 'test', version: '1.20.1', hideErrors: true });
console.log('withdraw:', typeof bot.withdraw);
console.log('openContainer:', typeof bot.openContainer);
console.log('openChest:', typeof bot.openChest);
bot.end();
