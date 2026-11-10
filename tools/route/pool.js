'use strict';
// A pool of worker threads that run episodes (one policy spec, a list of episodes -> results). Used by eval.js and train.js.
const { Worker, isMainThread, parentPort } = require('worker_threads');
const { runEpisode } = require('./episode');

if (!isMainThread) {
    parentPort.on('message', async (m) => {
        const out = [];
        for (const ep of m.eps) out.push(await runEpisode(m.spec, ep));
        parentPort.postMessage({ id: m.id, out });
    });
} else {
    module.exports = class Pool {
        constructor(n) { this.ws = Array.from({ length: n }, () => { const w = new Worker(__filename); w.setMaxListeners(0); return w; }); this.id = 0; }
        /** jobs: [{spec, eps}] -> Promise of [results per job]; jobs are dealt out to the threads as they free up. */
        run(jobs) {
            return new Promise((resolve, reject) => {
                const res = new Array(jobs.length); let next = 0, left = jobs.length;
                const feed = (w) => {
                    if (next >= jobs.length) return;
                    const i = next++, id = ++this.id;
                    const on = (m) => { if (m.id !== id) return; w.off('message', on); res[i] = m.out; if (--left === 0) resolve(res); else feed(w); };
                    w.on('message', on); w.once('error', reject); w.postMessage({ id, spec: jobs[i].spec, eps: jobs[i].eps });
                };
                if (!jobs.length) return resolve([]);
                this.ws.forEach(feed);
            });
        }
        close() { return Promise.all(this.ws.map((w) => w.terminate())); }
    };
}
