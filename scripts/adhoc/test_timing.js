const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({ username: 'test', version: '1.20.1', host: '127.0.0.1', port: 25565 });
bot._client.on('packet', (data, meta) => {
  if (meta.name === 'login_plugin_request') {
    const stone = bot.registry.blocksByName['stone'];
    console.log('FML Handshake starts. stone.shapes:', stone.shapes);
    process.exit(0);
  }
});
