'use strict';
// Diagnostic: what does the learned walk's view say about the column under a cell? Test code.   scripts/real/run.sh probe_column.js DIM=end START=92,40,3
const L = require('./lib');
const { makeView } = require('../../src/experts/move3/view');
const R = require('../../src/experts/move3/rules');
const DIM = process.env.DIM || 'end', A = 'RealQ';
const [sx, sy, sz] = process.env.START.split(',').map(Number);
async function main() {
    const { shared, S } = await L.connectRcon();
    const svc = await L.openService(shared, [A]);
    const bot = svc.bots.get(A).bot; S.name = A;
    await S.must(`execute in ${L.dimId(DIM)} run forceload add 40 -20 130 60`);
    await S.must(`gamemode spectator ${A}`); await L.tpIn(S, A, DIM, sx + 0.5, sy, sz + 0.5); await L.sleep(3000);
    const env = svc.envFactory(bot, { cancelled: false }, { worker: true });
    const v = makeView(env), col = [];
    for (let y = sy + 2; y >= sy - 24; y--) col.push(`${y}:${v.code(sx, y, sz)}/${env.w.kindAt(sx, y, sz)}/${String(env.w.nameAt(sx, y, sz) || '').replace('minecraft:', '').slice(0, 10)}`);
    console.log('[probe] column', sx, sz, '(y:code/kind/name)', col.join('  '));
    console.log('[probe] fall from', sy, JSON.stringify(R.fall(v, sx, sy, sz, sy - 1, env.profile().minY)), 'minY', env.profile().minY);
    process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(2); });
