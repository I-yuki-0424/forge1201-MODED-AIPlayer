#!/usr/bin/env bash
# scripts/t26/speed_sample.sh N OUT.jsonl [EVERY_S]   sample the speed of test world N until killed (docs/implemented/SPEED-v1.md, TASK-20261125-079): every EVERY_S seconds (default 10)
# one JSON line with the server's own tick statistics (`/tick query`: target rate, mean and P50/P95/P99 ms per tick over the last 100 ticks), the world's game time (the
# achieved tick rate is its difference over wall time), the CPU and memory of the server and of every harness container of the world, and the host's contention: load, the share
# of all CPU time that was busy and that was stolen by the hypervisor since the last sample (/proc/stat), so a number measured on a busy host is never read as the factor's ceiling.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
tw_names "${1:?world number}"; OUT=${2:?out file}; EVERY=${3:-10}
R() { "$TW_REPO/scripts/t26/rcon.sh" "$TW_N" "$@" 2>/dev/null; }
P0=$(head -1 /proc/stat)
while :; do
  T=$(date +%s.%N); Q=$(R tick query | tr '\n' ' '); G=$(R time query gametime | tr '\n' ' ')
  S=$(docker stats --no-stream --format '{{.Name}} {{.CPUPerc}} {{.MemUsage}}' "$TW_SERVER" $(docker ps --format '{{.Names}}' | grep "^live-$TW_TAG-$TW_N-") 2>/dev/null | tr '\n' ';')
  L=$(cut -d' ' -f1 /proc/loadavg); P1=$(head -1 /proc/stat)
  python3 -I - "$T" "$Q" "$G" "$S" "$L" "$P0" "$P1" >> "$OUT" <<'PY'
import json, re, sys
t, q, g, s, load, p0, p1 = sys.argv[1:]
num = lambda p, x: (lambda m: float(m.group(1)) if m else None)(re.search(p, x))
a, b = [list(map(int, x.split()[1:9])) for x in (p0, p1)]            # user nice system idle iowait irq softirq steal
d = [y - x for x, y in zip(a, b)]; tot = sum(d) or 1
row = {"t": round(float(t), 2), "target_tps": num(r"Target tick rate: ([\d.]+)", q), "mspt": num(r"Average time per tick: ([\d.]+)ms", q),
       "p50": num(r"P50: ([\d.]+)ms", q), "p95": num(r"P95: ([\d.]+)ms", q), "p99": num(r"P99: ([\d.]+)ms", q),
       "frozen": "frozen" in q.lower(), "sprint": "sprint" in q.lower(), "gametime": num(r"The time is (\d+)", g), "load": float(load),
       "host_busy": round(100 * (tot - d[3] - d[4]) / tot, 1), "steal": round(100 * d[7] / tot, 1), "cpu": {}, "mem": {}}
for part in filter(None, s.split(";")):
    name, cpu, *mem = part.split()
    row["cpu"][name] = float(cpu.rstrip("%")); row["mem"][name] = mem[0] if mem else None
print(json.dumps(row))
PY
  P0=$P1
  sleep "$EVERY"
done
