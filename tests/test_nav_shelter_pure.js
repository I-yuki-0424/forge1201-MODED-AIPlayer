// The night rule is off on Peaceful (no hostile mob to dig in from) and on again for every other difficulty; the service hands the difficulty over from RCON's "The difficulty is X".
const assert = require('assert');
const sh = require('../src/nav/shelter');
const bot = (t) => ({ time: { timeOfDay: t } });
sh.setDifficulty(null);
assert.strictEqual(sh.isNight(bot(15000)), true); assert.strictEqual(sh.isNight(bot(3000)), false);
sh.setDifficulty('Peaceful'); assert.strictEqual(sh.isNight(bot(15000)), false, 'no night rule on peaceful');
sh.setDifficulty('normal'); assert.strictEqual(sh.isNight(bot(15000)), true);
sh.setDifficulty('hard'); assert.strictEqual(sh.isNight(bot(15000)), true);
sh.setDifficulty(null);
const { OperatorPart } = (() => { const m = require('../src/work/service/operator'); return { OperatorPart: m.OperatorPart || m }; })();
const P = OperatorPart.prototype || OperatorPart;
(async () => {
    const svc = { o: { rcon: { command: async () => 'The difficulty is Peaceful' } }, _rconTail: Promise.resolve(), rcon: P.rcon, _pollDifficulty: P._pollDifficulty };
    await svc._pollDifficulty(); assert.strictEqual(sh.isNight(bot(15000)), false, 'the service poll sets peaceful');
    svc.o.rcon.command = async () => 'The difficulty is Normal'; await svc._pollDifficulty(); assert.strictEqual(sh.isNight(bot(15000)), true);
    sh.setDifficulty(null); console.log('nav shelter: all tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
