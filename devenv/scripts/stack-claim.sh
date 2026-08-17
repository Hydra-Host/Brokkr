#!/usr/bin/env bash
# resolves this checkout's slot and persists it BEFORE devenv evaluates, so the first
# `devenv up -d` already renders the claimed slot's ports/fleet (fleet.yaml is cp -n-seeded
# and never re-seeds). slot 0 writes no file — it is the option default. the pin uses
# lib.mkDefault (1000): mkOptionDefault would tie the option's own `default = 0` definition
# (both 1500) and conflict; mkDefault stays weaker than any plain-priority pin
# (stack.local.nix / devenv.local.nix).
set -euo pipefail
cd "$(dirname "$0")/../.."
. devenv/lib/stack-registry.sh

: "${DEVENV_RUNTIME:?DEVENV_RUNTIME unset — run inside the devenv shell}"
: "${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"

configured=$(devenv eval stack.slot 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["stack.slot"])' 2>/dev/null || echo 0)
if [ -f stack.slot.nix ] || [ "$configured" != 0 ]; then
  want=$configured
else
  want=auto
fi
claimed=$(stack_registry_claim "$want" "$PWD" "$DEVENV_RUNTIME")
assert_slot "$claimed"

stamp="$DEVENV_STATE/stack-slot-applied"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" != "$claimed" ]; then
  echo "slot drift ($(cat "$stamp") -> $claimed): migrate with stack-reslot (task stack:reslot)" >&2
  exit 1
fi

if [ "$claimed" != 0 ] && [ ! -f stack.slot.nix ]; then
  printf '{ lib, ... }: { stack.slot = lib.mkDefault %s; }\n' "$claimed" >stack.slot.nix
  # the eval cache keys on the input-path set recorded WITHOUT the pin — creating it under a
  # warm cache would leave stack.up rendering the old slot; refresh to re-record the set.
  devenv eval --refresh-eval-cache stack.slot >/dev/null
  echo "claimed slot $claimed (persisted to stack.slot.nix)"
fi
