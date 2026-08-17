#!/usr/bin/env bash
# adopt-or-spawn: one user-session virtqemud serves every stack's domains on this host.
# Never pkill here — a sibling stack's VMs are served by the same daemon.
set -euo pipefail

# the [v] bracket keeps a sibling wrapper's concurrent `pgrep -f` (whose argv
# contains the literal pattern) from matching itself — otherwise two wrappers
# starting together both false-adopt and no daemon ever spawns
if pgrep -f '[v]irtqemud --timeout 0' >/dev/null 2>&1; then
  echo "virtqemud already running; adopting (this process is a no-op holder)"
  exec tail -f /dev/null
fi

# a bare virsh call auto-spawns a transient --timeout=120 daemon that holds the
# pidfile lock; wait for it to expire rather than racing it
for _ in $(seq 1 130); do
  pgrep -f '[v]irtqemud --timeout[= ]120' >/dev/null 2>&1 || break
  sleep 1
done

# a concurrent wrapper may have spawned during the wait — re-check before touching
# the socket paths, or our rm -f would unlink a live daemon's socket off the fs
if pgrep -f '[v]irtqemud --timeout 0' >/dev/null 2>&1; then
  echo "virtqemud appeared during the transient wait; adopting"
  exec tail -f /dev/null
fi

rm -f "$HOME/.cache/libvirt/virtqemud.pid" \
  "$HOME/.cache/libvirt/virtqemud-sock" \
  "$HOME/.cache/libvirt/virtqemud-admin-sock"
exec virtqemud --timeout 0
