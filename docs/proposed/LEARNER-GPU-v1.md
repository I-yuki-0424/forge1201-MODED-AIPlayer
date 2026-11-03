# LEARNER-GPU-v1: where the learner's time went, what was changed, what still needs the GPU (2026-11-03)

Owner brief 2026-11-03, point 4: "the benefit of the Rust simulator is poor; the model update and the policy decision were the
slow parts; enable the GPU, make it massively parallel and put the computation into large matrices; the PC's CPU spikes but is
nowhere near its limits". Measured first, changed second. Code: DPOD `scripts/botsystem_goal_ppo.py`, `botsystem_goal_wm.py`,
`integrations/botsystem/protocol.py`; here `scripts/train/profile_learner.py`, `scripts/train/profile_server.sh`.

## 1. Why the simulator did not help: the learner was the whole cycle

`scripts/train/profile_learner.py` on real observations (any `env_to_policy.jsonl`), VPS, 4 threads, same load for old and new:

| Stage (old code) | Time | Share of one update |
|---|---:|---:|
| PPO pass, 4 segments x 32 steps, forward + backward | 1,275 ms per gradient step | 43 % |
| self-imitation pass, 4 chunks x 32 steps | 1,141 ms | 39 % |
| world-model auxiliary loss, 64 samples | 309 ms | 11 % |
| plan loss on an all-masked dummy batch (list mode has no plans) | 213 ms | 7 % |
| one update = 12 gradient steps (3 epochs x 4 minibatches) | **33.2 s for 512 steps = 15 steps/s** | |
| policy forward for one observation (N = 1 / 16 / 256) | 3.9 / 1.7 / 1.3 ms per observation | |

A bot step therefore cost 65 ms of learner time to train and 1.7 ms to decide. The simulator produces a step in well under a
millisecond, so a run was 15 steps/s whatever the simulator did; run sim1 (910k steps) took 15.7 h for that reason. The
"policy decision" was not the slow part at that rate; the update was, by 40x.

The cost is arithmetic, not overhead: one observation is 194 tokens through a 2-layer d = 64 transformer, about 60 MFLOP forward
(estimate from the layer sizes, not measured), three times that with the backward pass, and one update runs about 4,200 such
passes. 33 s for roughly 0.7 TFLOP is ~20-30 GFLOPS: the CPU is busy, which is also why the PC's CPU "spikes": the learner takes
every core for the length of an update, then waits for data.

## 2. What changed (all equal in value, checked against the old computation)

1. **The encoder runs over the whole minibatch at once.** The old `_unroll` ran the 194-token encoder inside a 32-step `lax.scan`
   on 4 sequences, although the encoder does not depend on the recurrent state (only the GRU and the candidate readout do).
   `GoalWM.unroll` encodes all B x T observations in chunks of `--enc-chunk` (default 512) under `jax.checkpoint` (memory of one
   chunk, matrices of chunk x 194 rows) and scans only the recurrence. Test: values and gradients equal the step-by-step scan
   (`tests/test_botsystem_unroll.py`, chunks of 4, 7 and 512 over 15 observations; relative error < 2e-3 on gradients).
2. **PPO and self-imitation share one pass** (`_loss` concatenates their batches: one larger matrix instead of two); equal to the
   separate computation (test).
3. **The empty plan batch is skipped** (`use_plan` static): in list mode `plan_replay` is empty and the dummy batch contributed
   exactly 0 at the price of a full pass; equal values and gradients (test).
4. **Serving pads to the next power of two**, not to `--n-max` (a poll with 3 observations costs 4 rows, not 16, or 256 on a GPU).
5. **`expl_var`** (explained variance of the critic) is logged, for the learning-status verdict (TRAIN-STATUS-v1).
6. **Batch sizes scale with one flag**: `--scale N` multiplies `--batch-segs`, `--aux-batch`, `--sil-batch`, `--plan-batch` where
   they were left at the default; `--tf32 1` turns on TensorFloat-32 matmuls. The PC supervisor passes `--scale 8 --tf32 1
   --n-max 256 --enc-chunk 512` when the learner runs on the GPU (`gpu.json`), and starts the learner at normal priority (servers
   and environments stay below normal; quiet hours 12-18 JST and the PAUSE file still apply).

Measured on the same VPS, same inputs: update of 512 steps **33.2 s -> 26.3 s (items 1-2) -> 22.8 s (item 3) = 15 -> 22
steps/s on CPU**. That is what restructuring buys on a processor that is already FLOP-bound; the large factor is the GPU
(section 4).

## 3. The policy decision: the real cost was validation, not the model

`scripts/train/profile_server.sh` (6 simulator shards x 2 bots against the learner process under cProfile, serving only):

| | before | after |
|---|---:|---:|
| steps/s the learner process can serve (3 CPUs) | 120 | **221** |
| `check_obs`: validation of each observation | 932 us (44 % of the process) | 188 us |

`protocol._shape_ok` walked ~1,900 numbers of every observation with a Python call per number. It now checks the innermost lists
with C-level builtins (exact element types through `set(map(type, ...))`, finiteness through `map(math.isfinite, ...)`), standard
library only (a test forbids anything else in `integrations/botsystem`), same verdicts: the old recursion is kept as the
reference in `tests/test_botsystem_interface.py` and agrees on 36,000 random values (NaN, inf, bool, None, strings, ragged lists).

What is left at 221 steps/s: the model forward about 38 % (1.8 ms per observation on CPU; on a GPU one batched call), JSON decoding 6 %,
validation 10 %, goal bookkeeping and `handle` 13 %, one-time compilation 12 %. Python work per step is about 1.9 ms, so one
learner process tops out near **500 steps/s whatever the device**; beyond that the observation transport (JSON text) and the
per-step bookkeeping would have to be batched or split over processes. Not needed before the GPU removes the other two terms.

## 4. The GPU: what is ready, what is not

Ready: the learner picks a CUDA device by itself (JAX does; the log row `devices` shows it), the large-matrix path is the same code
as the CPU path (the tests above), `--scale 8 --tf32 1` are applied by the supervisor when `gpu.json` exists,
`scripts/train/pc.sh gpu-setup` installs CUDA JAX into WSL2.

Not done, and why: **the PC has no WSL2** (`pc.sh gpu-setup` says so), and JAX has no CUDA wheels for native Windows, so no GPU
run was possible in this session; the GPU speed-up is a prediction, not a measurement. The prediction: ~0.7 TFLOP per update at
a realistic 3-5 TFLOPS of the RTX 3060 Ti for matrices of this size is 0.15-0.25 s instead of 23 s; with `--scale 8` (4,096
transitions per update) about 1-2 s. Memory: one 512-sample chunk needs ~1-2 GB with attention scores (4 heads x 194 x 194 x 4 B
x 512 per layer), the supervisor leaves the learner half of the 8 GB.

Owner, once, in PowerShell started as Administrator: `wsl.exe --install -d Ubuntu-22.04`, reboot, finish the Ubuntu first-run user
setup; then on the VPS `scripts/train/pc.sh gpu-setup` and check that the learner log's `devices` row says `cuda`. Then run
`scripts/train/profile_learner.py` inside WSL (same file, same command) to replace the prediction above by a number.

The better use of the PC after that is to run the simulator shards in the same WSL2 (the Linux binary runs unchanged, the file API
stays on one ext4 disk, 16 threads for ~30 shards) and the learner next to them, instead of mirroring files between machines.
Written down, not built: it cannot be tested before WSL2 exists.

## 5. Files

DPOD `scripts/botsystem_goal_ppo.py`, `scripts/botsystem_goal_wm.py`, `integrations/botsystem/protocol.py`,
`tests/test_botsystem_unroll.py`, `tests/test_botsystem_interface.py`; here `scripts/train/profile_learner.py`,
`scripts/train/profile_server.sh`, `scripts/train/pc/supervisor.js`, `scripts/train/sim.sh` (`--learner-args`).
