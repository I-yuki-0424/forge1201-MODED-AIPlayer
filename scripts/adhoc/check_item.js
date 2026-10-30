const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: 'TestBot'
});
bot.on('spawn', () => {
    console.log("Spawned");
    const item = bot.inventory.items()[0];
    if (item) {
        console.log("Item:", item);
        console.log("NBT:", item.nbt);
    } else {
        console.log("No item found");
    }
    process.exit(0);
});
bot.on('error', err => { console.log(err); process.exit(1); });
