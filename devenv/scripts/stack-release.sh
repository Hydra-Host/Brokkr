#!/usr/bin/env bash
# shared teardown body behind `stack-release` and `stack-reslot`: down, nuke the fleet with the
# RELEASED slot's env (its LOCAL_STATE/SIM_SLOT — another slot's would miss this one's libvirt tag
# and lo aliases), remove its bootptab section, wipe the datastore + slot-stamped state + the
# slot's host-global roots, drop the stale claim pin, and release the registry entry so the slot
# is free for another checkout. Sourced by stack-reslot.sh; run directly it is `stack-release`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
. devenv/lib/stack-registry.sh

: "${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
: "${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"

stack_usage() {
  echo "usage: $1   (takes no arguments; DESTRUCTIVE — tears this checkout's stack down and returns its slot to the host registry)"
}

# a destructive verb must never read an unrecognized argument as "proceed": both entrypoints take
# none, so anything but -h/--help refuses before the teardown starts.
stack_reject_args() {
  local verb=$1
  shift
  if [ "$#" -eq 0 ]; then return 0; fi
  if [ "$#" -eq 1 ]; then
    case "$1" in
    -h | --help)
      stack_usage "$verb"
      exit 0
      ;;
    esac
  fi
  {
    echo "$verb: unexpected argument '$1' — this verb takes no arguments"
    stack_usage "$verb"
  } >&2
  exit 64
}

stack_applied_slot() {
  local verb=$1 stamp slot
  stamp="$DEVENV_STATE/stack-slot-applied"
  [ -f "$stamp" ] || {
    echo "$verb: no applied slot stamp ($stamp) — this checkout owns no slot" >&2
    return 1
  }
  slot=$(cat "$stamp")
  # an empty/truncated stamp (a failed eval writes nothing through the > redirect) would
  # otherwise leave the registry entry uncleared — refuse before anything destructive
  assert_slot "$slot"
  printf '%s' "$slot"
}

stack_teardown_slot() {
  local verb=$1 slot=$2 suffix="" local_state storage agent
  stack-down || true
  stack-await-down

  # the host-global roots this slot owns (slot 0 keeps the legacy unsuffixed paths — spoke-paths.nix
  # derives the same rule for the live config, stack-purge-all.sh for foreign checkouts' slots).
  [ "$slot" = 0 ] || suffix="-s$slot"
  local_state="$HOME/.local/share/local$suffix"
  storage="/tmp/brokkr-dev$suffix"
  agent="/opt/brokkr/agent$suffix"

  # probe the helper, not the allowlisted /usr/bin/true: a sibling checkout's drop-in allowlists that
  # too while pinning a different helper, so the probe would pass and the call below prompt.
  if sudo -n "${LOCAL_SIM_PRIV_BIN:?LOCAL_SIM_PRIV_BIN unset}" noop 2>/dev/null; then
    sudo "${LOCAL_SIM_PRIV_BIN:?LOCAL_SIM_PRIV_BIN unset}" bootptab-section-remove "brokkr-slot-$slot" || true
  else
    echo "$verb: no passwordless sudo — slot $slot's bootptab section (brokkr-slot-$slot) stays; remove it with sudo later." >&2
  fi
  (
    export PYTHONPATH="$DEVENV_ROOT/apps/local-sim/scripts${PYTHONPATH:+:$PYTHONPATH}"
    cd "$DEVENV_ROOT/apps/local-sim"
    LOCAL_STATE="$local_state" SIM_SLOT="$slot" python -m local.fleet nuke
  ) || true

  stack-wipe-data
  rm -rf "$DEVENV_STATE/zone-crypto" "$DEVENV_STATE/telegraf" "$DEVENV_STATE/vrrp-sim"
  # must precede the release: stack-purge-all only sweeps REGISTERED slots, and stack-wipe-images
  # interpolates the spoke storage path at nix eval time (so after a slot change it names the NEW
  # slot) — once the entry is gone nothing can collect these.
  rm -rf "$storage" "$agent" "$local_state"
  rm -f "$DEVENV_STATE/stack-slot-applied" "$DEVENV_STATE/fleet.yaml"
  rm -f stack.slot.nix
  stack_registry_release "$slot"
}

if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  stack_reject_args stack-release "$@"
  slot=$(stack_applied_slot stack-release)
  stack_teardown_slot stack-release "$slot"
  echo "✓ stack-release — slot $slot torn down and returned to the host registry."
fi
