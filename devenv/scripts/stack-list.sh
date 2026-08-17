#!/usr/bin/env bash
# STACKS table for `task local:status`: every registry entry (slot, checkout basename, state,
# pc.sock liveness, hub URL from the entry's denormalized ports map).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit
. devenv/lib/stack-registry.sh

echo "STACKS"
entries=$(stack_registry_list)
if [ -z "$entries" ]; then
  echo "  (no stacks registered — task up claims a slot)"
  exit 0
fi
printf '%s\n' "$entries" | while IFS= read -r entry; do
  slot=$(printf '%s' "$entry" | json_get slot)
  checkout=$(printf '%s' "$entry" | json_get checkout)
  state=$(printf '%s' "$entry" | json_get state)
  sock=$(printf '%s' "$entry" | json_get pcSock)
  hub=$(printf '%s' "$entry" | python3 -c '
import json, sys
ports = json.loads(sys.stdin.read()).get("ports") or {}
base = (ports.get("hubApi") or {}).get("base")
print(f"http://localhost:{base}" if base else "-")')
  live="no"
  if [ -S "$sock" ] && process-compose -U -u "$sock" process list -o json >/dev/null 2>&1; then
    live="yes"
  fi
  printf '  slot %-3s %-24s state=%-5s live=%-3s hub=%s\n' "$slot" "$(basename "$checkout")" "$state" "$live" "$hub"
done
