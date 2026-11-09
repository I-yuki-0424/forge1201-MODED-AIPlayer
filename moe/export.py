"""Export of trained skill experts for the JavaScript bot (src/experts): weights as JSON, the feature constants, and golden observations with the Python outputs
that tests/test_experts_pure.js checks the JavaScript port against."""
import json
import pathlib

import numpy as np

from . import catalog, features, policy


def _tolist(a, digits=7):
    return np.vectorize(lambda x: float(f"{x:.{digits}g}"))(np.asarray(a, dtype=np.float32)).tolist()


def export_models(runs_dir, out_dir, experts=("move", "unstick")):
    """<out>/<expert>.json (weights + how the router shows it its world) and <out>/features.json (constants of the featurizer)."""
    cat = catalog.load()
    out = pathlib.Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    by = catalog.experts(cat)
    for name in experts:
        e = by[name]
        params, meta = policy.load(pathlib.Path(runs_dir) / name / "final.npz")
        doc = {"expert": name, "kind": e.get("kind", "item"), "rel": list(catalog.relevance(e)), "anon": e.get("kind") == "skill",
               "actions": catalog.action_ids(e), "max_steps": e["max_steps"], "reach": e["goal"].get("reach"), "hidden": meta["hidden"],
               "ctx_dim": meta["ctx_dim"], "cand_dim": meta["cand_dim"], "steps": meta.get("steps"), "success_recent": meta.get("success_recent"),
               "params": {k: {"w": _tolist(v["w"]), "b": _tolist(v["b"])} for k, v in params.items()}}
        (out / f"{name}.json").write_text(json.dumps(doc, separators=(",", ":")))
    f = features.Featurizer(["none"] + list(cat["items"]), cat["items"])
    (out / "features.json").write_text(json.dumps({"core": cat["items"], "groups": list(features.GROUPS), "M": features.M, "T": features.T, "K": features.K, "N_CMD": features.N_CMD,
                                                   "N_CAT": features.N_CAT, "N_REASON": features.N_REASON, "GRID_LAYERS": features.GRID_LAYERS, "cmds": list(catalog.CMDS),
                                                   "ctx_dim": f.ctx_dim, "cand_dim": f.cand_dim}, indent=1))
    return [str(out / f"{n}.json") for n in experts] + [str(out / "features.json")]


def record_golden(vec, feat, vocab, expert, params, n, out_path, seed=0):
    """Play the expert on running shards and keep `n` observations spread over the episodes together with what the Python code computes from them."""
    import time
    rel, anon, acts = catalog.relevance(expert), expert.get("kind") == "skill", catalog.action_ids(expert)
    rng = np.random.default_rng(seed)
    rows, t0 = [], time.time()
    while len(rows) < n and time.time() - t0 < 300:
        obs = vec.poll()
        live = [o for o in obs if not o.terminated]
        if not live:
            time.sleep(0.002)
            continue
        ctx = np.stack([feat.ctx(o.raw, rel, anon) for o in live])
        cc = [feat.cands(o.raw, rel, anon, acts) for o in live]
        cand, mask = np.stack([c[0] for c in cc]), np.stack([c[1] for c in cc])
        logits, value = policy.forward(params, ctx, cand, mask)
        logits, value = np.asarray(logits), np.asarray(value)
        for i, o in enumerate(live):
            if len(rows) < n and (o.step < 3 or rng.random() < 0.25):
                rows.append({"obs": o.raw, "ctx": _tolist(ctx[i], 6), "cand": _tolist(cand[i], 6), "mask": mask[i].tolist(), "logits": _tolist(np.where(mask[i], logits[i], 0.0), 6),
                             "value": float(value[i]), "action": int(np.argmax(logits[i]))})
            vec.act(o, int(np.argmax(logits[i])) if rng.random() < 0.9 else int(rng.integers(0, max(int(mask[i].sum()), 1))))
    pathlib.Path(out_path).write_text(json.dumps({"expert": expert["id"], "rel": list(rel), "anon": anon, "actions": acts, "vocab": vocab, "rows": rows}, separators=(",", ":")))
    return len(rows)
