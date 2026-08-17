#!/usr/bin/env bash
# task fleet:shells — rebuild the shells tmux window: tiled, one pane per VM with
# an interactive SOL console via the BMC (resilient: survives VM power-cycles).
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
NODES=$(python -c "from local.fleet import load_fleet; f = load_fleet(); print(' '.join(n.name for n in f.nodes) if f else '')")
if [ -z "$NODES" ]; then
  echo "no nodes in fleet.yml" >&2
  exit 1
fi
tmux new-session -d -s brokk-local 2>/dev/null || true
# Platform libvirt URI: qemu:///system on Linux, qemu:///session on macOS.
# Hardcoding session broke `virsh console` on Linux (domains live under system).
URI=$(python -c "from local.host_os import libvirt_uri; print(libvirt_uri())")
tmux kill-window -t brokk-local:shells 2>/dev/null || true
FIRST=1
for NAME in $NODES; do
  if [ "$FIRST" = "1" ]; then
    tmux new-window -d -t brokk-local -n shells
    PANE=$(tmux list-panes -t brokk-local:shells -F "#{pane_id}" | head -1)
    FIRST=0
  else
    PANE=$(tmux split-window -dPF "#{pane_id}" -t brokk-local:shells)
  fi
  tmux select-pane -t "$PANE" -T "$NAME"
  # Resilient console: survives VM power-cycles (reattaches automatically)
  # instead of dropping to a dead shell that needs a manual window reload.
  tmux send-keys -t "$PANE" "bash '$ROOT/scripts/vm-console.sh' $NAME '$URI'" Enter
  tmux select-layout -t brokk-local:shells tiled
done
