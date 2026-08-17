#!/usr/bin/env bash
# host-wide purge: stack-down-all, then wipe every REGISTERED slot's host-global state (spoke
# storage / sim state / agent bundle — slot 0's legacy roots only when slot 0 is or was
# registered, never blindly) and clear the registry. per-checkout .devenv/state wipes stay
# with each checkout's own local:purge. `task purge:all`.
set -euo pipefail
cd "$(dirname "$0")/../.."
. devenv/lib/stack-registry.sh

bash devenv/scripts/stack-down-all.sh

slot0=0
while IFS= read -r entry; do
  [ -n "$entry" ] || continue
  slot=$(printf '%s' "$entry" | json_get slot)
  assert_slot "$slot"
  if [ "$slot" = 0 ]; then
    slot0=1
  else
    rm -rf "/tmp/brokkr-dev-s$slot" "$HOME/.local/share/local-s$slot" "/opt/brokkr/agent-s$slot"
  fi
done < <(stack_registry_list)
if [ "$slot0" = 1 ]; then
  rm -rf /tmp/brokkr-dev "$HOME/.local/share/local" /opt/brokkr/agent
fi
rm -f "$(registry_dir)"/stack-*.json
echo "✓ stack-purge-all — all registered stacks down; per-slot host-global state wiped."
