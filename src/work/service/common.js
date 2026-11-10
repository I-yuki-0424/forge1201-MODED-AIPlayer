'use strict';
// Shared by the parts of the service: closed-form validation helpers, limits, the error that carries an HTTP status.
const dimensions = require('../world/dimensions');
const BOT_NAME = /^[A-Za-z0-9_]{3,16}$/;
const STRUCT_NAME = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const ITEM_ID = /^([a-z0-9_.-]{1,32}:)?[a-z0-9_/]{1,64}$/;
const PLAYER_NAME = /^[A-Za-z0-9_]{1,16}$/;
const COORD = 29_999_000;
const MIN_Y = -64, MAX_Y = 319;
const MAX_CHUNKS = 100, MAX_SIDE = MAX_CHUNKS * 16, MAX_DEPTH = 256;          // a pit is at most 100 x 100 chunks (owner 2026-11-10; it was 256 blocks = 16 chunks); the job's unit budget (jobs/pit.js MAX_UNITS) limits the depth of a very wide one
const ACTIVE = new Set(['running', 'paused', 'ready']);

// Pits: more attempts per unit than the default (a unit is retried by other bots after waits), and lanes stay within one layer of each other
// so that the floors of neighbouring lanes never differ by more than a step (the bots walk between them).
const PIT_LEDGER = { gate: true, leaseMs: 45000, maxAttempts: 10, maxLead: Infinity, lanes: true, sameLimit: 2, holdMs: 5000 };      // lanes are independent (owner 2026-11-07: a fast lane must not wait for a slow one)      // owner 2026-11-07: try far more often before a unit counts as stuck (operation and debugging)
const DEFAULT_KIT = { iron_pickaxe: { min: 2, give: 3 }, cobblestone: { min: 32, give: 64 }, bread: { min: 8, give: 16 } };

class Problem extends Error {                          // a refusal the caller can show: carries the HTTP status
    constructor(message, status = 400) { super(message); this.status = status; }
}
const need = (cond, msg, status) => { if (!cond) throw new Problem(msg, status); };
const int = (v, what) => { need(Number.isInteger(v) && Math.abs(v) <= COORD, `${what} must be an integer`); return v; };

/** The box of a pit, checked against the limits of its dimension (world/dimensions.js; an unknown one: `limits` {minY, height} from a bot that has been there). */
function normalizeBox(b, dim = 'overworld', limits = null) {
    need(b && typeof b === 'object', 'box missing');
    let P; try { P = dimensions.profile(dim, limits); } catch (e) { throw new Problem(e.message); }
    const x0 = Math.min(int(b.x0, 'x0'), int(b.x1, 'x1')), x1 = Math.max(b.x0, b.x1);
    const z0 = Math.min(int(b.z0, 'z0'), int(b.z1, 'z1')), z1 = Math.max(b.z0, b.z1);
    const top = Math.max(int(b.top, 'top'), int(b.bottom, 'bottom')), bottom = Math.min(b.top, b.bottom);
    need(x1 - x0 < MAX_SIDE && z1 - z0 < MAX_SIDE, `a pit is at most ${MAX_CHUNKS} x ${MAX_CHUNKS} chunks (${MAX_SIDE} blocks per side; make several)`);
    need(top <= P.maxY && bottom >= P.minY, `y must be between ${P.minY} and ${P.maxY} in ${P.name}`);
    need(top - bottom + 1 <= MAX_DEPTH, `a pit is at most ${MAX_DEPTH} deep`);
    return { x0, z0, x1, z1, top, bottom };
}

const overlap = (a, b) => a.x0 <= b.x1 && b.x0 <= a.x1 && a.z0 <= b.z1 && b.z0 <= a.z1 && a.y0 <= b.y1 && b.y0 <= a.y1;
module.exports = { Problem, need, int, normalizeBox, overlap, BOT_NAME, STRUCT_NAME, ITEM_ID, PLAYER_NAME, COORD, MIN_Y, MAX_Y, MAX_SIDE, MAX_CHUNKS, MAX_DEPTH, ACTIVE, PIT_LEDGER, DEFAULT_KIT };
