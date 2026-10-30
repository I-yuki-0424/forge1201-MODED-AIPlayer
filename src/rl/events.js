'use strict';
// Structured event log (TASK-20261030-006, first slice): one JSON object per line, versioned, correlated by
// run_id / episode / step. Free text only as a field of a typed event. Never put credentials or chat here.
const fs = require('fs');

const SCHEMA = 1;

class EventLog {
    constructor(file, { runId, botId, component = 'rl_env' }) {
        this.fd = fs.openSync(file, 'a');
        Object.assign(this, { runId, botId, component });
        this.seq = 0;
        this.t0 = Date.now();
    }
    emit(event, payload = {}, level = 'info') {
        const line = JSON.stringify({ schema: SCHEMA, ts: new Date().toISOString(), seq: this.seq++, run_id: this.runId, bot_id: this.botId, component: this.component, level, event, ...payload });
        fs.writeSync(this.fd, line + '\n');
    }
    close() { fs.closeSync(this.fd); }
}

module.exports = { EventLog, SCHEMA };
