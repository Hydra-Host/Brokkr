#!/usr/bin/env bash
# sibling-stack iteration over the host slot registry. `report` prints one line per OTHER
# stack (slot, checkout, state, liveness, up/total processes) and touches nothing. `down`
# (the explicit `task down:others` + stack-purge's guard) stops each live sibling via its
# pc.sock and tombstones its entry.
set -euo pipefail
cd "$(dirname "$0")/../.."
. devenv/lib/stack-registry.sh

mode=${1:?usage: stack-others.sh <report|down>}
: "${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"

if [ "$mode" = down ]; then
  echo "⚠ stopping sibling checkouts' stacks (their checkouts + data stay intact)."
fi

stopped=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  checkout=$(printf '%s' "$entry" | json_get checkout)
  if [ "$checkout" = "$DEVENV_ROOT" ]; then
    continue
  fi
  slot=$(printf '%s' "$entry" | json_get slot)
  state=$(printf '%s' "$entry" | json_get state)
  sock=$(printf '%s' "$entry" | json_get pcSock)
  live=0
  if [ -S "$sock" ] && process-compose -U -u "$sock" process list -o json >/dev/null 2>&1; then
    live=1
  fi
  if [ "$mode" = report ]; then
    uptasks="-"
    if [ "$live" = 1 ]; then
      uptasks=$(process-compose -U -u "$sock" process list -o json 2>/dev/null | python3 -c '
import json, sys
procs = json.load(sys.stdin)
running = sum(1 for p in procs if p.get("status") == "Running")
print(f"{running}/{len(procs)}")' || echo "-")
    fi
    printf 'slot %-3s %-50s state=%-5s live=%s up=%s\n' "$slot" "$checkout" "$state" "$live" "$uptasks"
  else
    if [ "$live" = 1 ]; then
      echo "→ stopping sibling stack at $checkout (slot $slot)"
      process-compose -U -u "$sock" down 2>/dev/null || true
      stopped=$((stopped + 1))
      for _ in $(seq 1 30); do
        process-compose -U -u "$sock" process list -o json >/dev/null 2>&1 || break
        sleep 1
      done
    fi
    stack_registry_mark_down "$slot"
  fi
done < <(stack_registry_list)

# stack-reap kills EVERY virtqemud incl. a live sibling's — only run it when we actually
# stopped a foreign stack (its teardown may leave host-global orphans), never on a no-op pass.
if [ "$mode" = down ] && [ "$stopped" -gt 0 ]; then
  stack-reap || true
fi
