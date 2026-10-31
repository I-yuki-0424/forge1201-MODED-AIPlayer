'use strict';
// Live check of the LLM path on the new action layer (test code): a player types '-' instructions in chat, the real
// AgentManager builds its prompt and asks the "LLM", the skills_bot child runs the intents, and each outcome is graded
// over RCON. The LLM is a local mock answering like Ollama /api/generate with fixed actions per instruction, so the
// check needs no credential; everything else is the production path.
//   scripts/world/test-up.sh base-flat
//   (cd docker/world-server && docker compose --profile check run --rm intent-check)
const http = require('http');
const Vec3 = require('vec3');
const { Rcon } = require('../../src/rl/rcon');
const { createForgeBot, attachForgeHandshake } = require('../../src/transport/forge_bot');

const HOST = process.env.MC_HOST || 'world-test', PORT = Number(process.env.MC_PORT || 25565);
const BOT = 'AI_Bot_01', ME = 'Steve', GY = -61;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').trim();

// instruction -> the actions the mock LLM answers with (what a correct LLM would answer)
const PLAN = {
    'collect 3 logs': [{ action: 'collect', target: 'log', quantity: 3 }],
    'give me two logs': [{ action: 'give', target: 'me', item: 'oak_log', quantity: 2 }],
    'come here': [{ action: 'come', target: 'player_name' }],
    'go to 20 -15': [{ action: 'goto', x: 20, z: -15 }],
    'make planks': [{ action: 'craft', target: 'oak_planks', quantity: 4 }],
    'place a table': [{ action: 'place', target: 'crafting_table' }],
    'kill the husk': [{ action: 'kill', target: 'husk', quantity: 1 }],
    'store planks': [{ action: 'deposit_to_container', item: 'oak_planks', quantity: 4, x: 3, y: -60, z: -6 }],
    'pull the lever': [{ action: 'activate_block', x: -3, y: -60, z: -5 }],
    'fly away': [{ action: 'fly', x: 100, z: 100 }],
    'collect a log then give it': [{ action: 'collect', target: 'oak_log', quantity: 1 }, { action: 'give', target: 'me', item: 'oak_log', quantity: 1 }],
    'go far': [{ action: 'goto', x: 120, z: 120 }],
    'stop': [{ action: 'stop' }],
    'find diamonds': [{ action: 'collect', target: 'diamond_ore', quantity: 1 }],
};
const prompts = [];

function mockLlm() {
    return new Promise((resolve) => {
        const srv = http.createServer((req, res) => {
            let body = '';
            req.on('data', (d) => { body += d; });
            req.on('end', () => {
                const prompt = JSON.parse(body).prompt || '';
                prompts.push(prompt);
                const said = /User '[^']+' said: "([^"]*)"/.exec(prompt);
                const plan = said && PLAN[said[1]] ? PLAN[said[1]] : [{ action: 'chat', message: 'noted' }];
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ response: JSON.stringify(plan) }));
            });
        });
        srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
}

async function main() {
    const llm = await mockLlm();
    process.env.OLLAMA_URL = `http://127.0.0.1:${llm.address().port}/api/generate`;
    process.env.OLLAMA_API_KEY = '';
    const AgentManager = require('../../src/agent_manager');
    const rcon = new Rcon({ host: HOST, port: 25575, password: process.env.RCON_PASSWORD });
    await rcon.connect();
    const cmd = async (c) => strip(await rcon.command(c));
    const count = async (who, item) => Number((/Found (\d+)/.exec(await cmd(`clear ${who} minecraft:${item} 0`)) || [0, 0])[1]);
    const pos = async (who) => (/\[(.*)\]/.exec(await cmd(`data get entity ${who} Pos`)) || [0, '0,0,0'])[1].split(',').map(parseFloat);
    await cmd('gamemode survival @a'); await cmd('difficulty easy');

    const steve = createForgeBot({ host: HOST, port: PORT, username: ME });
    attachForgeHandshake(steve);
    await new Promise((r) => steve.once('spawn', r));
    await cmd(`tp ${ME} 0.5 -60 3.5`);

    const manager = new AgentManager();
    const system = [];
    const orig = manager.handleIPCMessage.bind(manager);
    manager.handleIPCMessage = (id, m) => { if (m.type === 'USER_CHAT' && m.data.username === 'System') system.push(m.data.message); return orig(id, m); };
    manager.startBot(BOT, { host: HOST, port: PORT });
    for (let i = 0; i < 300 && !(manager.botStatus.get(BOT) || {}).ready; i++) await sleep(100);
    await cmd(`gamemode survival ${BOT}`); await cmd(`clear ${BOT}`);
    await cmd(`tp ${BOT} 0.5 -60 0.5`);
    await sleep(1500);

    const results = [];
    const say = async (text, expect, { setup, check, wait = 60000 } = {}) => {
        if (setup) await setup();
        await sleep(400);
        const n0 = system.length, t0 = Date.now();
        steve.chat(`-${text}`);
        let msg = null;
        while (Date.now() - t0 < wait) {
            msg = system.slice(n0).find((m) => expect.test(m) || /^Failed|^Partially/.test(m));
            if (msg) break;
            await sleep(100);
        }
        const server = check ? await check() : true;
        const ok = !!msg && expect.test(msg) && server === true;
        results.push({ text, ok, msg, server });
        console.log(`[check] ${ok ? 'PASS' : 'FAIL'} "${text}" -> ${msg || '(no feedback)'}${server === true ? '' : `  server: ${JSON.stringify(server)}`}`);
    };

    await say('collect 3 logs', /^Successfully collected 3 log/, {
        setup: async () => { for (const [x, z] of [[5, 3], [6, -4], [-4, 6]]) await cmd(`setblock ${x} -60 ${z} minecraft:oak_log`); },
        check: async () => ((await count(BOT, 'oak_log')) >= 3 ? true : { oak_log: await count(BOT, 'oak_log') }),
    });
    await say('give me two logs', /^Successfully gave 2 oak_log to Steve/, {
        check: async () => { await sleep(2500); const n = await count(ME, 'oak_log'); return n >= 2 ? true : { steve_oak_log: n }; },
    });
    await say('come here', /^Successfully arrived at destination next to Steve/, {
        setup: async () => { await cmd(`tp ${ME} 10.5 -60 -8.5`); },
        check: async () => { const [a, , b] = await pos(BOT), [c, , d] = await pos(ME); const dist = Math.hypot(a - c, b - d); return dist <= 3.5 ? true : { dist }; },
    });
    await say('go to 20 -15', /^Successfully arrived at destination 20 /, {
        check: async () => { const [x, , z] = await pos(BOT); return Math.floor(x) === 20 && Math.floor(z) === -15 ? true : { x, z }; },
    });
    await say('make planks', /^Successfully crafted \d+ oak_planks/, {
        setup: async () => { await cmd(`give ${BOT} minecraft:oak_log 1`); },
        check: async () => ((await count(BOT, 'oak_planks')) >= 4 ? true : { oak_planks: await count(BOT, 'oak_planks') }),
    });
    await say('place a table', /^Successfully placed crafting_table/, {
        setup: async () => { await cmd(`give ${BOT} minecraft:crafting_table 1`); },
        check: async () => (/Found [1-9]/.test(await cmd(`execute positioned as ${BOT} if blocks ~-4 ~-1 ~-4 ~4 ~2 ~4 ~-4 ~-1 ~-4 masked`)) ? true
            : ((await count(BOT, 'crafting_table')) === 0 ? true : { table_left: 1 })),
    });
    await say('kill the husk', /^Successfully eliminated 1 husk/, {
        setup: async () => { const [x, , z] = await pos(BOT); await cmd(`summon minecraft:husk ${Math.floor(x) + 6}.5 -60 ${Math.floor(z)}.5 {Tags:["ic"]}`); await sleep(500); },
        check: async () => (!/^Test passed/.test(await cmd('execute if entity @e[tag=ic]')) ? true : { husk: 'alive' }),
    });
    await say('store planks', /^Successfully deposited 4 oak_planks/, {
        setup: async () => { await cmd(`tp ${BOT} 0.5 -60 0.5`); await cmd('setblock 3 -60 -6 minecraft:chest'); },
        check: async () => (/Count: 4b, Slot: \d+b, id: "minecraft:oak_planks"|id: "minecraft:oak_planks", Count: 4b/.test(await cmd('data get block 3 -60 -6 Items')) ? true : { chest: await cmd('data get block 3 -60 -6 Items') }),
    });
    await say('pull the lever', /^Successfully activated lever/, {
        setup: async () => { await cmd('setblock -3 -60 -5 minecraft:lever[face=floor,facing=north]'); },
        check: async () => (/^Test passed/.test(await cmd('execute if block -3 -60 -5 minecraft:lever[powered=true]')) ? true : { powered: false }),
    });
    await say('fly away', /^Failed fly: not available in the new action layer/);
    await say('collect a log then give it', /^Successfully gave 1 oak_log to Steve/, {
        setup: async () => { await cmd(`tp ${ME} 0.5 -60 3.5`); await cmd('setblock 2 -60 8 minecraft:oak_log'); },
    });
    // Cancellation: a long walk, interrupted by "stop": no arrival, and the bot stands still afterwards.
    {
        await cmd(`tp ${BOT} 0.5 -60 0.5`); await sleep(500);
        const n0 = system.length;
        steve.chat('-go far'); await sleep(4000);
        steve.chat('-stop'); await sleep(2500);
        const [x1, , z1] = await pos(BOT); await sleep(1500); const [x2, , z2] = await pos(BOT);
        const moved = Math.hypot(x2 - x1, z2 - z1), arrived = system.slice(n0).some((m) => /arrived at destination 120/.test(m));
        const ok = !arrived && moved < 0.05 && Math.hypot(x1, z1) > 3;
        results.push({ text: 'go far + stop', ok, moved, x1, z1 });
        console.log(`[check] ${ok ? 'PASS' : 'FAIL'} "go far" then "stop" -> walked to ${x1.toFixed(1)},${z1.toFixed(1)}, then moved ${moved.toFixed(3)} in 1.5 s, arrived=${arrived}`);
    }
    await say('find diamonds', /^Failed collect diamond_ore: diamond_ore not found within 32 blocks/);
    const promptChecks = prompts.filter((p) => /"action":"collect","target":"oak_log"/.test(p) && !/navigate_portal/.test(p)).length;
    console.log(`[check] prompts seen by the LLM: ${prompts.length}, all with the skills catalogue: ${promptChecks === prompts.length}`);
    const passed = results.filter((r) => r.ok).length;
    console.log(`[check] ${passed}/${results.length} passed`);
    steve.end(); rcon.close(); llm.close();
    for (const p of manager.bots.values()) p.kill('SIGTERM');
    setTimeout(() => process.exit(passed === results.length && promptChecks === prompts.length ? 0 : 1), 500);
}

main().catch((e) => { console.error('[check] fatal', e); process.exit(2); });
