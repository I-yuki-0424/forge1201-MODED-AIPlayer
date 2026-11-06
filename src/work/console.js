'use strict';
// Entry point of the work console (`node src/work/console.js`; compose files point here). The code is in web/:
//   web/main.js     environment -> service, token, listener      web/server.js   authentication, sessions, static files
//   web/http.js     response/body helpers, token file, Host check web/routes/*.js the API, one file per area
const { createConsole } = require('./web/server');
const { loadToken, hostAllowed } = require('./web/http');
const { main, knownFromTable } = require('./web/main');

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { createConsole, loadToken, hostAllowed, knownFromTable };
