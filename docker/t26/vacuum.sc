// vacuum: every second tick, item entities within 5 blocks of a SURVIVAL player are put at the player's position with no pickup delay, so a block the player breaks goes straight into the pack
// (owner 2026-11-21: "make broken blocks go directly into the inventory"; the builders' temporary blocks, pumpkins in the iron-farm run, come back instead of lying where they fell).
// Carpet scarpet app, loaded globally by scripts/t26/vacuum.sh. `/vacuum off` and `/vacuum on` switch it.
__config() -> {
    'scope' -> 'global',
    'commands' -> {
        'on' -> _() -> (global_on = true; print('vacuum on')),
        'off' -> _() -> (global_on = false; print('vacuum off')),
    },
};
global_on = true;
__on_tick() -> (
    if(global_on && tick_time() % 2 == 0,
        for(player('all'),
            p = _; pp = pos(p);
            if(query(p, 'gamemode') == 'survival',
                for(entity_area('item', pp, [5, 3, 5]), modify(_, 'pickup_delay', 0); modify(_, 'pos', pp))
            )
        )
    )
);
