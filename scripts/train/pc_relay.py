#!/usr/bin/env python3
"""VPS end of the training relay to the owner's PC (scripts/train/pc/relay.js is the PC end; protocol there). Mirrors the PC's
environment files into exchange/ for the learner and the page, and the learner's answers back. Runs as the systemd user unit
forgeaip-train-pc-relay (scripts/train/pc.sh); exits when the link drops, and systemd starts it again.

  scripts/train/pc_relay.py <exchange> <base> <shard0>
"""
import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HOST = os.environ.get("FORGEAIP_PC", "sigure@100.113.219.35")
KEY = os.path.expanduser(os.environ.get("FORGEAIP_PC_KEY", "~/.ssh/id_ed25519_pc"))
PC_HOME = os.environ.get("FORGEAIP_PC_HOME", r"C:\forgeaip")


def main():
    root, base, shard0 = Path(sys.argv[1]).resolve(), sys.argv[2], int(sys.argv[3])
    if not re.fullmatch(r"[a-z0-9_-]{1,40}", base):
        sys.exit("bad base")
    run = rf"{re.escape(base)}-s(\d{{1,2}})-\d{{8}}T\d{{6}}"
    ok_append = re.compile(rf"^{run}/(env_to_policy|events)\.jsonl$")
    ok_write = re.compile(rf"^({re.escape(base)}\.s(\d{{1,2}})\.(current|live\.json)|sites/pc-s(\d{{1,2}})\.json)$")
    pc_shard = lambda m: m is not None and int(next(g for g in m.groups() if g and g.isdigit())) >= shard0

    def ours(rel: str) -> bool:
        m = ok_append.match(rel) or ok_write.match(rel)
        return pc_shard(m)

    # What the mirror already holds of the PC's runs (their env files), so the PC resends nothing after a reconnect.
    have = {}
    for c in root.glob(f"{base}.s*.current"):
        m = re.fullmatch(rf"{re.escape(base)}\.s(\d{{1,2}})\.current", c.name)
        if m and int(m.group(1)) >= shard0:
            rid = c.read_text().strip()
            for f in ("env_to_policy.jsonl", "events.jsonl"):
                p = root / rid / f
                if re.fullmatch(run, rid) and p.exists():
                    have[f"{rid}/{f}"] = p.stat().st_size
    cmd = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
           "-i", KEY, HOST, rf"{PC_HOME}\node\node.exe {PC_HOME}\app\scripts\train\pc\relay.js {PC_HOME}\exchange {base}"]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
    out_lock = threading.Lock()

    def send(m):
        with out_lock:
            p.stdin.write((json.dumps(m, separators=(",", ":")) + "\n").encode())
            p.stdin.flush()

    send({"have": have})
    peer: dict = {}
    runs: dict[str, int] = {}          # PC run id -> bytes of its policy_to_env.jsonl already sent
    got_have = threading.Event()

    def reader():
        for raw in p.stdout:
            try:
                m = json.loads(raw)
            except ValueError:
                continue
            if isinstance(m.get("have"), dict):
                peer.update(m["have"])
                got_have.set()
                continue
            f = m.get("f")
            if not isinstance(f, str) or not ours(f):
                continue
            dst = root / f
            dst.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(m.get("a"), str) and ok_append.match(f):
                with open(dst, "ab") as fh:
                    fh.write(m["a"].encode())
            elif isinstance(m.get("w"), str) and ok_write.match(f):
                tmp = dst.with_name(dst.name + ".relay-tmp")
                tmp.write_text(m["w"])
                os.replace(tmp, dst)
                if f.endswith(".current") and re.fullmatch(run, m["w"].strip()):
                    rid = m["w"].strip()
                    runs.setdefault(rid, int(peer.get(f"{rid}/policy_to_env.jsonl", 0)))
        os._exit(3)

    threading.Thread(target=reader, daemon=True).start()
    got_have.wait(60) or sys.exit("no answer from the PC")
    while p.poll() is None:
        for rid, o in list(runs.items()):
            src = root / rid / "policy_to_env.jsonl"
            try:
                n = src.stat().st_size
            except FileNotFoundError:
                continue
            if n <= o:
                continue
            with open(src, "rb") as fh:
                fh.seek(o)
                buf = fh.read(min(n - o, 1 << 20))
            end = buf.rfind(b"\n")
            if end >= 0:
                send({"f": f"{rid}/policy_to_env.jsonl", "a": buf[:end + 1].decode()})
                runs[rid] = o + end + 1
        time.sleep(0.01)
    sys.exit(p.returncode or 4)


if __name__ == "__main__":
    main()
