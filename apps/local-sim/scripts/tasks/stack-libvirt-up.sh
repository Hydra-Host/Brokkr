#!/usr/bin/env bash
# task libvirt:up — ensure libvirt is running.
# macOS: no-op — virtqemud is now the supervised `virtqemud` process-compose process.
# Linux: system libvirtd (the only platform this task does work on).
if [ "$(uname)" = "Darwin" ]; then
  echo "  ✓ macOS virtqemud is supervised by the 'virtqemud' process (skip)"
else
  # Linux: libvirt runs as a system service (qemu:///system). Verify it's
  # up (socket-activated virtqemud.socket counts) and start if a reboot
  # left it down.
  if systemctl is-active --quiet libvirtd 2>/dev/null ||
    systemctl is-active --quiet virtqemud.socket 2>/dev/null ||
    virsh --connect qemu:///system list >/dev/null 2>&1; then
    echo "  ✓ system libvirtd active"
  else
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
