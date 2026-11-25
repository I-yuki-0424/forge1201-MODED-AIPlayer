// ntrace (TASK-20261125-076): records the SERVER's own player movement, tick by tick, for the native physics' golden traces.
// A carpet fake player is a ServerPlayer: its movement is the game's own player code (Player.tick -> aiStep -> travel -> move) run by the server.
// start(name, prog, n, tag): for n ticks, at the start of each tick log the player's state (= after the previous tick), then run the program's
// commands for this tick (carpet /player actions: move, sneak, sprint, jump ...), which the player's tick then uses.
// Output: world/scripts/ntrace.data/<tag>.txt, one line per tick: t x y z vx vy vz onGround pose
__config() -> {'scope' -> 'global', 'stay_loaded' -> true};

global_run = null;

start(name, prog, n, tag) -> (
    delete_file(tag, 'text');
    global_run = {'name' -> name, 'prog' -> prog, 't' -> 0, 'n' -> n, 'tag' -> tag};
    'started'
);

running() -> global_run != null;

__on_tick() -> (
    if (global_run == null, return());
    r = global_run;
    p = player(r:'name');
    if (p == null, global_run = null; return());
    t = r:'t';
    xyz = pos(p); m = p ~ 'motion';
    write_file(r:'tag', 'text', str('%d %.17f %.17f %.17f %.17f %.17f %.17f %d %s', t, xyz:0, xyz:1, xyz:2, m:0, m:1, m:2, if(p ~ 'on_ground', 1, 0), p ~ 'pose'));
    // '!command' runs as it is (a support taken away at tick 0), anything else is a /player action of the recorded player
    for (r:'prog', if (_:0 == t, c = _:1; if (slice(c, 0, 1) == '!', run(slice(c, 1)), run(str('player %s %s', r:'name', c)))));
    global_run:'t' = t + 1;
    if (t >= r:'n', global_run = null);
);
