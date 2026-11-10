'use strict';
// Dimensions as data (owner 2026-11-09: the bots must work in the Nether, the End and dimensions that do not exist yet, e.g. the Twilight Forest): names, height limits,
// what is below the floor, the scale between dimensions, and the RANGE an operator designates (a box in one dimension, checked against that dimension's limits).
// Known profiles are the vanilla 1.20.1 ones. An unknown dimension (any other namespaced id) gets the SAFE intersection of the vanilla limits (y 0..255) unless the bot has
// told us better (`learned` = {minY, height}, which mineflayer reads from the login packet: bot.game.minY / bot.game.height), and is never assumed to have a floor.
// Pure: nothing here talks to the game.
const COORD = 29_999_000;
const ID = /^[a-z0-9_.-]{1,32}:[a-z0-9_./-]{1,64}$/;

// minY..maxY: the build limits (world height). work: the band a job may be given without touching the bedrock layers (a pit never digs into bedrock; bedrock.js is the
// separate, opt-in thing). bedrock: the layers of bedrock {lo: [from, to], hi: [from, to]|null}. voidBelow: the dimension has no floor in places (the End islands).
const PROFILES = Object.freeze({
    overworld: { name: 'overworld', rcon: 'minecraft:overworld', known: true, minY: -64, maxY: 319, work: [-59, 319], bedrock: { lo: [-64, -60], hi: null }, voidBelow: false, scale: 1, ceiling: false },
    nether: { name: 'nether', rcon: 'minecraft:the_nether', known: true, minY: 0, maxY: 255, work: [5, 122], bedrock: { lo: [0, 4], hi: [123, 127] }, voidBelow: false, scale: 8, ceiling: true },
    end: { name: 'end', rcon: 'minecraft:the_end', known: true, minY: 0, maxY: 255, work: [0, 255], bedrock: { lo: null, hi: null }, voidBelow: true, scale: 1, ceiling: false },
});

class DimensionError extends Error {}
const bad = (m) => { throw new DimensionError(m); };

/** The short name of a dimension as the work layer keeps it: overworld, nether, end, or the full id of any other (`twilightforest:twilight_forest`). Null when it is none. */
function canon(name) {
    if (name === undefined || name === null) return null;
    const s = String(name).trim().toLowerCase().replace(/^minecraft:/, '');
    if (s === 'overworld') return 'overworld';
    if (s === 'nether' || s === 'the_nether') return 'nether';
    if (s === 'end' || s === 'the_end') return 'end';
    return ID.test(s) && s.split(/[:/]/).every((seg) => seg !== '' && seg !== '.' && seg !== '..') ? s : null;          // the id becomes a folder name (the map): no '..', no empty part
}

/** Is this a dimension the work layer can be told about (the three vanilla ones, or any namespaced id)? */
const isDim = (name) => canon(name) !== null;

/** `canon`, or an error with a sentence for the operator. */
function need(name) { const c = canon(name); if (!c) bad(`dim: overworld, nether, end, or a dimension id such as twilightforest:twilight_forest (got ${JSON.stringify(String(name).slice(0, 40))})`); return c; }

/** The id the server's commands want (`execute in <id>`). */
const rconId = (name) => (PROFILES[need(name)] || { rcon: need(name) }).rcon;

/**
 * The profile of a dimension. `learned` {minY, height}: what the bot's login packet said; it is used for a dimension we know nothing else about, and checked against a known one
 * (a datapack may change the vanilla limits: the learned numbers win then, the profile says so in `learned`).
 */
function profile(name, learned = null) {
    const n = need(name), base = PROFILES[n];
    const L = learned && Number.isInteger(learned.minY) && Number.isInteger(learned.height) && learned.height >= 16 && learned.height <= 4064 ? { minY: learned.minY, maxY: learned.minY + learned.height - 1 } : null;
    if (base) return L && (L.minY !== base.minY || L.maxY !== base.maxY) ? { ...base, ...L, work: [Math.max(L.minY, base.work[0]), Math.min(L.maxY, base.work[1])], learned: true } : { ...base };
    // Unknown: the safe intersection of the vanilla limits, or what the bot learned. No floor is assumed (bridge.js reads the world instead).
    const minY = L ? L.minY : 0, maxY = L ? L.maxY : 255;
    return { name: n, rcon: n, known: false, minY, maxY, work: [minY, maxY], bedrock: { lo: null, hi: null }, voidBelow: null, scale: 1, ceiling: false, learned: !!L };
}

const int = (v, what) => { if (!Number.isInteger(v) || Math.abs(v) > COORD) bad(`${what} must be an integer`); return v; };

/**
 * The range an operator designates in one dimension: a box x0..x1, z0..z1, y0..y1 (y defaults to the dimension's work band). Normalised (min before max) and checked against the
 * dimension's limits. Returns { dim, x0, z0, x1, z1, y0, y1, warnings: [...] } (warnings: it touches a bedrock layer, the dimension's limits are a guess); throws DimensionError.
 * @param opt { learned, maxSide = 1600 (100 chunks, like a pit), maxVolume = 1_000_000_000 }
 */
function designate(spec, { learned = null, maxSide = 1600, maxVolume = 1_000_000_000 } = {}) {
    if (!spec || typeof spec !== 'object') bad('range missing');
    const dim = need(spec.dim === undefined ? 'overworld' : spec.dim), P = profile(dim, learned), warnings = [];
    const x0 = Math.min(int(spec.x0, 'x0'), int(spec.x1, 'x1')), x1 = Math.max(spec.x0, spec.x1);
    const z0 = Math.min(int(spec.z0, 'z0'), int(spec.z1, 'z1')), z1 = Math.max(spec.z0, spec.z1);
    let y0 = spec.y0, y1 = spec.y1;
    if (y0 === undefined && y1 === undefined) { y0 = P.work[0]; y1 = P.work[1]; }
    else { if (y0 === undefined) y0 = P.work[0]; if (y1 === undefined) y1 = P.work[1]; }
    const lo = Math.min(int(y0, 'y0'), int(y1, 'y1')), hi = Math.max(y0, y1);
    if (lo < P.minY || hi > P.maxY) bad(`y must lie between ${P.minY} and ${P.maxY} in ${dim}${P.known ? '' : ' (a dimension this server has not told us about: the safe limits of the vanilla dimensions)'}`);
    if (x1 - x0 >= maxSide || z1 - z0 >= maxSide) bad(`at most ${maxSide} blocks per side`);
    if ((x1 - x0 + 1) * (z1 - z0 + 1) * (hi - lo + 1) > maxVolume) bad(`more than ${maxVolume} blocks: make it smaller or split it`);
    for (const k of ['lo', 'hi']) { const b = P.bedrock[k]; if (b && lo <= b[1] && hi >= b[0]) warnings.push(`the range reaches the ${k === 'lo' ? 'lower' : 'upper'} bedrock layer (y ${b[0]}..${b[1]}): jobs stop above it`); }
    if (!P.known && !P.learned) warnings.push('the limits of this dimension are a guess until a bot has been in it');
    if (P.voidBelow) warnings.push('there is no floor in places: work over a gap goes by a bridge (bridge.js)');
    return { dim, x0, z0, x1, z1, y0: lo, y1: hi, warnings };
}

const contains = (r, p) => (!p.dim || canon(p.dim) === r.dim) && p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1 && (p.y === undefined || (p.y >= r.y0 && p.y <= r.y1));

/** The middle of a range, on its top layer. */
const centre = (r) => ({ dim: r.dim, x: Math.floor((r.x0 + r.x1) / 2), y: r.y1, z: Math.floor((r.z0 + r.z1) / 2) });

/**
 * Where a point of one dimension lies in another: overworld <-> nether by the 1:8 scale (the portal rule); every other pair keeps x and z (`exact: false`: the server's own
 * rules decide where a portal leads, this is only a starting point). y is kept.
 */
function convert(p, from, to) {
    const a = need(from), b = need(to);
    if (a === b) return { ...p, dim: b, exact: true };
    if (a === 'overworld' && b === 'nether') return { x: Math.floor(p.x / 8), y: p.y, z: Math.floor(p.z / 8), dim: b, exact: true };
    if (a === 'nether' && b === 'overworld') return { x: p.x * 8, y: p.y, z: p.z * 8, dim: b, exact: true };
    return { x: p.x, y: p.y, z: p.z, dim: b, exact: false };
}

/** A point inside the limits of its dimension (a target for `journey`, `teleport`, a layout): throws DimensionError with a sentence. */
function checkPoint(p, learned = null) {
    const P = profile(p && p.dim === undefined ? 'overworld' : p.dim, learned);
    int(p.x, 'x'); int(p.z, 'z');
    if (p.y !== undefined) { int(p.y, 'y'); if (p.y < P.minY || p.y > P.maxY) bad(`y ${p.y} is outside ${P.name} (${P.minY}..${P.maxY})`); }
    return P;
}

module.exports = { canon, isDim, need, rconId, profile, designate, contains, centre, convert, checkPoint, DimensionError, PROFILES, COORD };
