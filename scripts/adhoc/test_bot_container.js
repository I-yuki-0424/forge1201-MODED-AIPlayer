const mineflayer = require('mineflayer');

// To see methods on a bot without full login
const bot = mineflayer.createBot({ host: 'localhost', port: 12345, username: 'test' });
console.log(typeof bot.withdraw);
console.log(typeof bot.openContainer);
bot.end();
