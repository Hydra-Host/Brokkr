#!/usr/bin/env bash
# task test:lifecycle:full:all — run the full lifecycle on ALL 4 sim nodes in
# parallel (each pinned via SIM_LC_DEVICE_INDEX=0..3). Per-node output → state logs.
LOGS="$HOME/.local/share/local/state/logs"
echo "running full LC on gpu-1..4 in parallel → $LOGS/lc-gpu{1..4}.log"
pids=""
for i in 0 1 2 3; do
  SIM_LC_DEVICE_INDEX=$i pytest tests/e2e/test_lifecycle.py -v -m 'lifecycle and full' \
    >"$LOGS/lc-gpu$((i + 1)).log" 2>&1 &
  pids="$pids $!"
  echo "  gpu$((i + 1)) (idx $i) → pid $!"
done
rc=0
for p in $pids; do wait "$p" || rc=1; done
echo ""
echo "=== results ==="
for i in 1 2 3 4; do
  printf "  gpu%s: " "$i"
  grep -hE "[0-9]+ (passed|failed|error)" "$LOGS/lc-gpu$i.log" | tail -1
done
[ "$rc" = 0 ] && echo "✓ all 4 passed" || echo "✗ at least one failed — see $LOGS/lc-gpu*.log"
exit $rc
