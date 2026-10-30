const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({
  username: 'test',
  version: '1.20.1',
  host: '127.0.0.1',
  port: 25565
});
bot.on('inject_allowed', () => {
  const stone = bot.registry.blocksByName['stone'];
  console.log('stone.shapes:', stone.shapes);
  process.exit(0);
});
