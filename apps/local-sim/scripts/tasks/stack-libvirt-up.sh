#!/usr/bin/env bash
# task libvirt:up — ensure libvirt is running.
# macOS: no-op — virtqemud is now the supervised `virtqemud` process-compose process.
# Linux: system libvirtd (the only platform this task does work on).
if [ "$(uname)" = "Darwin" ]; then
  echo "  ✓ macOS virtqemud is supervised by the 'virtqemud' process (skip)"
else
  # only virsh can answer whether qemu:///system is usable — an active unit says nothing about
  # socket permissions, so systemctl only classifies a failure virsh has already found.
  if out=$(virsh --connect qemu:///system list 2>&1); then
    echo "  ✓ system libvirtd active"
  else
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | head -3 | sed 's/^/    /' >&2
    fi
    case "$out" in
    *"ermission denied"*)
      echo "❌ the libvirt socket refused this user — a permissions problem, not a start problem" >&2
      echo "   join the 'libvirt' group, then log out and back in (a new shell does not pick it up):" >&2
      echo '     sudo usermod -aG libvirt "$(id -un)"' >&2
      exit 1
      ;;
    esac
    if systemctl is-active --quiet libvirtd 2>/dev/null ||
      systemctl is-active --quiet virtqemud.socket 2>/dev/null; then
      echo "❌ libvirtd is active but qemu:///system is unreachable (see the error above)" >&2
      exit 1
    fi
    # via the privileged helper (svc-start enforces a fixed {libvirtd, virtqemud.socket} allowlist).
    sudo "$LOCAL_SIM_PRIV_BIN" svc-start libvirtd 2>/dev/null || sudo "$LOCAL_SIM_PRIV_BIN" svc-start virtqemud.socket 2>/dev/null || true
    if virsh --connect qemu:///system list >/dev/null 2>&1; then
      echo "  ✓ libvirtd started"
    else
      echo "❌ system libvirtd is not reachable (try: sudo systemctl start libvirtd)" >&2
      exit 1
    fi
  fi
fi
