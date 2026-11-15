'use strict';
// Does the bot learn the server difficulty on 26.1 (bot.game.difficulty)? Probe, not a test.
const L = require('../real/lib');
(async () => {
    const { shared } = await L.connectRcon();
    const svc = await L.openService(shared, ['Diff1'], { teleport: 'off' });
    const bot = svc.bots.get('Diff1').bot;
    await L.sleep(4000);
    console.log('difficulty', JSON.stringify(bot.game.difficulty), 'gameMode', bot.game.gameMode, 'hardcore', bot.game.hardcore, 'time', bot.time && bot.time.timeOfDay);
    await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
