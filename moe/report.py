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


def _by(path, *keys):
    """Rows of a jsonl file keyed by the given fields (the last row of a key wins)."""
    p = pathlib.Path(path)
    out = {}
    if p.exists():
        for l in p.read_text().splitlines():
            if l.strip():
                r = json.loads(l)
                out[tuple(r.get(k) for k in keys)] = r
    return out


def _fails(s):
    if not s:
        return "-"
    o = s.get("outcomes", {})
    return f"died {o.get('died', 0)}, timeout {o.get('timeout', 0)}"


def experts_table(runs):
    """One row per expert and scenario file (v2 experts train on several: a trap is a shaft or a pocket, movement has open ground, detours and digging)."""
    cat = catalog.load()
    lines = ["| Expert | Scenario | Steps to criterion | Train time | Held-out: learned | scripted solver | uniform random | Commands (learned / solver) | Learned failures |",
             "| :-- | :-- | --: | --: | :-- | :-- | :-- | :-- | :-- |"]
    for e in cat["experts"]:
        d = pathlib.Path(runs) / e["id"]
        fin = _last(d / "train_result.json") or {}
        ev = _by(d / "eval.jsonl", "scenario")
        ctl = _by(d / "controls.jsonl", "scenario", "policy")
        old_ctl = _rows(d / "controls.jsonl", "policy")
        old_ev = _last(d / "eval.jsonl")
        steps = fin.get("solved_at") or fin.get("steps")
        crit = "" if fin.get("solved_at") else " (budget, not solved)"
        scns = sorted({k[0] for k in ev} | {k[0] for k in ctl}, key=lambda x: (x is not None, x)) or [None]
        for n, scn in enumerate(scns):
            r = ev.get((scn,)) or (old_ev if scn is None else None)
            sol = ctl.get((scn, "solver")) or (old_ctl.get("solver") if scn is None else None)
            rnd = ctl.get((scn, "random")) or (old_ctl.get("random") if scn is None else None)
            lines.append(f"| `{e['id']}` | {scn or e['id']} | {(str(steps) + crit) if n == 0 and steps is not None else ('-' if n else '-')} | {str(fin.get('seconds', '-')) + ' s' if n == 0 else ''} | {fmt(r)} | {fmt(sol)} | {fmt(rnd)} | "
                         f"{(r or {}).get('mean_commands', 0):.1f} / {(sol or {}).get('mean_commands', 0):.1f} | {_fails(r)} |")
    return "\n".join(lines)


def router_table(runs):
    p = pathlib.Path(runs) / "router" / "router.json"
    if not p.exists():
        return "(no router run)"
    r = json.loads(p.read_text())
    lines = ["| Router | Held-out accuracy | sparse / kit / threshold / threshold+junk / chain states | Latency per call | Model size | Fit time |", "| :-- | --: | :-- | --: | --: | --: |"]
    for k, v in r.items():
        lines.append(f"| {k} | {v['accuracy']:.4f} (n={v['n']}) | {v['kind0']:.3f} / {v['kind1']:.3f} / {v['kind2']:.3f} / {v['kind3']:.3f} / {v.get('kind4', float('nan')):.3f} | {v['latency_us']:.0f} us | {v['model_bytes'] / 1e6:.2f} MB | {v['fit_seconds']} s |")
    return "\n".join(lines)


def chain_table(runs):
    p = pathlib.Path(runs) / "chain.jsonl"
    if not p.exists():
        return "(no chain run)"
    lines = ["| Scenario | Router | Experts | Stall handling | Episodes | Goal reached | Mean commands | unstick calls | Outcomes | Experts' goals reached (episodes) |", "| :-- | :-- | :-- | :-- | --: | :-- | --: | --: | :-- | :-- |"]
    for l in p.read_text().splitlines():
        s = json.loads(l)
        reach = ", ".join(f"{k} {v}" for k, v in s["expert_goal_reached"].items() if v)
        stall = "-" if "greedy_stall" not in s else ("greedy (v1)" if s["greedy_stall"] else "sample, then unstick")
        lines.append(f"| {s['scenario']} | {s['router']} | {s['experts']} | {stall} | {s['episodes']} | {fmt(s)} | {s['mean_commands']:.0f} | {s.get('unstick_calls', '-')} | {_fails(s)} | {reach} |")
    return "\n".join(lines)


if __name__ == "__main__":
    runs = sys.argv[1] if len(sys.argv) > 1 else "/mnt/data/forgeaip/moe/runs"
    print("### Experts\n\n" + experts_table(runs) + "\n\n### Router\n\n" + router_table(runs) + "\n\n### Chain\n\n" + chain_table(runs))
