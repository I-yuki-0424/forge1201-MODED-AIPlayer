"""The policy side of the simulator's file API (tools/sim, integrations/botsystem/PROTOCOL.md): one `Shard` per `forgeaip-sim run` process.

The simulator appends `hello` and `obs` lines to <root>/<run>/env_to_policy.jsonl and reads `hello_ack` and `act` lines from policy_to_env.jsonl; the
current run id of a shard is in <root>/<base>.s<shard>.current (a restart of the shard starts a new run). Nothing here decides anything.
"""
import json
import os
import time


class Shard:
    def __init__(self, root, base, shard):
        self.root, self.base, self.shard = root, base, shard
        self.cur = f"{root}/{base}.s{shard}.current"
        self.run = None
        self._in = None
        self._buf = b""
        self._out = None
        self.seq = 0
        self.hello = {}          # env_id -> hello message
        self._checked = 0.0

    def _follow(self):
        """Attach to the run named in the .current file (or the new one after a restart of the shard)."""
        try:
            run = open(self.cur).read().strip()
        except FileNotFoundError:
            return False
        if not run:
            return False
        if run != self.run:
            rin, rout = f"{self.root}/{run}/env_to_policy.jsonl", f"{self.root}/{run}/policy_to_env.jsonl"
            if not os.path.exists(rin):
                return False
            self.run, self._buf, self.seq, self.hello = run, b"", 0, {}
            if self._in:
                self._in.close()
            if self._out:
                self._out.close()
            self._in = open(rin, "rb")
            self._out = open(rout, "ab", buffering=0)
        return True

    def poll(self):
        """New complete messages since the last call (hello messages are answered here with hello_ack)."""
        now = time.time()
        if self._in is None or now - self._checked > 1.0:
            self._checked = now
            if not self._follow():
                return []
        data = self._in.read()
        if not data:
            return []
        self._buf += data
        if b"\n" not in self._buf:
            return []
        head, self._buf = self._buf.rsplit(b"\n", 1)
        out = []
        for ln in head.split(b"\n"):
            try:
                m = json.loads(ln)
            except ValueError:
                continue
            if m.get("type") == "hello":
                self.hello[m["env_id"]] = m
                self.send({"type": "hello_ack", "env_id": m["env_id"], "accepted": True})
            out.append(m)
        return out

    def send(self, msg):
        msg.update({"v": 1, "run_id": self.run, "seq": self.seq, "t": time.time()})
        self.seq += 1
        self._out.write((json.dumps(msg, separators=(",", ":")) + "\n").encode())

    def act(self, env_id, episode, step, candidate):
        self.send({"type": "act", "env_id": env_id, "episode": episode, "step": step, "action": {"candidate": int(candidate)}})

    def close(self):
        for f in (self._in, self._out):
            if f:
                f.close()
