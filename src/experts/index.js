'use strict';
// The trained RL skill experts as a library for the bots (docs/implemented/EXPERTS-v1.md): `walk` (the movement expert: to a cell, round ponds and hills, digging only when the
// way is closed) and `escape` (the stuck-escape expert: out of a shaft or a sealed pocket by tunnelling and climbing). Weights: models/experts/<name>.json (moe/export.py).
const fs = require('fs');
const path = require('path');
const policy = require('./policy');
const runner = require('./runner');

const DIR = path.join(__dirname, '..', '..', 'models', 'experts');
const loaded = new Map();
function expert(name) {
    if (!loaded.has(name)) loaded.set(name, { name, model: policy.load(JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8'))) });
    return loaded.get(name);
}

/** Item vocabulary (index -> name) of a bot's registry, cached on the bot. */
function vocabOf(bot) {
    if (!bot.__expertVoc) bot.__expertVoc = require('../rl/skill_space').vocab(bot.registry, null);
    return bot.__expertVoc;
}

/**
 * Let expert `name` ('move' | 'unstick') take the bot to `target` {x,y,z}. `o`: exec(name, args) (the action layer with the caller's cancel and options), cancel?, maxSteps?, maxMs?,
 * onStep?. Returns runner.run's result, plus `from` and `to` (feet cells).
 */
async function drive(bot, name, target, o = {}) {
    const { ExpertSpace } = require('./space');
    const { execute } = require('../skills');
    const { feetCell } = require('../skills/motion');
    const voc = vocabOf(bot), space = o.space || new ExpertSpace(bot, voc), cancel = o.cancel || { cancelled: false };
    const here = () => feetCell(bot.entity.position), from = here();
    const exec = o.exec || ((n, a) => execute(bot, n, a, { cancel }));
    const res = await runner.run(expert(name), target, { space, exec, here, names: voc.items, cancel, maxSteps: o.maxSteps, maxMs: o.maxMs, onStep: o.onStep, rnd: o.rnd });
    return { ...res, from, to: here(), expert: name };
}
const walk = (bot, target, o) => drive(bot, 'move', target, o);
const escape = (bot, target, o) => drive(bot, 'unstick', target, o);

module.exports = { walk, escape, drive, expert, vocabOf };
