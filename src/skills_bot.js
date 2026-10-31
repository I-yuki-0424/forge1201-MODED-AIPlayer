'use strict';
// Bot child process on the new action layer (TASK-20261031-017): the same IPC contract as bot_actuator.js
// (in: EXECUTE_ACTION {action: [...], queue_op}, ASYNC_CHAT; out: USER_CHAT, BOT_STATUS, ERROR, LOG), but the only thing
// that moves the bot is the intent queue below. No background loops (auto-eat, auto-defence, anti-AFK, dodging): they set
// controls in parallel with actions, which is what made the old actuator's actions unreliable. AgentManager starts this
// file unless BOT_RUNTIME=legacy.
// Environment: BOT_ID, BOT_OPTIONS ({host, port}), MC_HOST, MC_PORT, BOT_REGISTRY=auto|inject|vanilla (default auto: inject
// the mod block registry only when the server reports content mods).
const fs = require('fs');
const path = require('path');
const mc = require('minecraft-protocol');
const { createForgeBot, attachForgeHandshake } = require('./transport/forge_bot');
const { runIntent } = require('./skills/intents');
const { EventLog } = require('./rl/events');

const botId = process.env.BOT_ID || 'AI_Bot_01';
const opts = (() => { try { return JSON.parse(process.env.BOT_OPTIONS || '{}'); } catch (_) { return {}; } })();
const host = opts.host || process.env.MC_HOST || 'localhost';
const port = Number(opts.port || process.env.MC_PORT || 25565);
const LOG_DIR = path.join(process.cwd(), 'logs');
const TRACE_DIR = path.join(LOG_DIR, 'traces');
const TRACE_KEEP = 50;
fs.mkdirSync(TRACE_DIR, { recursive: true });
const events = new EventLog(path.join(LOG_DIR, `skills_${botId}.jsonl`), { runId: `${botId}-${Date.now()}`, botId, component: 'skills_bot' });
const send = (m) => { if (process.send) process.send(m); };
const log = (s) => { console.log(`[SkillsBot ${botId}] ${s}`); };

let bot = null, ready = false, closing = false;
let queue = [], current = null, cancel = { cancelled: false }, executing = false;

/** Content mods on the server (anything beyond minecraft/forge), from the server-list ping. */
async function serverMods() {
    try {
        const st = await mc.ping({ host, port, version: '1.20.1', closeTimeout: 5000 });
        return ((st.forgeData && st.forgeData.mods) || []).map((m) => m.modId).filter((id) => !['minecraft', 'forge'].includes(id));
    } catch (e) { log(`ping failed (${e.message}); assuming no content mods`); return []; }
}

function environment() {
    const b = bot, me = b.entity.position;
    const items = b.inventory.items();
    const tier = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'].find((t) => items.some((i) => i.name === `${t}_pickaxe`)) || null;
    const tally = (arr) => Object.entries(arr.reduce((m, n) => ((m[n] = (m[n] || 0) + 1), m), {})).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([n, c]) => `${c}x ${n}`);
    const near = Object.values(b.entities).filter((e) => e !== b.entity && e.position.distanceTo(me) <= 16);
    const blocks = [];
    for (const v of b.findBlocks({ matching: (blk) => blk.name !== 'air' && blk.name !== 'grass_block' && blk.name !== 'dirt' && blk.name !== 'bedrock', maxDistance: 8, count: 200 })) {
        const blk = b.blockAt(v); if (blk) blocks.push(blk.name);
    }
    return {
        position: { x: Math.round(me.x), y: Math.round(me.y), z: Math.round(me.z) },
        dimension: b.game && b.game.dimension, health: Math.round(b.health), food: b.food,
        players_nearby: Object.keys(b.players).filter((p) => p !== b.username && b.players[p].entity),
        inventory: items.map((i) => ({ name: i.name, count: i.count })),
        has_pickaxe: !!tier, pickaxe_tier: tier, has_axe: items.some((i) => i.name.endsWith('_axe')), has_sword: items.some((i) => i.name.endsWith('_sword')),
        nearby_blocks: tally(blocks), nearby_entities: tally(near.map((e) => e.name || e.username || 'unknown')),
        action_layer: 'skills-v1',
    };
}

function feedback(message) {
    if (!message) return;
    send({ type: 'USER_CHAT', data: { username: 'System', message, environment: environment() } });
}

/** Keep the last TRACE_KEEP traces of failed commands (per-tick rows, for scripts/skills/report.py-style reading). */
function keepTrace(name, args, r) {
    if (r.ok || !r.trace) return;
    const f = path.join(TRACE_DIR, `${botId}-${Date.now()}-${name}.json`);
    fs.writeFile(f, JSON.stringify({ bot: botId, command: name, args, reason: r.reason, detail: r.detail, phases: r.phases, trace: r.trace }), () => {});
    fs.readdir(TRACE_DIR, (err, files) => {
        if (err) return;
        const mine = files.filter((x) => x.startsWith(`${botId}-`)).sort();
        for (const old of mine.slice(0, Math.max(0, mine.length - TRACE_KEEP))) fs.unlink(path.join(TRACE_DIR, old), () => {});
    });
}

async function drain() {
    if (executing) return;
    executing = true;
    try {
        while (queue.length && ready && !closing) {
            current = queue.shift();
            const token = cancel;
            const t0 = Date.now();
            events.emit('intent_start', { intent: current.action, args: current });
            const r = await runIntent(bot, current, {
                cancel: token,
                onCommand: (name, args, res) => {
                    events.emit('command', { intent: current.action, command: name, args, ok: res.ok, reason: res.reason, ticks: res.ticks, ms: res.ms });
                    keepTrace(name, args, res);
                },
            });
            events.emit('intent_end', { intent: current.action, ok: r.ok, cancelled: !!r.cancelled, ms: Date.now() - t0, commands: r.results.length });
            if (r.cancelled || token.cancelled) break;
            if (r.message) {
                log(r.message);
                bot.chat(r.message.slice(0, 200));
                feedback(r.message);
            }
            if (!r.ok) { queue = []; break; }          // a failed step invalidates the rest of the plan: the LLM replans
        }
    } finally {
        current = null;
        executing = false;
    }
}

async function replace(actions) {
    cancel.cancelled = true;
    queue = [];
    while (executing) await new Promise((r) => setTimeout(r, 20));
    cancel = { cancelled: false };
    if (actions.length === 1 && actions[0].action === 'stop') { bot.clearControlStates(); return; }
    queue = actions;
    drain();
}

process.on('message', async (msg) => {
    if (!msg || !bot) return;
    if (msg.type === 'ASYNC_CHAT') { if (ready && msg.text) bot.chat(String(msg.text).slice(0, 240)); return; }
    if (msg.type !== 'EXECUTE_ACTION') return;
    const actions = (Array.isArray(msg.action) ? msg.action : [msg.action]).filter((a) => a && typeof a.action === 'string');
    const op = String(msg.queue_op || 'replace').toLowerCase();
    if (!ready) { queue.push(...actions); return; }
    if (op === 'ignore' && (executing || queue.length)) return;
    if (op === 'append') { queue.push(...actions); drain(); return; }
    await replace(actions);
});

function status() {
    if (!bot || !bot.entity) return;
    const p = bot.entity.position;
    const s = {
        timestamp: new Date().toISOString(), ready, runtime: 'skills',
        position: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 },
        health: Math.round(bot.health), food: bot.food, dimension: (bot.game && bot.game.dimension) || 'overworld',
        isExecuting: executing, currentAction: current && current.action, actionQueue: [...(current ? [current] : []), ...queue],
        inventory: bot.inventory.items().map((i) => ({ name: i.name, count: i.count })),
    };
    fs.writeFile(path.join(process.cwd(), `ai_debug_${botId}.json`), JSON.stringify(s, null, 2), () => {});
    send({ type: 'BOT_STATUS', data: s });
}

async function main() {
    const mods = await serverMods();
    const mode = process.env.BOT_REGISTRY || 'auto';
    const inject = mode === 'inject' || (mode === 'auto' && mods.length > 0);
    log(`connecting to ${host}:${port}; server content mods: ${mods.length}; registry injection ${inject ? 'on' : 'off'}`);
    events.emit('run_start', { host, port, content_mods: mods.length, inject });
    bot = createForgeBot({ host, port, username: botId });
    attachForgeHandshake(bot, { inject });
    const _dedup = new Map();
    bot.on('chat', (username, message) => {
        if (username === bot.username || !message.startsWith('-')) return;          // only '-' instructions, as before
        const key = `${username}:${message}`, now = Date.now();
        if (now - (_dedup.get(key) || 0) < 3000) return;                          // Forge delivers some chat twice
        _dedup.set(key, now);
        if (_dedup.size > 64) for (const [k, t] of _dedup) if (now - t > 5000) _dedup.delete(k);
        const isAsync = message.startsWith('-!');
        send({ type: 'USER_CHAT', data: { username, message: message.slice(isAsync ? 2 : 1).trim(), async: isAsync, environment: environment() } });
    });
    bot.once('spawn', () => {
        ready = true;
        log('spawned');
        events.emit('spawned', { pos: bot.entity.position.floored().toArray() });
        setInterval(status, 2000).unref();
        drain();
    });
    bot.on('kicked', (reason) => {
        if (closing) return;
        send({ type: 'ERROR', category: 'Kicked', details: String(reason).slice(0, 200) });
        events.emit('kicked', { reason: String(reason).slice(0, 200) }, 'error');
        closing = true; setTimeout(() => process.exit(1), 200);
    });
    bot.on('end', (reason) => {
        if (closing) return;
        send({ type: 'ERROR', category: 'Disconnected', details: String(reason).slice(0, 200) });
        events.emit('bot_end', { reason: String(reason) }, 'error');
        closing = true; setTimeout(() => process.exit(1), 200);
    });
    bot.on('error', (e) => { events.emit('bot_error', { message: String(e.message || e).slice(0, 200) }, 'warn'); });
}

process.on('SIGTERM', () => { closing = true; try { bot && bot.end(); } catch (_) { /* gone */ } setTimeout(() => process.exit(0), 300); });
main().catch((e) => { send({ type: 'ERROR', category: 'BotError', details: String(e.message || e).slice(0, 200) }); process.exit(1); });
