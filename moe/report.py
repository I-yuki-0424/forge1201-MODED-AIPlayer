"""Markdown tables from a runs directory: python -m moe.report /mnt/data/forgeaip/moe/runs  (experts, router, chain)."""
import json
import pathlib
import sys

from . import catalog


def _last(path):
    p = pathlib.Path(path)
    if not p.exists():
        return None
    rows = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    return rows[-1] if rows else None


def _rows(path, key):
    p = pathlib.Path(path)
    out = {}
    if p.exists():
        for l in p.read_text().splitlines():
            if l.strip():
                r = json.loads(l)
                out[r[key]] = r
    return out


def fmt(s):
    if not s:
        return "-"
    lo, hi = s["wilson95"]
    return f"{s['rate']:.2f} [{lo:.2f}, {hi:.2f}]"


def experts_table(runs):
    cat = catalog.load()
    lines = ["| Expert | Parameters | Steps to criterion | Train time | Held-out: learned | scripted solver | uniform random | Commands (learned / solver) |",
             "| :-- | --: | --: | --: | :-- | :-- | :-- | :-- |"]
    for e in cat["experts"]:
        d = pathlib.Path(runs) / e["id"]
        fin = _last(d / "train_result.json") or {}
        ctl = _rows(d / "controls.jsonl", "policy")
        ev = _last(d / "eval.jsonl")
        meta = {}
        try:
            import numpy as np
            z = np.load(d / "final.npz", allow_pickle=False)
            meta = json.loads(bytes(z["__meta__"]).decode())
        except Exception:
            pass
        steps = fin.get("solved_at") or fin.get("steps")
        crit = "" if fin.get("solved_at") else " (budget, not solved)"
        lines.append(f"| `{e['id']}` | {meta.get('params', '-')} | {steps if steps is not None else '-'}{crit} | {fin.get('seconds', '-')} s | {fmt(ev)} | {fmt(ctl.get('solver'))} | {fmt(ctl.get('random'))} | "
                     f"{(ev or {}).get('mean_commands', 0):.1f} / {(ctl.get('solver') or {}).get('mean_commands', 0):.1f} |")
    return "\n".join(lines)


def router_table(runs):
    p = pathlib.Path(runs) / "router" / "router.json"
    if not p.exists():
        return "(no router run)"
    r = json.loads(p.read_text())
    lines = ["| Router | Held-out accuracy | sparse / kit / threshold / threshold+junk | Latency per call | Model size | Fit time |", "| :-- | --: | :-- | --: | --: | --: |"]
    for k, v in r.items():
        lines.append(f"| {k} | {v['accuracy']:.4f} (n={v['n']}) | {v['kind0']:.3f} / {v['kind1']:.3f} / {v['kind2']:.3f} / {v['kind3']:.3f} | {v['latency_us']:.0f} us | {v['model_bytes'] / 1e6:.2f} MB | {v['fit_seconds']} s |")
    return "\n".join(lines)


def chain_table(runs):
    p = pathlib.Path(runs) / "chain.jsonl"
    if not p.exists():
        return "(no chain run)"
    lines = ["| Scenario | Router | Experts | Episodes | Goal reached | Mean commands | Experts' goals reached (episodes) |", "| :-- | :-- | :-- | --: | :-- | --: | :-- |"]
    for l in p.read_text().splitlines():
        s = json.loads(l)
        reach = ", ".join(f"{k} {v}" for k, v in s["expert_goal_reached"].items() if v)
        lines.append(f"| {s['scenario']} | {s['router']} | {s['experts']} | {s['episodes']} | {fmt(s)} | {s['mean_commands']:.0f} | {reach} |")
    return "\n".join(lines)


if __name__ == "__main__":
    runs = sys.argv[1] if len(sys.argv) > 1 else "/mnt/data/forgeaip/moe/runs"
    print("### Experts\n\n" + experts_table(runs) + "\n\n### Router\n\n" + router_table(runs) + "\n\n### Chain\n\n" + chain_table(runs))
