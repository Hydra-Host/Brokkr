#!/usr/bin/env bash
# forced slot migration behind stack-claim.sh's drift refusal: down, nuke the fleet with the
# OLD slot's env (its LOCAL_STATE/SIM_SLOT — the new slot's would miss the old libvirt tag and
# lo aliases), remove the old bootptab section, wipe the datastore + slot-stamped state + the
# old slot's host-global roots, drop the stale claim pin, and release the registry entry so the
# next `task up` re-claims and re-seeds from the new slot.
set -euo pipefail
cd "$(dirname "$0")/../.."
. devenv/lib/stack-registry.sh

: "${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
: "${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"

stamp="$DEVENV_STATE/stack-slot-applied"
[ -f "$stamp" ] || {
  echo "stack-reslot: no applied slot stamp ($stamp) — nothing to migrate" >&2
  exit 1
}
old=$(cat "$stamp")
# an empty/truncated stamp (a failed eval writes nothing through the > redirect) would
# otherwise leave the registry entry uncleared — refuse before anything destructive
assert_slot "$old"

stack-down || true
stack-await-down

# the host-global roots this slot owns (slot 0 keeps the legacy unsuffixed paths — spoke-paths.nix
# derives the same rule for the live config, stack-purge-all.sh for foreign checkouts' slots).
old_suffix=""
[ "$old" = 0 ] || old_suffix="-s$old"
old_local_state="$HOME/.local/share/local$old_suffix"
old_storage="/tmp/brokkr-dev$old_suffix"
old_agent="/opt/brokkr/agent$old_suffix"

if sudo -n true 2>/dev/null; then
  sudo "${LOCAL_SIM_PRIV_BIN:?LOCAL_SIM_PRIV_BIN unset}" bootptab-section-remove "brokkr-slot-$old" || true
else
  echo "stack-reslot: no passwordless sudo — the old bootptab section (brokkr-slot-$old) stays; remove it with sudo later." >&2
fi
(
  export PYTHONPATH="$DEVENV_ROOT/apps/local-sim/scripts${PYTHONPATH:+:$PYTHONPATH}"
  cd "$DEVENV_ROOT/apps/local-sim"
  LOCAL_STATE="$old_local_state" SIM_SLOT="$old" python -m local.fleet nuke
) || true

stack-wipe-data
rm -rf "$DEVENV_STATE/zone-crypto" "$DEVENV_STATE/telegraf" "$DEVENV_STATE/vrrp-sim"
# must precede the release: stack-purge-all only sweeps REGISTERED slots, and stack-wipe-images
# interpolates the spoke storage path at nix eval time (so post-migration it names the NEW slot) —
# once the entry is gone nothing can collect these.
rm -rf "$old_storage" "$old_agent" "$old_local_state"
rm -f "$stamp" "$DEVENV_STATE/fleet.yaml"
rm -f stack.slot.nix
stack_registry_release "$old"
echo "✓ stack-reslot — slot $old torn down. Rebuild + claim the new slot: task up"
