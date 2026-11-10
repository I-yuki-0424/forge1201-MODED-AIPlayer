'use strict';
// Computing cost of one routing decision on the simulator's worlds (single thread): candidates + features + the path calculator's reach (prep), the policy (think), and the walk's own
// path search (exec, what move_to costs with or without the router). node tools/route/bench.js [--n 70] [--model models/experts/route.json]
const fs = require('fs');
const S = require('./sim');
const { episode } = require('./episode');
const { route, defaultModel } = require('../../src/experts/route/router');
const P = require('../../src/experts/route/policy');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i < 0 ? d : process.argv[i + 1]; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
(async () => {
    const n = +arg('n', 70), file = arg('model', 'models/experts/route.json'), model = fs.existsSync(file) ? Object.assign(P.load(JSON.parse(fs.readFileSync(file, 'utf8'))), { name: 'rl' }) : defaultModel();
    const prep = [], think = [], exec = [], dec = []; let nodes = 0, decisions = 0;
    for (let i = 0; i < n; i++) {
        const ep = episode(3000000, i), p = S.place(S.scenario(ep.seed, ep.kind), ep.seed), bot = new S.SimBot(p);
        let last = process.hrtime.bigint(); void last;
        const r = await route(bot.env(), p.target, { model, maxDecisions: 60 });
        const q = r.route; if (!q.decisions) continue;
        prep.push(q.prepMs / q.decisions); think.push(q.thinkMs / q.decisions); exec.push(q.execMs / q.decisions); dec.push(q.decisions); nodes += q.reachNodes; decisions += q.decisions;
    }
    const f = (a) => `p50 ${pct(a, 0.5).toFixed(2)} p95 ${pct(a, 0.95).toFixed(2)} max ${Math.max(...a).toFixed(2)}`;
    console.log(JSON.stringify({ episodes: dec.length, decisionsPerEpisode: +(decisions / dec.length).toFixed(1), 'prep ms per decision (candidates, features, reach)': f(prep), 'policy ms per decision': f(think), 'path search ms per decision (move_to)': f(exec), reachNodesPerDecision: Math.round(nodes / decisions) }, null, 1));
})();
