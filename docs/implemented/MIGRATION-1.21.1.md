# MIGRATION-1.21.1: the move from Fabric 26.1.2 to Fabric 1.21.1 (test worlds, creative server, bots, the owner's PC instance)

`TASK-20261125-074` (owner list 5, 2026-11-25: Medium 1, Small 4, Small 5; contract in docs/proposed/OWNER-LIST-5.md). The owner: the compatibility of Fabric 26.x is poor (the bot's
inventory clicks and other mods conflict); the system must not depend on one version; move to Fabric 1.21.1 and later; keep only the creative server's data of 26.x, freeze and stop the
rest; downgrade the mods; carry the PC instance over; add Inventory Peeker. Small 4: every temporary block on the test servers is a pumpkin. Small 5: the items of a broken block go
straight into the inventory.

## What decides the version

One file: the test-world profile `docker/tw/<name>.json` (Minecraft version, loader, the bots' protocol version, the server image by digest, name tag, port base, the server mods pinned
by sha512). `docker/tw/PROFILE` names the current one (`fabric-1.21.1`); `TW_PROFILE=<name>` picks another for one command; `scripts/t26/profile.sh` is the only reader. No other script
or module names a version: the bots get `MC_VERSION` from the profile, and a Fabric bot without it asks the server (`src/transport/platform.js`: no default version). A later version
(1.21.x, 26.x) is a new profile file: image, version, `bot`, mods. Details and the commands: docs/implemented/TEST-WORLDS-T26.md.

| Profile | Test worlds | Ports (tailnet 100.77.246.23) | State |
| :-- | :-- | :-- | :-- |
| `fabric-1.21.1` | `forgeaip-w121-N` (N 1..9), volumes `forgeaip-w121-N_data` | 25621..25629 | current |
| `fabric-26.1.2` | `forgeaip-t26-N`, volumes `forgeaip-t26-N_data` | 25591..25599 | frozen; `TW_PROFILE=fabric-26.1.2 scripts/t26/up.sh N` starts one again |

## The 26.x freeze (2026-11-25 23:15 JST)

Stopped, nothing deleted (the list with the restart commands is in TEST-WORLDS-T26.md "The frozen 26.x set"): T26 worlds 1-4 and their watchers (5-9 were not running; volumes 1-6
kept); `fabric26-console-survival-hard` and `fabric26-console-survival-op` (their servers had been exited since 2026-11-23). Before stopping, survival-op's running job **`j2`** (pit
16x16x140, 0 of 70 units done, no bots) was **paused** through the console's API (`POST /api/jobs/j2/pause`); survival-hard had no job. **Kept running and untouched:**
`fabric26-creative` (25601) and `fabric26-console-creative` (3031).

## Differences between 26.1 and 1.21.1 and what became of each 26.1-specific patch

| Area | 26.1 | 1.21.1 | Now |
| :-- | :-- | :-- | :-- |
| Game rule names | snake_case (`keep_inventory`) | camelCase (`keepInventory`) | `scripts/t26/rule.sh` and the harness's RCON (`lib.js ruleSpellings`) send the spelling the server accepts; the console's overlay already tried both (`src/work/display/overlay.js`) |
| World folder | `dimensions/minecraft/<dim>/region` | `region`, `DIM-1/region`, `DIM1/region` | `src/work/world/maps.js` reads either (the 26.x consoles needed a symlinked `mapview`; a 1.21.1 console mounts the world directly) |
| Protocol | 775 | 767 | mineflayer 4.39 speaks both; the version comes from the profile or the server's status ping |
| Item components | `enchantments` component | also components (1.20.5+), same `{enchantments: [{id, level}]}` shape | `fabric_bot.fixDigTime` normalises every shape (list, `enchantments`, `levels`); not version-gated because it keys on the data |
| Numeric ids | registry of 26.1 | registry of 1.21.1 | always from the connected version's registry (`bot.registry`); the enchantment names in fixDigTime are looked up there |
| Carpet scripts (`/dev`, vacuum) | carpet 26.1 | carpet 1.4.147 | `dev.sc` loads and writes its request file unchanged (`unix_time()` is milliseconds on 1.4.147: the watcher reads only the words after it) |
| Syncmatica | 0.3.20 | 0.3.14-sakura.5 on the server | the server accepts the bots' client announcing 0.3.20 ("Syncmatica client joining with local version 0.3.14-sakura.5 and client version 0.3.20"); share, download and parse of the iron-farm blueprint pass (`syncmatica_probe.js`, world 2) |
| Litematica data version | 5023 (26.3) | 3955 | every block and property of the owner's 10 schematics exists in 1.21.1 (palette check below) |
| Drops into the pack | carpet `vacuum.sc` (any item near a survival player) | simple-autopickup 1.4.20 (the breaker's own drops; a full pack drops normally) | test servers only; production consoles unchanged |
| Server pause when empty | `pause-when-empty-seconds` | does not exist | the property is still set (ignored on 1.21.1) |

Checks of the move (graded by the server): `scripts/t26/version_probe.js` **9/9** on 1.21.1 (login, inventory, enchanted pickaxe read, dig, drop into the pack, full pack drops, pumpkin
placed, walk, chat); `scripts/t26/login_probe.js` on the **26.x creative server**: the deployed code still logs in there as 26.1, by `MC_VERSION` and by the ping (a live check of the
version independence; it changes nothing in the world).

## Server mods (test worlds and the 1.21.1 creative server)

`docker/tw/fabric-1.21.1.json`: fabric-api 0.116.18, carpet 1.4.147, lithium 0.15.4, ferritecore 7.0.3, krypton 0.2.8, ksyxis 1.4.6, scalablelux 0.1.0.1, servux 0.3.17, syncmatica
0.3.14-sakura.5, appleskin 3.0.6, jade 15.10.6, shulkerfix 1.5.1, simple-autopickup 1.4.20, Inventory Peeker 1.6.0. Left out: ViaVersion/ViaFabric (the owner's client is 1.21.1).
shulkerfix 1.7.x lists 1.21.1 but its minecart mixin fails to apply there and the server does not start (`InvalidInjectionException ... method_7525`); 1.5.1 is the newest that runs.

**Inventory Peeker**: there is no Modrinth project of that name; the mod whose files and releases are named "Inventory Peeker" is Modrinth/CurseForge `disgrade` (displayed as "Peeksy",
by SAYMYNAME_UPIIISHER / Disgrade): it opens **other players' inventories** (by its page: Shift + right click on a player, a player list, a quick peek, pinned inventories on the HUD; the keys of the
1.21.1 build were not checked), so the owner can look into a bot's pack from the game. It must be on the server and the client (both done). Its page warns of conflicts with mods that change GUI logic, naming Inventory Profiles Next,
which the owner's instance has: to be checked by the owner in the game.

## The 1.21.1 creative standing server and console

`docker/tw/creative.yaml`, `scripts/t26/creative.sh up|down|status|restart-console|rcon`: `fabric121-creative` on **100.77.246.23:25620** (seed 1359280, creative, forced game mode,
Normal), the same mods as the test worlds, operator only **Seia_Y** (ops.json by the offline-mode UUID before the first start); console `fabric121-console-creative` on
**100.77.246.23:3034** (the main checkout read-only, `MC_VERSION` from the profile, data in `/mnt/data/forgeaip-play/creative121/console-data/creative`, world folder mounted directly).
Both `restart: unless-stopped` (they come back after a reboot of the host). RCON is not published; `ss -ltn` shows 25620 and 3034 on the tailnet address only.

Unauthenticated requests, checked the same way on 3031 (26.x) and 3034 (1.21.1), identical answers: page 200; `/api/state`, `/api/jobs`, `POST /api/jobs` without a session 401;
a foreign Host 421; `X-Forwarded-For` or `Cf-Connecting-Ip` without an Access assertion 403; a POST with a session but no CSRF header 403, with the CSRF header and a foreign Origin 403.
Functional check (2026-11-26 00:25): a bot added through the console's API came online on 1.21.1 (`Work1`), the map view listed the overworld's regions from the mounted world folder; the
bot was removed again, so the world is as new.

## The owner's PC instance

Instances of GDLauncher (`instance.json` + the game folder `instance/`; loader Fabric 0.20.1 in both). Source `E:\Minecraft JAVA\instances\fabric 26.3\instance` was only read.
The target `E:\Minecraft JAVA\instances\Fablic1.21.1` was zipped first: **`E:\Minecraft JAVA\instances\Fablic1.21.1-backup-20261126-0010.zip`** (22.9 MB; it held no mods, no config,
no saves). The game was not launched: the owner checks it.

**Mods** (each source jar identified on Modrinth by its sha1, then the newest Fabric 1.21.1 release; downloaded, sha512 checked, every jar's `fabric.mod.json` read: every required mod id
of the set is present, the malilib family fits its `breaks` ranges, Iris 1.8.14 wants Sodium 0.8.x and gets 0.8.13): **49 jars** in `instance/mods`, sha512 on the PC equal to the
checked files (49 of 49; three of them replaced after the first start, below). Sodium Extra stays disabled as in the source.

| Source (26.3) | 1.21.1 | Note |
| :-- | :-- | :-- |
| `appleskin-fabric-mc26.3-3.0.10.jar` | `appleskin-fabric-mc1.21-3.0.6.jar` | release |
| `bobby-5.2.16+mc26.3.jar` | `bobby-5.2.4.1+mc1.21.jar` | release; matched by name to Modrinth 'bobby' |
| `cloth-config-26.3.158.jar` | `cloth-config-15.0.140-fabric.jar` | release; matched by name to Modrinth 'cloth-config' |
| `collective-26.3.0-8.86.jar` | `collective-1.21.1-8.88.jar` | release |
| `cull-fewer-leaves-1.1.2+26.1-fabric.jar` | `cull-fewer-leaves-1.1.2+1.21.1-fabric.jar` | release |
| `dynamic-fps-3.11.10+minecraft-26.3.0-fabric.jar` | `dynamic-fps-3.11.4+minecraft-1.21.0-fabric.jar` | release |
| `enhancedblockentities-0.13.3+26.3-fabric.jar` | `enhancedblockentities-0.13.3+1.21-fabric.jar` | release |
| `entityculling-fabric-1.12.0-mc26.3.jar` | `entityculling-fabric-1.12.2-mc1.21.1.jar` | release |
| `EssentialClient-2.8.0+26.3.jar` | `EssentialClient-2.2.3+1.21.1.jar` | release |
| `fabric-api-0.166.2+26.3.jar` | `fabric-api-0.116.18+1.21.1.jar` | release |
| `fabric-carpet-26.3+v260915.jar` | `fabric-carpet-1.21-1.4.147+v240613.jar` | release |
| `fabric-language-kotlin-1.14.2+kotlin.2.4.21.jar` | `fabric-language-kotlin-1.13.4+kotlin.2.2.0.jar` | release; see "First start" below |
| `fastquit-3.1.5+mc26.2.jar` | `fastquit-3.0.0+1.20.6.jar` | release |
| `ferritecore-9.0.0-fabric.jar` | `ferritecore-7.0.3-fabric.jar` | release |
| `g4mespeed-1.6.1-mc26.3.jar` | `g4mespeed-1.4.8-mc1.21.1.jar` | release |
| `globalnarrationtoggle-26.3.0-1.5.jar` | `globalnarrationtoggle-1.21.1-1.5.jar` | release |
| `ImmediatelyFast-Fabric-1.17.1+26.3.jar` | `ImmediatelyFast-Fabric-1.6.15+1.21.1.jar` | release |
| `InventoryProfilesNext-fabric-26.3-2.3.8.jar` | `InventoryProfilesNext-fabric-1.21-2.2.0.jar` | release; the newest that accepts that Kotlin |
| `iris-fabric-1.11.7+mc26.3.jar` | `iris-fabric-1.8.14-beta.1+mc1.21.1.jar` | release |
| `itemscroller-fabric-26.3-0.33.1.jar` | `itemscroller-fabric-1.21-0.24.60.jar` | release |
| `Jade-mc26.3-Fabric-26.3.5.jar` | `Jade-1.21.1-Fabric-15.10.6.jar` | release |
| `jei-26.3-fabric-31.17.0.113.jar` | `jei-1.21.1-fabric-19.64.0.455.jar` | release |
| `krypton-0.3.2.jar` | `krypton-0.2.8.jar` | release |
| `Ksyxis-1.4.6.jar` | `Ksyxis-1.4.6.jar` | release |
| `libIPN-fabric-26.3-6.9.0.jar` | `libIPN-fabric-1.21-6.6.0.jar` | release; the newest that accepts that Kotlin |
| `libjf-26.3.1.jar` | `libjf-3.17.5.jar` | release |
| `litematica-fabric-26.3-0.29.1.jar` | `litematica-fabric-1.21-0.19.61.jar` | release |
| `lithium-fabric-0.26.3-mc26.3.jar` | `lithium-fabric-0.15.4+mc1.21.1.jar` | release |
| `malilib-fabric-26.3-0.30.2.jar` | `malilib-fabric-1.21-0.21.10.jar` | release |
| `matlib-1.0.0+26.3-fabric.jar` | `matlib-1.0.1+1.21-fabric.jar` | release |
| `mezz_config-26.3-fabric-0.7.1.jar` | `mezz_config-1.21.1-fabric-0.7.1.jar` | beta |
| `minihud-fabric-26.3-0.41.2.jar` | `minihud-fabric-1.21-0.32.60.jar` | release |
| `modernfix-5.27.20-build.2.jar` | `modernfix-fabric-5.25.1+mc1.21.1.jar` | release; matched by name to Modrinth 'modernfix' (the official ModernFix; the source ran the mvus fork, which has no 1.21.1 build) |
| `modmenu-21.0.1.jar` | `modmenu-11.0.5.jar` | release |
| `NBTac-FABRIC-26.3-2.1.jar` | `NBTac-FABRIC-1.21.1-2.1.jar` | release |
| `placeholder-api-3.1.0-beta.1+26.2.jar` | `placeholder-api-2.4.2+1.21.jar` | release |
| `replaymod-26.3-2.6.28.jar` | `replaymod-1.21-2.6.28.jar` | release |
| `respackopts-26.3.0.jar` | `respackopts-4.14.0+1.21.1.4.jar` | release |
| `rrls-5.2.8+mc.26.3.jar` | `rrls-5.0.11+mc1.21.1-fabric.jar` | beta |
| `ScalableLux-fabric-mc26.3-0.3.0-alpha.0.6-all.jar` | `ScalableLux-0.1.0.1+fabric.d0d58ab-all.jar` | release |
| `sodium-extra-fabric-0.9.6-beta.4+mc26.3.jar.disabled` | `sodium-extra-fabric-0.9.5+mc1.21.1.jar.disabled` | release |
| `sodium-fabric-0.9.2+mc26.3.jar` | `sodium-fabric-0.8.13+mc1.21.1.jar` | release |
| `syncmatica-fabric-26.3-0.3.20.jar` | `syncmatica-fabric-1.21-0.3.14-sakura.5.jar` | release |
| `tweakermore-v3.33.3-beta.1-mc26.3.jar` | `tweakermore-v3.33.2-mc1.21.1.jar` | release |
| `tweakeroo-fabric-26.3-0.30.1.jar` | `tweakeroo-fabric-1.21-0.21.61.jar` | release |
| `xaerominimap-fabric-26.3-26.6.2.jar` | `xaerominimap-fabric-1.21.1-26.6.0.jar` | release |
| `xaeroworldmap-fabric-26.3-1.47.2.jar` | `xaeroworldmap-fabric-1.21.1-1.47.0.jar` | release |
| `yet_another_config_lib_v3-3.9.7+26.3-fabric.jar` | `yet_another_config_lib_v3-3.8.2+1.21.1-fabric.jar` | release |
| `(new)` | `invpeeker-1.6.0-fabric-1.21.0-1.jar` | release; added (owner list 5) |

**Left out (no usable 1.21.1 build found here):**

| Source | Why |
| :-- | :-- |
| `Better-Ping-Display-Remake-Fabric-26.3-.Dappled_Forest.1.6.1.jar` | no Fabric 1.21.1 build on Modrinth |
| `cupboard-fabric-26.3-4.2.jar` | not on Modrinth (CurseForge or the author's site; no CurseForge API key here): download by hand if wanted |
| `gpumemleakfix-fabric-26.3-1.9.jar` | not on Modrinth (CurseForge or the author's site; no CurseForge API key here): download by hand if wanted |
| `nvidium-0.4.4-beta7-26.3.jar` | the only 1.21.1 build (0.3.1) needs Sodium 0.5.9/0.5.11; the 1.21.1 Sodium is 0.8.13 (Iris 1.8.14 needs 0.8.x): left out |
| `WI-Zoom-1.7-MC26.3.jar` | not on Modrinth (CurseForge or the author's site; no CurseForge API key here): download by hand if wanted |
| `xwm-replay-fix-1.1.0.jar` | not on Modrinth (CurseForge or the author's site; no CurseForge API key here): download by hand if wanted |

The four that are not on Modrinth are CurseForge projects; without a CurseForge API key they were not fetched (none of them is required by a carried mod: the dependency check found
nothing missing). The owner can add them by hand if 1.21.1 files exist there (unverified).

**Configs:** `config/` copied per mod (49 entries; the files of the two left-out mods with a config, `cupboard.json` and `betterpingdisplay.json`, not copied). All 118 JSON files parse.
The 1.21.1 builds are older than the 26.3 ones that wrote these files: malilib (Litematica, MiniHUD, Tweakeroo, Item Scroller, TweakerMore), Cloth/YACL and Jade read the options they
know and keep defaults for the rest; mixin option files (`lithium.properties` holds no options, `modernfix-mixins.properties`, `sodium-mixins.properties`) name mixins that the older
builds may not have, which they skip with a warning. Not checked in the game.

**Litematica schematics:** all 10 files copied (`schematics/` with its folders). Data versions: 7 files 5023 (26.3), 3120, 2730 and 2566 for the older three; 1.21.1 is 3955. A palette
check against the 1.21.1 block registry (minecraft-data 1.21.1): **no block and no block-state property of any of them is missing in 1.21.1**. The 26.3 files are newer than the game;
Litematica 1.21.1 reads their palettes by name (nothing to rename), and their tile-entity data uses item components in both versions. To be confirmed in the game.

**Key bindings** (`options.txt`): the target's own lines (written by the 1.21.1 client) kept; 34 vanilla bindings taken from the source (17 differ from the
1.21.1 defaults, e.g. sprint Q, drop T, chat Enter, hotbar 5-9 on mouse 4 / R / F / V / C); 5 vanilla bindings of 26.x that 1.21.1 does not have were not written
(`key_key.friends`, `key_key.toggleGui`, `key_key.toggleSpectatorShaderEffects`, `key_key.spectatorHotbar`, `key_key.quickActions`); 131 mod binding lines copied as they are (a mod that is absent ignores its lines;
this includes 26.x's own debug bindings `key_key.debug.*`, which 1.21.1 ignores, and the bindings of WI Zoom and Better Ping Display, which were left out). The malilib hotkeys travel
inside their mods' configs (`litematica.json` Hotkeys and the like).

**First start (the owner, 2026-11-26 00:26-00:34, three tries): crash** `NoClassDefFoundError: kotlinx/datetime/Clock$System` in EssentialClient 2.2.3+1.21.1
(`crash-2026-11-26_00.34.40-client.txt`). Cause: that build (the newest for 1.21.1; its `fabric.mod.json` does not declare the Kotlin it needs) calls `kotlinx.datetime.Clock`, which
kotlinx-datetime moved to `kotlin.time` in 0.7; fabric-language-kotlin bundles kotlinx-datetime 0.8.0 from 1.13.12 on and 0.7.1 from 1.13.5 on, only 1.13.4 and older bundle 0.6.2
(checked in each jar: `kotlinx/datetime/Clock$System.class` is in 1.13.4's). Fix: fabric-language-kotlin **1.13.4+kotlin.2.2.0**, and the newest Inventory Profiles Next / libIPN that
accept it (**2.2.0 / 6.6.0**; 2.2.6 / 6.6.3 need Kotlin 1.13.10 / 1.13.7). The other mods of the set declare nothing above 1.13.4. Not checked by a start (the game is not launched
from here): the owner starts it again. EssentialClient's 26.3 config has a key the 1.21.1 build reads differently (`essentialClientMenuKeys`: left at its default, logged).

**Inventory Peeker** (`invpeeker-1.6.0-fabric-1.21.0-1.jar`) added to the instance and to the servers (see above). Its page names Inventory Profiles Next as a conflicting GUI mod; both
are installed: if the game shows the conflict, one of the two has to go (owner's choice).

## Test results on 1.21.1 next to the last 26.x ones

Every 1.21.1 run: three NEW random-seed worlds (`suite.sh`, worlds 1-3), graded by the server, the mineflayer physics/inventory/dig (TASK-076's native layer was not in these
checkouts, or switched off with `NATIVE_*=0`), temporary blocks pumpkins, drops into the pack by the auto-pickup mod. The 26.x column is the last suite of that test on the T26 worlds
(results in TEST-WORLDS-T26.md); the code differs between the two dates, so a difference is a lead, not a proof.

| Test | 1.21.1 (run, seeds in TEST-WORLDS-T26.md) | Last 26.x | Reading |
| :-- | :-- | :-- | :-- |
| `place_a` | **12/12 = 100 %: success** (`pa-w121-a`), bridges of pumpkins | 12/12 (`pa-b`) | same |
| `move_a` | **6/12 = 50 %: failure** (`ma-w121-a`): deaths at night and at sea, stuck at sea after a death | 8/12, 6/12, 6/12 (`ma-2000-f`, `-e`, `-d`) | the same failure classes on both: not a migration fault; open as before |
| `move_b` | **3/3 = 100 %: success** (`move_b-w121-a`) | 2/3 (`mvb-d`) | passes on 1.21.1 |
| `mine_a` | **10/12 = 83 %: failure** (`mine_a-w121-a`; w1 3/4, w2 3/4, w3 4/4). Mn3w1 started floating on deep water (water y 51-62 under it, 2000 blocks from the spawn) and found nothing to gather in reach; Mn3w2 sank into a lake while prospecting coal and looped the breath reflex until its harness was stopped at 01:18 after 63 min (to keep the reboot window free; its three passes are in the log, the world's JSON was not written: the suite's verdict shows worlds 1 and 3) | 12/12 (`mna-layer-a`, with 64 cobblestone in the kit) | both failures are water starts/lakes; 26.x's kit met the cobblestone goal by itself. Open (not version-specific in the evidence): a bot that starts or sinks in deep water |
| `place_b` | **3/3 = 100 %: success** (`place_b-w121-a`, graded by hand from the three JSONs: the suite's grading line was lost to an edit of `suite.sh` during the run) | 3/3 (`pb-g`) | same |
| `place_c` | **0/3: failure**, all three at the 20-minute limit (`place_c-w121-a`): 848, 1074 and 1043 of 1288 cells right at 18 min; the blueprint came through Syncmatica on all three (share, download, parse); controls fail as they must | 0/1 on each of three single-world runs (`dev-place_c_*`, 2026-11-19: timeouts at 20 min) | the same limit is missed on both; the build itself runs on 1.21.1 (TASK-081 owns the build) |
| `mine_b` | running after the reboot window: `/mnt/data/forgeaip-play/t26/out/stageb/chain3.sh` (runs `mine_b-w121-a`, up to 240 min, from 06:10 after the build_t smoke) | 0/3 (`mnb-layer-a`) | |
| `build_t` smoke | **0/3: timeout at the limit, as every crew run on 26.x** (`build_t-w121-smoke`, run 07:35-08:20 on 2026-11-26 by chain3, NATIVE_*=0, 8 bots, iron-farm-34, 30 min + wrap-up, 40.4 / 42.4 / 40.5 min; seeds 2707280068837369418, -7105938803988343922, 6775667803561947111). Wrong cells at the end (138 240 judged): 8 666, 7 651, 25 893; in w1 and w2 mostly the unbuilt build (glass 2.8k / 2.5k, smooth stone 1.6k / 1.5k, nether portal 1 512, obsidian 1 055 / 931, beds 334 / 300); w3 has 16.9k `air <- stone/dirt/bamboo/...` = the site was not cleared (a jungle/bamboo site draw, 'no way to' errors). Pumpkins still standing in the last progress line: 24, 32, 36 (w1 22 'c: released, not tried yet / no face in sight', w2 31, w3 20 + 13 'a: no entry'), i.e. the 075 wrap-up did not empty them within WRAP_MIN. Not a pass and not claimed as one (smoke) | every crew FAIL in the 26.x batches (`hc1`, `hd1`) | the migration runs the build; the open causes are 075's (temporary blocks left at the end) and 081's (clearing, pace), not the version |


## What other tasks must know

- Containers `forgeaip-w121-N` / `forgeaip-w121-dev-N` / `live-w121-N-<pid>`, ports 2562N; slots per task in OWNER-LIST-5.md. Mod jars in `/mnt/data/forgeaip-play/tw/<tag>/mods`.
- Harness environment from `run.sh`/`dev.sh`: `MC_VERSION` (profile), `TW_PROFILE`, `TEMP_BLOCK=pumpkin` (kit and the bots' choice; `TEMP_BLOCK=cobblestone` for one run). Reports carry
  `profile` and `version`.
- `gameVersion()` returns `false` for Fabric without `MC_VERSION` (mineflayer pings the server). The 26.x consoles set `MC_VERSION=26.1` and are unchanged.
- `mine_a`'s cobblestone goal was met by the 26.x kit itself (64 cobblestone); with pumpkins in the kit it is a real goal now: compare the two versions' `mine_a` with that in mind.
- Do not edit a test-world script while a suite runs it: bash reads a script as it goes, and the edit of `suite.sh` during `place_b-w121-a` cut the run's grading off (graded by hand).

## Definition of done (OWNER-LIST-5.md) and where each item stands (2026-11-26 02:00 JST)

| Item | State |
| :-- | :-- |
| 26.x frozen except creative, list in the doc | done (above; TEST-WORLDS-T26.md has the restart commands) |
| `npm test` green | done (84 files, after the last rebase) |
| each T26 test once on three new 1.21.1 worlds, next to the last 26.x result | done for place_a, move_a, move_b, mine_a, place_b, place_c; `mine_b` and the `build_t` smoke run after the reboot window (06:10, detached script above); no test fails only on 1.21.1 so far |
| pumpkins and auto-pickup verified live | done (`version_probe.js` 9/9; place_a bridges are pumpkins) |
| creative 1.21.1 server and console up, checked unauthenticated | done (25620 / 3034; identical answers to 3031; assets ready for 1.21.1) |
| PC instance carried over with the lists | done; the first start crashed (Kotlin, fixed above); the owner starts it again |
| this doc | done; the `mine_b` and `build_t` rows are filled when their runs end |
