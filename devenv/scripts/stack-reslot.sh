#!/usr/bin/env bash
# forced slot migration behind stack-claim.sh's drift refusal: the shared teardown of the OLD slot
# (stack-release.sh), then a closing message pointing at the `task up` that re-claims and re-seeds
# from the newly configured slot.
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/stack-release.sh"

stack_reject_args stack-reslot "$@"
old=$(stack_applied_slot stack-reslot)
stack_teardown_slot stack-reslot "$old"
echo "✓ stack-reslot — slot $old torn down. Rebuild + claim the new slot: task up"
