#!/usr/bin/env python3
"""Game-side verification of the RL environment against the live Forge server (test code, not part of the runtime).

Starts the environment (docker compose, profile `env`) and serves it as a DPOD policy (integrations.botsystem
PolicyServer). Three episodes with scripted policies feed goals directly (no LLM):
  0 motion   every control of the action space, each judged against the SERVER's own state (RCON `data get entity`)
  1 collect  find an oak log with the crosshair, break it, pick it up (goal: collect oak_log x1)
  2 reach    walk to a point (goal: reach offset [6,-4]); also checks the potential-based shaping term
The scripts read only the declared observation fields; the server is consulted only to grade, never to act.

    python3 scripts/rl/verify_game_side.py            # needs scripts/rl/up.sh first; DPOD_DIR overrides the DPOD checkout
Exit code 0 only if every check passes.
"""
from __future__ import annotations

import json
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DPOD = Path(os.environ.get("DPOD_DIR", REPO.parent / "Decision-Process-order-driven"))
sys.path.insert(0, str(DPOD))
from integrations.botsystem.action_spec import proposal_full  # noqa: E402
from integrations.botsystem.serve import PolicyServer  # noqa: E402

BOT = "RLBot0"
ITEM = {"oak_log": 0, "cobblestone": 3, "dirt": 4}      # indices into the `inventory` observation (goal.js ITEMS)
CAT_LOG, CAT_SOIL, CAT_STONE = 3, 1, 2
CHECKS: list[dict] = []


def rcon(cmd: str) -> str:
    r = subprocess.run(["docker", "exec", "forgeaip-rl-mc", "rcon-cli", cmd], capture_output=True, text=True, timeout=30)
    return re.sub(r"\x1b\[[0-9;]*m", "", r.stdout + r.stderr).strip()    # rcon-cli appends an ANSI reset


def nums(s: str, suffix: str) -> list[float]:
    return [float(x) for x in re.findall(rf"(-?\d+\.?\d*(?:E-?\d+)?){suffix}", s)]


def srv_pos() -> list[float]: return nums(rcon(f"data get entity {BOT} Pos"), "d")
def srv_rot() -> list[float]: return nums(rcon(f"data get entity {BOT} Rotation"), "f")
def srv_slot() -> int: return int(re.findall(r"(-?\d+)\s*$", rcon(f"data get entity {BOT} SelectedItemSlot"))[0])


def srv_count(item: str) -> int:
    m = re.search(r"Found (\d+) matching", rcon(f"clear {BOT} minecraft:{item} 0"))
    return int(m.group(1)) if m else 0


def check(name: str, expected: str, measured: str, ok: bool) -> None:
    CHECKS.append({"name": name, "expected": expected, "measured": measured, "ok": bool(ok)})
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {measured}   (expected {expected})", flush=True)


def wrap(a: float) -> float: return (a + 180) % 360 - 180
def pos(m): return m["obs"]["pos"]
def d2(a, b): return math.hypot(a[0] - b[0], a[2] - b[2])
def yaw_mf(m): return math.atan2(m["obs"]["look"][0], m["obs"]["look"][1])           # Mineflayer yaw (rad, counter-clockwise)
def pitch_mf(m): return math.atan2(m["obs"]["look"][2], m["obs"]["look"][3])


def heading_deg(a, b):                                                               # Mineflayer yaw that faces from a to b
    return math.degrees(math.atan2(-(b[0] - a[0]), -(b[2] - a[2])))


class State:
    def __init__(self, m): self.m = m


def nearest(options, want):
    return min(options, key=lambda v: abs(v - want))


class Scripted:
    """DPOD Policy: one generator per episode; `yield action` returns the next observation message."""

    def __init__(self) -> None:
        self.gens: dict[int, object] = {}
        self.st: State | None = None
        self.shaping: dict[int, float] = {}
        self.ends: dict[int, dict] = {}
        self.truth: dict[int, dict] = {}
        self.scripts = {0: self.motion, 1: self.collect, 2: self.reach}

    def bind(self, spec) -> None: self.spec = spec

    def A(self, **kw):
        a = self.spec.noop(); a.update(kw); return a

    def move(self, n, **kw):
        for _ in range(n):
            self.st.m = yield self.A(**kw)

    def act(self, msg):
        ep = msg["episode"]
        self.shaping[ep] = self.shaping.get(ep, 0.0) + msg["reward_terms"].get("shaping", 0.0)
        if ep not in self.gens:
            self.st = State(msg)
            self.gens[ep] = self.scripts[ep]()
            try: return next(self.gens[ep])
            except StopIteration: return self.spec.noop()
        self.st.m = msg
        try: return self.gens[ep].send(msg)
        except StopIteration: return self.spec.noop()

    def end_episode(self, msg) -> None:
        ep = msg["episode"]
        self.shaping[ep] = self.shaping.get(ep, 0.0) + msg["reward_terms"].get("shaping", 0.0)
        self.ends[ep] = msg
        # Server truth at the moment the episode ended (the env waits --gap-ms before resetting; the bot is still online).
        if ep == 1: self.truth[ep] = {"logs": srv_count("oak_log")}
        if ep == 2: self.truth[ep] = {"pos": srv_pos()}

    # ---- episode 0: controls ------------------------------------------------------------------------------------------------
    def motion(self):
        st = self.st
        p0 = pos(st.m); yield from self.move(10)
        check("noop keeps the bot still", "moved < 0.02 m, on ground", f"{d2(p0, pos(st.m)):.4f} m", d2(p0, pos(st.m)) < 0.02 and st.m["obs"]["on_ground"])

        p0, yw = pos(st.m), yaw_mf(st.m); yield from self.move(10, forward="hold"); p1 = pos(st.m)
        walk = d2(p0, p1); err = wrap(heading_deg(p0, p1) - math.degrees(yw)); gap = math.dist(srv_pos(), p1)
        check("forward x10 steps (40 ticks) walks ~4.3 m/s", "7.0..9.0 m", f"{walk:.2f} m", 7.0 <= walk <= 9.0)
        check("forward moves along the facing direction", "|error| < 5 deg", f"{err:.2f} deg", abs(err) < 5)
        check("server position equals client position", "< 0.15 m", f"{gap:.3f} m", gap < 0.15)

        p0 = pos(st.m); yield from self.move(10, back="hold"); p1 = pos(st.m)
        err = wrap(heading_deg(p0, p1) - math.degrees(yw) - 180)
        check("back moves opposite to facing", "|error| < 5 deg, 7..9 m", f"{err:.2f} deg, {d2(p0, p1):.2f} m", abs(err) < 5 and 7 <= d2(p0, p1) <= 9)

        p0 = pos(st.m); yield from self.move(10, forward="hold", sprint="hold"); p1 = pos(st.m)
        check("sprint is faster than walking", "ratio >= 1.2", f"{d2(p0, p1) / walk:.2f}", d2(p0, p1) / walk >= 1.2)
        yield from self.move(14, back="hold")

        left = (-math.cos(yw), math.sin(yw))
        p0 = pos(st.m); yield from self.move(6, left="hold"); pl = pos(st.m)
        p0b = pos(st.m); yield from self.move(6, right="hold"); pr = pos(st.m)
        dl = ((pl[0] - p0[0]), (pl[2] - p0[2])); dr = ((pr[0] - p0b[0]), (pr[2] - p0b[2]))
        cl = (dl[0] * left[0] + dl[1] * left[1]) / math.hypot(*dl); cr = (dr[0] * left[0] + dr[1] * left[1]) / math.hypot(*dr)
        check("left strafes to the player's left, right to the right", "cos > 0.95 / < -0.95", f"{cl:.3f} / {cr:.3f}", cl > 0.95 and cr < -0.95)

        r0 = srv_rot(); yield from self.move(2, yaw_delta_deg=45.0); r1 = srv_rot()
        check("yaw_delta_deg +45 x2 turns right by 90 deg (server yaw, F3 convention)", "+90 +- 1.5", f"{wrap(r1[0] - r0[0]):+.2f}", abs(wrap(r1[0] - r0[0]) - 90) < 1.5)
        yield from self.move(2, yaw_delta_deg=-45.0)
        yield from self.move(2, pitch_delta_deg=15.0); r2 = srv_rot()
        check("pitch_delta_deg +15 x2 looks down 30 deg (server pitch)", "30 +- 1", f"{r2[1]:.2f}", abs(r2[1] - 30) < 1)
        yield from self.move(7, pitch_delta_deg=15.0); r3 = srv_rot()
        check("pitch clamps at straight down", "90.0", f"{r3[1]:.2f}", abs(r3[1] - 90) < 0.5)
        yield from self.move(6, pitch_delta_deg=-15.0); r4 = srv_rot()
        check("pitch returns to level", "0 +- 1", f"{r4[1]:.2f}", abs(r4[1]) < 1)

        y0 = pos(st.m)[1]; ys = []
        yield from self.move(1, jump="tap"); ys.append(pos(st.m)[1])
        for _ in range(6):
            yield from self.move(1); ys.append(pos(st.m)[1])
        check("jump tap rises ~1.25 m and lands", "apex 1.0..1.35 m, back on ground", f"apex {max(ys) - y0:.2f} m, end {ys[-1] - y0:+.3f}", 1.0 <= max(ys) - y0 <= 1.35 and abs(ys[-1] - y0) < 0.01 and st.m["obs"]["on_ground"])

        gave = rcon(f"give {BOT} minecraft:cobblestone 5") + " | " + rcon(f"give {BOT} minecraft:dirt 3")
        yield from self.move(2)
        inv = st.m["obs"]["inventory"]
        check("server-side give shows in the inventory observation", "cobblestone 5, dirt 3", f"{inv[ITEM['cobblestone']]}, {inv[ITEM['dirt']]} (server {srv_count('cobblestone')}, {srv_count('dirt')}; {gave})", inv[ITEM["cobblestone"]] == 5 and inv[ITEM["dirt"]] == 3)
        yield from self.move(1, hotbar=2)
        check("hotbar=2 selects slot index 1 (client and server)", "held_slot 1, server 1", f"{st.m['obs']['held_slot']}, {srv_slot()}", st.m["obs"]["held_slot"] == 1 and srv_slot() == 1)
        yield from self.move(1, hotbar=1)
        yield from self.move(3, pitch_delta_deg=15.0)
        before = st.m["obs"]["cursor_block"]
        yield from self.move(1, use="tap"); yield from self.move(2)
        check("use places the held block on the block under the crosshair", "cobblestone 4 on client and server, cursor now stone", f"client {st.m['obs']['inventory'][ITEM['cobblestone']]}, server {srv_count('cobblestone')}, cursor {before}->{st.m['obs']['cursor_block']}",
              st.m["obs"]["inventory"][ITEM["cobblestone"]] == 4 and srv_count("cobblestone") == 4 and before == CAT_SOIL and st.m["obs"]["cursor_block"] == CAT_STONE)
        while True:
            yield from self.move(1)

    # ---- aiming helpers for episodes 1 and 2 -------------------------------------------------------------------------------------
    def aim(self, m, target, pitch=True):
        """Return (yaw_delta, pitch_delta, yaw_err_deg, pitch_err_deg) toward a point; deltas use the F3 sign convention."""
        o = m["obs"]; p = o["pos"]
        yerr = wrap(heading_deg(p, target) - math.degrees(yaw_mf(m)))
        h = max(math.hypot(target[0] - p[0], target[2] - p[2]), 0.3)
        perr = math.degrees(math.atan2(target[1] - (p[1] + 1.62), h)) - math.degrees(pitch_mf(m)) if pitch else 0.0
        ya = self.spec.components[[c.name for c in self.spec.components].index("yaw_delta_deg")].values
        pa = self.spec.components[[c.name for c in self.spec.components].index("pitch_delta_deg")].values
        return (nearest(ya, -yerr) if abs(yerr) > 6 else 0.0), (nearest(pa, -perr) if abs(perr) > 8 else 0.0), yerr, perr

    @staticmethod
    def cells(m, cat):
        o = m["obs"]; p = o["pos"]; fx, fy, fz = math.floor(p[0]), math.floor(p[1]), math.floor(p[2]); out = []; i = 0
        for dy in range(-1, 3):
            for dz in range(-4, 5):
                for dx in range(-4, 5):
                    if o["grid"][i] == cat: out.append([fx + dx + 0.5, fy + dy + 0.5, fz + dz + 0.5])
                    i += 1
        return sorted(out, key=lambda c: math.dist(c, p))

    # ---- episode 1: collect ----------------------------------------------------------------------------------------------------------
    def collect(self):
        st = self.st
        for _ in range(140):
            o = st.m["obs"]
            if o["inventory"][ITEM["oak_log"]] >= 1: break
            logs = self.cells(st.m, CAT_LOG)
            items = [[o["pos"][0] + o["entities"][4 * i + 1], o["pos"][1] + o["entities"][4 * i + 2], o["pos"][2] + o["entities"][4 * i + 3]]
                     for i in range(4) if o["entities"][4 * i] == 1]
            tgt = logs[0] if logs else (items[0] if items else None)
            if tgt is None:
                st.m = yield self.A(forward="hold"); continue
            yaw_d, pitch_d, yerr, _ = self.aim(st.m, tgt, pitch=bool(logs))
            if yaw_d or pitch_d: st.m = yield self.A(yaw_delta_deg=yaw_d, pitch_delta_deg=pitch_d)
            elif logs and o["cursor_block"] == CAT_LOG and 0 <= o["cursor_dist"] <= 4.4: st.m = yield self.A(attack="hold")
            else: st.m = yield self.A(forward="hold")
        while True:
            st.m = yield self.A()

    # ---- episode 2: reach -------------------------------------------------------------------------------------------------------------
    def reach(self):
        st = self.st
        while True:
            g = st.m["obs"]["goal"]; p = st.m["obs"]["pos"]
            tgt = [p[0] + g[2] * 16, p[1], p[2] + g[4] * 16]
            yaw_d, _, yerr, _ = self.aim(st.m, tgt, pitch=False)
            dist = math.hypot(g[2], g[4]) * 16
            if yaw_d: st.m = yield self.A(yaw_delta_deg=yaw_d)
            else: st.m = yield self.A(forward="hold", **({"sprint": "hold"} if dist > 4 else {}))


def main() -> int:
    run = f"verify-{int(time.time())}"
    root = REPO / "exchange"
    goals = [{"v": 1, "type": "reach", "offset": [60, 0], "max_steps": 150}, {"v": 1, "type": "collect", "item": "oak_log", "count": 1, "max_steps": 150},
             {"v": 1, "type": "reach", "offset": [6, -4], "max_steps": 100}]
    env = subprocess.Popen(["docker", "compose", "--profile", "env", "run", "--rm", "-T", "rl-env", "--run-id", run, "--spec", "full", "--ticks", "4",
                            "--episodes", "3", "--seed", "7", "--gap-ms", "1500", "--goal", json.dumps(goals)], cwd=REPO / "docker/rl-server", stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    policy = Scripted()
    server = PolicyServer(root, run, policy, expected_spec=proposal_full(4))
    print(f"run {run}", flush=True)
    try:
        server.run(idle_timeout_s=120)
    finally:
        server.close()
    try: env_out = env.communicate(timeout=30)[0]
    except subprocess.TimeoutExpired: env.kill(); env_out = env.communicate()[0]

    print("episode 1 (collect oak_log x1):")
    e1, e2 = policy.ends.get(1), policy.ends.get(2)
    steps1 = e1["step"] if e1 else -1
    check("collect: episode terminated by the goal's success predicate", "terminated, task reward 1", f"terminated={e1 and e1['terminated']}, task={e1 and e1['reward_terms']['task']}, steps={steps1}", bool(e1 and e1["terminated"] and e1["reward_terms"]["task"] == 1))
    check("collect: server inventory holds the log", ">= 1 oak_log", str(policy.truth.get(1, {}).get("logs")), policy.truth.get(1, {}).get("logs", 0) >= 1)
    print("episode 2 (reach [6,-4]):")
    check("reach: episode terminated by the goal's success predicate", "terminated, task reward 1", f"terminated={e2 and e2['terminated']}, task={e2 and e2['reward_terms']['task']}, steps={e2 and e2['step']}", bool(e2 and e2["terminated"] and e2["reward_terms"]["task"] == 1))
    if e2:
        d0 = math.hypot(6, 4); g = e2["obs"]["goal"]; dn = math.hypot(g[2], g[4]) * 16
        check("reach: shaping sums to the potential difference (d0 - dN)/10", "equal within 0.01", f"{policy.shaping[2]:.4f} vs {(d0 - dn) / 10:.4f}", abs(policy.shaping[2] - (d0 - dn) / 10) < 0.01)
        sp = policy.truth[2]["pos"]; check("reach: server position is at the target", "within 1.0 m horizontally of (6.5,-3.5)", f"{math.hypot(sp[0] - 6.5, sp[2] + 3.5):.2f} m", math.hypot(sp[0] - 6.5, sp[2] + 3.5) <= 1.0)

    ok = all(c["ok"] for c in CHECKS) and env.returncode == 0
    (root / run / "verification.json").write_text(json.dumps({"run_id": run, "ok": ok, "env_exit": env.returncode, "checks": CHECKS}, indent=1))
    print(f"\n{sum(c['ok'] for c in CHECKS)}/{len(CHECKS)} checks passed; env exit {env.returncode}; report exchange/{run}/verification.json")
    if not ok: print(env_out[-1500:])
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
