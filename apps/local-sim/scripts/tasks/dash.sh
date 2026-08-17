#!/usr/bin/env bash
# task dash — single dashboard window: hub (top) / spoke (row 2) / one console
# pane per fleet node stacked below. Adds the VM consoles beneath the running
# hub/spoke (no restart). Re-runnable and fleet-size agnostic.
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." && pwd)"
tmux new-session -d -s brokk-local 2>/dev/null || true
W=brokk-local:stack
NODES=$(python -c "from local.fleet import load_fleet; f = load_fleet(); print(' '.join(n.name for n in f.nodes) if f else '')")
URI=$(python -c "from local.host_os import libvirt_uri; print(libvirt_uri())")
# Re-runnable: drop EVERY pane except hub + spoke — not just `gpu-*`-titled ones.
# (The fleet size is variable, and a prior run could have left an untitled or
# differently-named console pane; matching only `gpu-*` leaked those on rerun.)
for p in $(tmux list-panes -t "$W" -F '#{pane_id} #{pane_title}' | awk '$2!="hub" && $2!="spoke"{print $1}'); do
  tmux kill-pane -t "$p" 2>/dev/null || true
done
SPOKE=$(tmux list-panes -t "$W" -F '#{pane_id} #{pane_title}' | awk '$2=="spoke"{print $1}')
HUB=$(tmux list-panes -t "$W" -F '#{pane_id} #{pane_title}' | awk '$2=="hub"{print $1}')
if [ -z "$SPOKE" ] || [ -z "$HUB" ]; then
  echo "hub/spoke panes not found in $W — run 'task sim:dash' from a stack that has them" >&2
  exit 1
fi
# One console pane per node, stacked below spoke (works for any node count).
n=0
last="$SPOKE"
for NAME in $NODES; do
  P=$(tmux split-window -v -d -P -F '#{pane_id}' -t "$last")
  tmux select-pane -t "$P" -T "$NAME"
  tmux send-keys -t "$P" "bash '$ROOT/scripts/vm-console.sh' $NAME '$URI'" Enter
  last="$P"
  n=$((n + 1))
done
# Even out the console panes, then keep hub + spoke compact on top.
tmux select-layout -t "$W" even-vertical >/dev/null 2>&1 || true
tmux resize-pane -t "$HUB" -y 10 2>/dev/null || true
tmux resize-pane -t "$SPOKE" -y 10 2>/dev/null || true
echo "✓ dashboard built in window 'stack' — hub / spoke / ${n} VM console(s)"
