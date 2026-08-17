#!/usr/bin/env bash
# task fleet:consoles — rebuild the consoles tmux window: tiled, one pane per VM
# tailing its serial log (read-only).
set -e
NODES=$(python -c "from local.fleet import load_fleet; f = load_fleet(); print(' '.join(n.name for n in f.nodes) if f else '')")
if [ -z "$NODES" ]; then
  echo "no nodes in fleet.yml" >&2
  exit 1
fi
tmux new-session -d -s brokk-local 2>/dev/null || true
tmux kill-window -t brokk-local:consoles 2>/dev/null || true
FIRST=1
for NAME in $NODES; do
  LOG="$HOME/.local/share/local/state/logs/$NAME.log"
  if [ "$FIRST" = "1" ]; then
    tmux new-window -d -t brokk-local -n consoles
    PANE=$(tmux list-panes -t brokk-local:consoles -F "#{pane_id}" | head -1)
    FIRST=0
  else
    PANE=$(tmux split-window -dPF "#{pane_id}" -t brokk-local:consoles)
  fi
  tmux select-pane -t "$PANE" -T "$NAME"
  tmux send-keys -t "$PANE" "tail -F \"$LOG\"" Enter
  tmux select-layout -t brokk-local:consoles tiled
done
