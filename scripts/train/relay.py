#!/usr/bin/env python3
"""Training relay between the VPS and the owner's PC (owner 2026-11-02: bots from 11 on and the training itself on the PC). Both
machines keep an exchange/ directory with the DPOD file API; this mirrors between them what the other side reads. The learner
runs on the PC: groups 0..shard0-1 run on the VPS, shard0.. on the PC. Each file has exactly one writer side:

  <base>.s<i>.current, <base>.s<i>.live.json, <run>/env_to_policy.jsonl, <run>/events.jsonl   the side of shard i
  sites/<side>-s<i>.json                                                                         that side
  <run>/policy_to_env.jsonl, <base>/train/{train_log,episodes}.jsonl, <base>/train/goals.json    pc (the learner)

A side sends what it writes and the other side lacks (env files of its own groups; the PC also the learner's answers to the VPS
groups and its logs for the VPS's page); it accepts only files the other side writes, by the patterns above (nothing else is
ever written). JSON lines: {"have": {path: bytes}} first from each side (resume points: a reconnect resends nothing), then
{"f": path, "a": text} (append, complete lines only) or {"f": path, "w": text} (replace). Same file on both machines:

  VPS:  relay.py <exchange> <base> <shard0> vps --ssh <user@host> --key <file> --remote '<python> <relay.py> <exchange> <base> <shard0> pc'
  PC:   relay.py <exchange> <base> <shard0> pc          (started by the VPS side over SSH; stdin/stdout are the link)

The VPS side exits when the link drops (systemd starts it again: forgeaip-train-pc-relay).
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path


def rules(base: str, shard0: int):
    b = re.escape(base)
    run = rf"{b}-s(\d{{1,2}})-\d{{8}}T\d{{6}}"
    pats = [(re.compile(rf"^{b}\.s(\d{{1,2}})\.(current|live\.json)$"), "w", "shard"),
            (re.compile(rf"^{run}/(env_to_policy|events)\.jsonl$"), "a", "shard"),
            (re.compile(r"^sites/(vps|pc)-s\d{1,2}\.json$"), "w", "name"),
            (re.compile(rf"^{run}/policy_to_env\.jsonl$"), "a", "pc"),
            (re.compile(rf"^{b}/train/(train_log|episodes)\.jsonl$"), "a", "pc"),
            (re.compile(rf"^{b}/train/goals\.json$"), "w", "pc")]

    def writer(rel: str):
        """(side that writes rel, 'a' | 'w') or None for anything else."""
        for p, mode, who in pats:
            m = p.match(rel)
            if m:
                if who == "shard":
                    return ("vps" if int(m.group(1)) < shard0 else "pc"), mode
                if who == "name":
                    return m.group(1), mode
                return who, mode
        return None
    return writer, run


class Relay:
    def __init__(self, root: Path, base: str, shard0: int, side: str, out, inp):
        self.root, self.base, self.shard0, self.side = root, base, shard0, side
        self.writer, self.run = rules(base, shard0)
        self.out, self.inp, self.lock = out, inp, threading.Lock()
        self.off: dict[str, int] = {}
        self.seen: dict[str, tuple] = {}
        self.peer: dict | None = None
        self.other = "pc" if side == "vps" else "vps"

    def send(self, m: dict):
        with self.lock:
            self.out.write((json.dumps(m, separators=(",", ":")) + "\n").encode())
            self.out.flush()

    def mine(self, rel: str) -> bool:
        w = self.writer(rel)
        return w is not None and w[0] == self.side

    # -- what this side holds of the other side's files (resume points for the other side) --
    def have(self) -> dict:
        out = {}
        for p in self.root.rglob("*"):
            rel = p.relative_to(self.root).as_posix()
            w = self.writer(rel)
            if w and w[0] == self.other and w[1] == "a" and p.is_file():
                out[rel] = p.stat().st_size
        return out

    # -- incoming --
    def apply(self, m: dict):
        f = m.get("f")
        w = self.writer(f) if isinstance(f, str) else None
        if not w or w[0] != self.other:
            return
        dst = self.root / f
        dst.parent.mkdir(parents=True, exist_ok=True)
        if w[1] == "a" and isinstance(m.get("a"), str):
            with open(dst, "ab") as fh:
                fh.write(m["a"].encode())
        elif w[1] == "w" and isinstance(m.get("w"), str):
            tmp = dst.with_name(dst.name + ".relay-tmp")
            tmp.write_text(m["w"], encoding="utf-8")
            for i in range(50):           # Windows: a reader holding the file blocks the replace for a moment
                try:
                    os.replace(tmp, dst)
                    break
                except PermissionError:
                    time.sleep(0.02)

    def reader(self):
        for raw in self.inp:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if isinstance(m.get("have"), dict):
                self.peer = m["have"]
            else:
                self.apply(m)
        os._exit(3)

    # -- outgoing --
    def tail(self, rel: str):
        p = self.root / rel
        try:
            n = p.stat().st_size
        except OSError:
            return
        o = self.off.get(rel)
        if o is None:
            o = max(0, int(self.peer.get(rel, 0)))
        while o < n:
            with open(p, "rb") as fh:
                fh.seek(o)
                buf = fh.read(min(n - o, 1 << 20))
            end = buf.rfind(b"\n")
            if end < 0:
                break
            self.send({"f": rel, "a": buf[:end + 1].decode("utf-8", "replace")})
            o += end + 1
        self.off[rel] = o

    def mirror(self, rel: str, every: float):
        p = self.root / rel
        try:
            st = p.stat()
        except OSError:
            return
        s = self.seen.get(rel)
        if s and (s[0] == st.st_mtime_ns or time.time() - s[1] < every):
            return
        try:
            text = p.read_text(encoding="utf-8")
        except OSError:
            return
        self.seen[rel] = (st.st_mtime_ns, time.time())
        self.send({"f": rel, "w": text})

    def runs(self, sides: tuple) -> list[str]:
        """Live run ids of the groups on the given sides (from the .current files present here)."""
        out = []
        for c in self.root.glob(f"{self.base}.s*.current"):
            w = self.writer(c.name)
            if w and w[0] in sides:
                try:
                    rid = c.read_text().strip()
                except OSError:
                    continue
                if re.fullmatch(self.run, rid):
                    out.append(rid)
        return out

    def loop(self):
        self.send({"have": self.have()})
        threading.Thread(target=self.reader, daemon=True).start()
        t0 = time.time()
        while self.peer is None:
            if time.time() - t0 > 60:
                sys.exit("no answer from the other side")
            time.sleep(0.02)
        for i in range(10 ** 12):
            page = self.side == "pc"                   # the page and its logs live on the VPS: only the PC sends them
            for c in self.root.glob(f"{self.base}.s*.current"):
                if self.mine(c.name):
                    self.mirror(c.name, 0)
                    if page:
                        self.mirror(c.name[:-len("current")] + "live.json", 1.0)
            for rid in self.runs((self.side,)):
                self.tail(f"{rid}/env_to_policy.jsonl")
                if page and i % 25 == 0:
                    self.tail(f"{rid}/events.jsonl")
            if self.side == "pc":                      # the learner's side: answers to the VPS groups, logs for the page
                for rid in self.runs(("vps",)):
                    self.tail(f"{rid}/policy_to_env.jsonl")
                if i % 50 == 0:
                    for f in ("train_log.jsonl", "episodes.jsonl"):
                        self.tail(f"{self.base}/train/{f}")
                    self.mirror(f"{self.base}/train/goals.json", 1.0)
            if i % 500 == 0 and (self.root / "sites").is_dir():
                for p in (self.root / "sites").glob(f"{self.side}-s*.json"):
                    self.mirror(f"sites/{p.name}", 10.0)
            time.sleep(0.01)


def main():
    a = sys.argv[1:]
    if len(a) < 4 or a[3] not in ("vps", "pc") or not re.fullmatch(r"[a-z0-9_-]{1,40}", a[1]) or not a[2].isdigit():
        sys.exit(__doc__)
    root, base, shard0, side = Path(a[0]).resolve(), a[1], int(a[2]), a[3]
    opt = dict(zip(a[4::2], a[5::2]))
    if side == "vps":
        # --ssh local: the other side on this machine (tests)
        cmd = ["sh", "-c", opt["--remote"]] if opt.get("--ssh") == "local" else ["ssh", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
               "-i", opt.get("--key", ""), opt["--ssh"], opt["--remote"]]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
        r = Relay(root, base, shard0, side, p.stdin, p.stdout)
        threading.Thread(target=lambda: (p.wait(), os._exit(4)), daemon=True).start()
    else:
        r = Relay(root, base, shard0, side, sys.stdout.buffer, sys.stdin.buffer)
    r.loop()


if __name__ == "__main__":
    main()
