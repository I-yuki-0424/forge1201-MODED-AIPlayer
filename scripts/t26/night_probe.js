'use strict';
// Probe (TASK-075, 2026-11-27): does the night rule stay off on a Peaceful T26 world? T.open sets the difficulty, the work service polls it over RCON (operator.js _pollDifficulty);
// at midnight nav/shelter.js isNight must answer false on Peaceful (and true with DIFFICULTY=normal). Prints what the service learned and what the rule answers, server-set clock.
const T = require('./lib');
(async () => {
    const name = 'Night' + T.WORLD, { S, svc, difficulty } = await T.open([name]);
    const bot = svc.bots.get(name).bot, SH = require('../../src/nav/shelter');
    await S.must('time set 18000'); await T.sleep(6000);
    const rep = { difficulty, timeOfDay: bot.time && bot.time.timeOfDay, isNight: SH.isNight(bot) };
    console.log(`[night_probe w${T.WORLD}] ${JSON.stringify(rep)}`);
    await S.cmd('time set 1000'); await svc.stop(); process.exit(0);
})().catch((e) => { console.error(e); process.exit(2); });
