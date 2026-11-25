'use strict';
// Fetch the game's pictures for the console at deploy: node src/work/web/assets/fetch.js <version> <cache folder>   (e.g. 1.21.1 /mnt/data/forgeaip/mc-assets)
// Downloads the client jar of that version from Mojang (SHA-1 checked) and extracts the block/item models, textures and English names (assets/store.js).
const { fetchVersion } = require('./store');

const [version, root] = process.argv.slice(2);
if (!version || !root) { console.error('usage: node src/work/web/assets/fetch.js <version> <cache folder>'); process.exit(2); }
fetchVersion(version, require('path').resolve(root)).then((d) => console.log(`assets of ${version} in ${d}`), (e) => { console.error(e.message); process.exit(1); });
