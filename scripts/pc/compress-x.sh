# Compress the old RL exchange logs in ~/x in place (owner 2026-11-11: C: is low). Text lines -> zstd/gzip; each file is verified before the original goes
# (zstd --rm and gzip replace a file only after a complete write; `-t` re-reads it). Files touched in the last 2 hours are left alone. Nothing is deleted otherwise.
cd ~/x || exit 1
if command -v zstd >/dev/null; then C='zstd -q -T2 -6 --rm'; T='zstd -q -t'; EXT=zst; else C='gzip -6'; T='gzip -t'; EXT=gz; fi
echo "compressor: $C   start $(date '+%F %T')   before: $(du -sh . | cut -f1)"
export C T EXT
one() { f=$1; $C "$f" 2>/dev/null && $T "$f.$EXT" 2>/dev/null && echo "ok $f" || echo "FAILED $f"; }
export -f one
find . -type f \( -name '*.jsonl' -o -name '*.log' -o -name '*.txt' -o -name '*.json' -o -name '*.csv' \) -size +1M ! -name '*.gz' ! -name '*.zst' -mmin +120 -print0 | nice -n 10 xargs -0 -P 6 -I{} bash -c 'one "$@"' _ {}
echo "done $(date '+%F %T')   after: $(du -sh . | cut -f1)   failed: $(grep -c FAILED ~/compress_x.log 2>/dev/null)"
