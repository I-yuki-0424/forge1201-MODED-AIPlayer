// /dev: start and watch the bot tests from inside the game (T26 test worlds, docs/implemented/TEST-WORLDS-T26.md). Carpet scarpet app, loaded globally by scripts/t26/up.sh.
// The command only writes a request line to world/scripts/dev.data/requests.txt; scripts/t26/dev_watch.js (container forgeaip-t26-dev-N) runs the test and answers in chat.
// Watching needs nothing from the watcher: /dev follow <bot> puts the caller in spectator mode on the bot, /dev back returns to survival at the world spawn.

global_tests = ['move_a', 'move_b', 'mine_a', 'mine_b', 'place_a', 'place_b', 'temps'];

__config() -> {
    'scope' -> 'global',
    'commands' -> {
        '' -> 'help',
        'help' -> 'help',
        'run <test>' -> _(t) -> request('run', t, 1),
        'run <test> <reps>' -> _(t, n) -> request('run', t, n),
        'stop' -> _() -> request('stop', '-', 0),
        'status' -> _() -> request('status', '-', 0),
        'follow <bot>' -> 'follow',
        'back' -> 'back',
        'bots' -> 'bots',
    },
    'arguments' -> {
        'test' -> {'type' -> 'term', 'options' -> global_tests},
        'reps' -> {'type' -> 'int', 'min' -> 1, 'max' -> 20, 'suggest' -> [1, 3, 5]},
        'bot' -> {'type' -> 'term', 'suggester' -> _(args) -> map(player('all'), _ ~ 'name')},
    },
};

help() -> (
    print('/dev run <test> [reps]  start a test on this world: move_a (4 bots, 2000 blocks N/E/S/W), move_b (cave floor to surface), mine_a (4 bots: log, cobblestone, coal, raw iron, raw gold x8),');
    print('                        mine_b (strip-mine the spawn chunk, nothing may be left), place_a (30-block bridges 40 above ground), place_b (a structure, checked block by block), temps (temp blocks left by a pillar/descend run)');
    print('/dev stop | status      stop the running test | what runs, the last result');
    print('/dev follow <bot>       watch a bot in spectator mode;  /dev back  survival again at the spawn;  /dev bots  where every bot is');
);

request(what, test, n) -> (
    if(what == 'run' && global_tests ~ test == null, print(format('r unknown test ' + test)); return());
    p = player(); who = if(p == null, 'console', p ~ 'name');
    line = str('%d %s %s %s %d', unix_time(), who, what, test, n);
    write_file('requests', 'text', line);
    print(format('g request sent: ' + what + ' ' + test + if(n > 1, ' x' + n, '') + '  (the watcher answers in chat within 2 s)'));
);

follow(b) -> (
    p = player();
    t = player(b);
    if(t == null, print(format('r no player ' + b)); return());
    run(str('gamemode spectator %s', p ~ 'name'));
    run(str('spectate %s %s', b, p ~ 'name'));
    print(format('g following ' + b + ' (sneak to stop, /dev back for survival)'));
);

back() -> (
    p = player();
    run(str('gamemode survival %s', p ~ 'name'));
    s = world_spawn();
    run(str('execute in minecraft:overworld run tp %s %d %d %d', p ~ 'name', s:0, s:1, s:2));
);

world_spawn() -> (
    l = system_info('world_spawn_point');
    if(l == null, [0, 80, 0], l)
);

bots() -> (
    for(player('all'),
        pos = _ ~ 'pos';
        print(str('%s  %d %d %d  hp %.0f  %s', _ ~ 'name', pos:0, pos:1, pos:2, _ ~ 'health', _ ~ 'dimension'));
    );
);
