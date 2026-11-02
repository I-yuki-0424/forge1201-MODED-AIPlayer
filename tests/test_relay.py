"""Relay between VPS and PC (scripts/train/relay.py), both ends on this machine: each side's files reach the other, the learner's
answers reach the VPS groups, a reconnect resumes without duplicates, and nothing outside the patterns is ever written."""
import json, subprocess, sys, tempfile, time, unittest
from pathlib import Path

RELAY = Path(__file__).resolve().parents[1] / "scripts" / "train" / "relay.py"


def until(pred, t=10):
    t0 = time.time()
    while time.time() - t0 < t:
        if pred():
            return True
        time.sleep(0.05)
    return False


class TestRelay(unittest.TestCase):
    def start(self, vps, pc):
        remote = f"{sys.executable} {RELAY} {pc} b 5 pc"
        return subprocess.Popen([sys.executable, str(RELAY), str(vps), "b", "5", "vps", "--ssh", "local", "--remote", remote])

    def test_mirror_both_ways_resume_and_refuse(self):
        with tempfile.TemporaryDirectory() as t:
            vps, pc = Path(t, "vps"), Path(t, "pc")
            vps.mkdir(), pc.mkdir()
            rv, rp = "b-s0-20261102T000000", "b-s5-20261102T000000"
            (vps / "b.s0.current").write_text(rv + "\n"); (vps / rv).mkdir(); (vps / rv / "env_to_policy.jsonl").write_text('{"x":1}\n{"x":2')
            (pc / "b.s5.current").write_text(rp + "\n"); (pc / rp).mkdir(); (pc / rp / "env_to_policy.jsonl").write_text('{"y":1}\n')
            (pc / "b.s5.live.json").write_text('{"live":1}')
            (pc / "b" / "train").mkdir(parents=True); (pc / "b" / "train" / "goals.json").write_text('{"g":1}')
            p = self.start(vps, pc)
            try:
                self.assertTrue(until(lambda: (pc / rv / "env_to_policy.jsonl").exists() and (pc / "b.s0.current").exists()))
                self.assertEqual((pc / rv / "env_to_policy.jsonl").read_text(), '{"x":1}\n')        # complete lines only
                self.assertTrue(until(lambda: (vps / rp / "env_to_policy.jsonl").exists() and (vps / "b.s5.live.json").exists()))
                self.assertTrue(until(lambda: (vps / "b" / "train" / "goals.json").exists()))
                (pc / rv / "policy_to_env.jsonl").write_text('{"act":1}\n')                           # the learner answers a VPS bot
                self.assertTrue(until(lambda: (vps / rv / "policy_to_env.jsonl").exists()))
                self.assertEqual((vps / rv / "policy_to_env.jsonl").read_text(), '{"act":1}\n')
                with open(vps / rv / "env_to_policy.jsonl", "a") as f:
                    f.write('}\n')
                self.assertTrue(until(lambda: (pc / rv / "env_to_policy.jsonl").read_text().count("\n") == 2))
            finally:
                p.kill(); p.wait()
            # reconnect: nothing is sent twice
            with open(pc / rv / "policy_to_env.jsonl", "a") as f:
                f.write('{"act":2}\n')
            p = self.start(vps, pc)
            try:
                self.assertTrue(until(lambda: (vps / rv / "policy_to_env.jsonl").read_text().count("\n") == 2))
                time.sleep(1)
                self.assertEqual((vps / rv / "policy_to_env.jsonl").read_text(), '{"act":1}\n{"act":2}\n')
                self.assertEqual((pc / rv / "env_to_policy.jsonl").read_text(), '{"x":1}\n{"x":2}\n')
            finally:
                p.kill(); p.wait()
        # refusal: a side never writes a path outside the patterns, nor a file the other side does not write
        sys.path.insert(0, str(RELAY.parent))
        import relay
        with tempfile.TemporaryDirectory() as t:
            r = relay.Relay(Path(t), "b", 5, "vps", None, None)
            for f in ("../evil", "b.s5.current/../../x", "b/train/checkpoint.pkl", "b.s0.current", "sites/vps-s0.json", "b-s0-20261102T000000/policy_to_env.jsonl/x"):
                r.apply({"f": f, "w": "x", "a": "x\n"})
            r.apply({"f": "b.s5.current", "w": "b-s5-20261102T000000\n"})
            self.assertEqual(sorted(p.relative_to(t).as_posix() for p in Path(t).rglob("*")), ["b.s5.current"])


if __name__ == "__main__":
    unittest.main()
