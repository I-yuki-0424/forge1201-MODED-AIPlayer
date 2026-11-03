# TRAIN-STATUS-v1: the learning status, in formats anyone can open (2026-11-03)

Owner brief 2026-11-03, point 3: "the learning status is completely unknown ... keep the records in a general-purpose format
that can be viewed. I cannot judge whether to stop learning and rethink the design."

## What was missing

The learner wrote `train_log.jsonl` (one row per update, 69 numbers) and `episodes.jsonl` (one row per episode). Both are the
right data and both are unreadable as they are: nothing plotted them, nothing said what a flat curve means, and one number the
decision needs (does the critic predict returns at all) was not logged. Run sim1 ran 24 hours with progress flat at 14 of 24 and
the only way to see it was to read 1,786 JSON rows.

## What exists now

| Part | What it does |
|---|---|
| `tools/tblog` (Rust, std only) | Tails `exchange/<base>/train/{train_log,episodes}.jsonl`; writes `exchange/tb/<base>/events.out.tfevents.0.forgeaip` (TensorBoard scalars, x-axis = environment steps), `metrics.csv` (long format `wall_time,step,tag,value`: pandas, a spreadsheet, anything) and `status.json` (the verdict). Python's `NaN` is read as missing. The event file is rebuilt from the logs at start, so a restart never duplicates a curve. |
| `scripts/train/tb.sh` | `start --base B` runs the follower and TensorBoard on `127.0.0.1:6006` (reach it with `ssh -L 6006:127.0.0.1:6006`; there is no authentication, so loopback only, same rule as the MLflow UI); `status` prints the verdict of every base; `once` rebuilds the files once. |
| learner (`botsystem_goal_ppo.py`) | New logged number `expl_var` = 1 - Var(return - V) / Var(return) over the update's steps (1 = the critic is right, <= 0 = no better than the mean return). |

Checked: TensorBoard's own `EventAccumulator` reads the file written for run sim1 (69 scalar tags, 1,786 updates, 353 episodes,
values equal to the log); `cargo test` in `tools/tblog` covers the CRC-32C check value, the protobuf layout of an event, the verdict
rule and the reader (NaN, half-written last line).

## The verdict (fixed before looking at any new run)

Progress per episode (`terms.progress`, entries of the 24-entry progress list reached in the episode) is cut into blocks of 60
finished episodes. Block means are compared with combined standard errors, `z = (m_a - m_b) / sqrt(se_a^2 + se_b^2)`; the last
block against the one **two blocks earlier** (neighbouring blocks share policy versions and are correlated).

| Verdict | Rule |
|---|---|
| `warming` | fewer than 4 full blocks |
| `learning` | z(last, two blocks earlier) >= 2, or any of the last three blocks beats the best earlier block by z >= 2 |
| `regressing` | z(last, two blocks earlier) <= -2 |
| `stalled` | none of the above. **This is the signal to stop and rethink the design**, not to wait longer: three blocks (180 episodes) without a gain of two standard errors over the earlier best. |

Optimisation flags are printed next to it, each with the number it rests on, over the last 10 updates: entropy < 0.5 (collapse
onto few actions), clipfrac > 0.3 (updates leave the trust region: learning rate too high or data too stale), kl > 0.05,
explained variance < 0.1 (the critic is not learning), staleness > 6 updates. A flag does not change the verdict; it says where to
look first when the verdict is `stalled` or `regressing`.

What the rule does **not** decide: whether the simulator is faithful (that is the validation table in SIM-RUST-v1 section 10/11),
and whether progress in a simulator carries over to the real game (it has to be measured there with `--learn 0`). A `learning`
verdict on an unfaithful simulator means the policy learns the simulator.

## First reading (run sim1, 910,447 steps, 353 episodes)

`STALLED`. Progress per block of 60 episodes: 14.1 +- 0.6, 13.3 +- 0.7, 13.7 +- 0.6, 13.8 +- 0.6, 14.3 +- 0.5 (z last vs two
earlier 1.5). Flag: clipfrac 0.30 (the threshold). The same conclusion the previous session drew by hand from three 2-hour windows;
the tool reaches it from the log in under a second, and replayed over the log it says `stalled` from the first judgeable point (4 blocks, 10.9 h into the 15.7 h run; z 1.25), not `learning`, at every later point too.

## Training on the PC (2026-11-04)

`scripts/train/pc/wsl-sim.sh` (driven by `scripts/train/pc.sh wsl-up|wsl-down|wsl-status|wsl-pull`) runs each run under a supervisor that restarts a dead
learner (from its checkpoint) or shard, pauses in the quiet hours (12:00-18:00 JST), and writes the status where the owner looks:

- `C:\forgeaip\status.txt` (one block per run, every minute): steps, steps/s, entropy / clipfrac / kl / explained variance, the verdict with the
  progress blocks, the flags, and what STALLED / LEARNING mean;
- TensorBoard on the PC itself: <http://localhost:6006> in the Windows browser (all runs, scalars as in the VPS one); on the VPS the same files after `pc.sh wsl-pull`;
- stop with `scripts/train/pc.sh wsl-down [--base runa]` (the learner writes its checkpoint first).

## Files

`tools/tblog/{Cargo.toml,build.sh,src/main.rs}`, `scripts/train/tb.sh`, DPOD `scripts/botsystem_goal_ppo.py` (`expl_var`).
