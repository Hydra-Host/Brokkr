#!/usr/bin/env bash
# host-wide teardown: siblings first (socket down + SIGTERM to the recorded pc-supervisor
# pid), this checkout's stack last. Tombstones every entry it downs. `task down:all`.
set -euo pipefail
cd "$(dirname "$0")/../.."
. devenv/lib/stack-registry.sh

: "${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"

stack_registry_gc
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  checkout=$(printf '%s' "$entry" | json_get checkout)
  if [ "$checkout" = "$DEVENV_ROOT" ]; then
    continue
  fi
  slot=$(printf '%s' "$entry" | json_get slot)
  sock=$(printf '%s' "$entry" | json_get pcSock)
  if process-compose -U -u "$sock" process list -o json >/dev/null 2>&1; then
    echo "→ stopping sibling stack at $checkout (slot $slot)"
    process-compose -U -u "$sock" down 2>/dev/null || true
    pid=$(printf '%s' "$entry" | json_get pcDaemonPid)
    case "$pid" in '' | *[!0-9]*) pid=0 ;; esac
    if [ "$pid" -gt 1 ] 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  fi
  stack_registry_mark_down "$slot"
done < <(stack_registry_list)

task down

# each sibling's own fleet down removes its bootptab section; sweep stragglers for stacks
# that were already dead when we got here. no-op without passwordless sudo.
if sudo -n true 2>/dev/null; then
  while IFS= read -r entry; do
    [ -n "$entry" ] || continue
    slot=$(printf '%s' "$entry" | json_get slot)
    assert_slot "$slot" || continue
    sudo "${LOCAL_SIM_PRIV_BIN:?LOCAL_SIM_PRIV_BIN unset}" bootptab-section-remove "brokkr-slot-$slot" || true
  done < <(stack_registry_list)
fi
