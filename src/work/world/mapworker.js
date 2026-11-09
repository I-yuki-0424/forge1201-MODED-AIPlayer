'use strict';
// Worker thread: reads region files for the map so that the inflate/parse work never blocks the bots' process.
const { parentPort } = require('worker_threads');
const { readRegion } = require('./mca');
parentPort.on('message', ({ id, file, top }) => {
    try {
        const r = readRegion(file, Number.isInteger(top) ? top : null);
        parentPort.postMessage({ id, names: r.names, idx: r.idx, h: r.h, chunks: r.chunks, skipped: r.skipped }, [r.idx.buffer, r.h.buffer]);
    } catch (e) { parentPort.postMessage({ id, error: String(e.message).slice(0, 200) }); }
});
