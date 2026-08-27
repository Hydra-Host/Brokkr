#!/usr/bin/env bash
# Single host-readiness authority: group membership, libvirt, docker, KVM.
# Called by stack-up before the slot claim; spliced into `task doctor` with --report.
#
# No `set -e`: every probe must run, so one fault never hides the next.
set -u

REPORT=0
case "${1:-}" in
--report) REPORT=1 ;;
esac

# from install.sh detect_tty: a redirection error on a special builtin exits a non-interactive
# shell outright, so the terminal probe has to be contained in a subshell.
if (true >/dev/tty) 2>/dev/null; then HAVE_TTY=1; else HAVE_TTY=0; fi

# a blocker nobody can act on must not strand a detached bring-up (the control center restarts
# the stack with no terminal). The glyph and the exit code soften; the marker keeps the severity.
DOWNGRADE=0
if [ "$HAVE_TTY" != 1 ] && [ "$REPORT" != 1 ]; then DOWNGRADE=1; fi

TIMEOUT="${BROKK_HOST_CHECK_TIMEOUT:-5}"
AUTOSTART="${BROKK_FLEET_AUTOSTART:-true}"
KVM_DEVICE="${BROKK_KVM_DEVICE:-/dev/kvm}"
QEMU_CONF="${BROKK_HOST_CHECK_QEMU_CONF:-/etc/libvirt/qemu.conf}"

blocked=0
warned=0
stale_blocked=0
FINDINGS=()

TCG_HEADLINE="KVM is not available. This fleet uses TCG software emulation instead."
TCG_PREAMBLE="TCG emulates each CPU instruction in software.
VM boot and OS install become 5 to 20 times slower. Some spoke timeouts can expire.
A running VM keeps its accelerator. A KVM repair applies on the next cold cycle."
TCG_NO_DEVICE="Cause 1: the guest has no /dev/kvm.
  Enable nested virtualization on the hypervisor.
  On Proxmox, set the guest CPU type to 'host'.
  Power the guest off, then on. A reset does not add CPU flags.
  Run 'grep -c -E \" (vmx|svm) \" /proc/cpuinfo'. A zero means the CPU type is wrong."
TCG_NO_ACCESS="Cause 2: /dev/kvm exists, but the libvirt qemu user cannot read and write it.
  Add that user to the group that owns /dev/kvm.
  Restart libvirtd."
TCG_FOOTER="To force one backend, set LOCAL_ACCEL to kvm, tcg, or hvf."

_bounded() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "$TIMEOUT" "$@"
  else
    "$@"
  fi
}

# Fields are carried as raw argv, never escaped by hand: `fix` holds virsh stderr verbatim, and
# python3 (pinned by the bats gate; jq is not on this tier's PATH) owns the JSON encoding.
_record() {
  FINDINGS+=("$1" "$2" "$3" "$4")
}

_pass() { printf '%s\n' "✓ $1"; }

_skip() {
  printf '%s\n' "· $2"
  _record "$1" skip "$2" ""
}

_warn() {
  warned=$((warned + 1))
  printf '%s\n' "⚠ $2"
  printf '%s\n' "$3" | sed 's/^/    /'
  _record "$1" warn "$2" "$3"
}

_block() {
  local fix="$3
or set BROKK_SKIP_HOST_CHECK=1 to bring the stack up anyway."
  blocked=$((blocked + 1))
  if [ "$DOWNGRADE" = 1 ]; then printf '%s\n' "⚠ $2"; else printf '%s\n' "✗ $2"; fi
  printf '%s\n' "$fix" | sed 's/^/    /'
  _record "$1" block "$2" "$fix"
}

# One finding for the whole pending set, counted apart from the real blockers: the remedy is the
# same login for every group, and finish() exits 78 when a re-login is all that is owed.
_block_stale_groups() {
  _block groups "new group membership is not active in this session: $1" \
    "log out and back in (or reboot), then re-run 'task up'.
newgrp activates one group in one shell and does not fix the stack supervisor."
  stale_blocked=$((stale_blocked + 1))
}

# `id -nG` with no operand reports the LIVE process credentials; with a user operand it reports
# the group database. The difference is what usermod added and this login has not picked up.
_in_db() { id -nG "$1" 2>/dev/null | tr ' ' '\n' 2>/dev/null | grep -qx "$2"; }
_in_live() { id -nG 2>/dev/null | tr ' ' '\n' 2>/dev/null | grep -qx "$2"; }

check_groups() {
  local user g fix stale=""
  if [ "$(id -u 2>/dev/null || printf '1000\n')" = 0 ]; then
    _skip groups "running as uid 0 — the group probes do not apply."
    return 0
  fi
  user="$(id -un 2>/dev/null || printf '%s\n' "${USER:-}")"
  for g in libvirt kvm docker; do
    if ! getent group "$g" >/dev/null 2>&1; then
      _skip groups "no '$g' group on this host — nothing to join."
    elif _in_live "$user" "$g"; then
      _pass "'$g' group is active in this session"
    elif _in_db "$user" "$g"; then
      stale="${stale:+$stale, }$g"
    else
      # libvirt and kvm gate the fleet, so only an auto-starting fleet makes them blocking.
      # docker is never blocking — only the iPXE build needs it, long after this check.
      fix="sudo usermod -aG $g $user   # then log out and back in"
      if [ "$g" != docker ] && [ "$AUTOSTART" = true ]; then
        _block groups "not a member of '$g'" "$fix"
      else
        _warn groups "not a member of '$g'" "$fix"
      fi
    fi
  done
  [ -z "$stale" ] || _block_stale_groups "$stale"
}

check_libvirt() {
  local err rc=0
  err="$(_bounded virsh --connect qemu:///system list 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" = 0 ]; then
    _pass "libvirt reachable at qemu:///system"
  elif printf '%s' "$err" | grep -qi 'permission denied'; then
    _skip libvirt "libvirt: permission denied on qemu:///system — the 'libvirt' group is the fix, not a daemon restart."
  elif ! _bounded systemctl is-active --quiet libvirtd 2>/dev/null &&
    ! _bounded systemctl is-active --quiet virtqemud.socket 2>/dev/null; then
    _warn libvirt "libvirtd is not running" "sudo systemctl enable --now libvirtd"
  else
    _warn libvirt "libvirt unreachable at qemu:///system" "$(printf '%s' "$err" | head -3)
inspect the daemon: journalctl -u libvirtd -n 50"
  fi
}

check_docker() {
  local err rc=0 darwin=0
  [ "$(uname -s 2>/dev/null)" != Darwin ] || darwin=1
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$darwin" = 1 ]; then
      _warn docker "docker not found" "install Docker Desktop, then: open -a Docker"
    else
      _warn docker "docker not found" "the host bootstrap installs it: task local:setup"
    fi
    return 0
  fi
  err="$(_bounded docker version --format '{{.Server.Version}}' 2>&1 >/dev/null)" || rc=$?
  if [ "$rc" != 0 ]; then
    if printf '%s' "$err" | grep -qi 'permission denied'; then
      _warn docker "docker refused this session: permission denied" \
        "sudo usermod -aG docker $(id -un 2>/dev/null || printf '%s\n' "${USER:-}")   # then log out and back in"
    elif [ "$darwin" = 1 ]; then
      _warn docker "docker is installed but not running" "start it: open -a Docker"
    else
      _warn docker "docker is installed but not running" "sudo systemctl enable --now docker"
    fi
    return 0
  fi
  _pass "docker daemon reachable"
  if _bounded docker buildx version >/dev/null 2>&1; then
    _pass "docker buildx plugin present"
  else
    _warn docker "docker buildx plugin missing" \
      "the fleet iPXE build (fleet:init) runs 'docker buildx build -o type=local' — install the buildx plugin."
  fi
}

# qemu.conf ships `user` commented out; that commented value is the effective user, not root.
# Assuming root short-circuits _kvm_usable into a false pass on the un-bootstrapped hosts we diagnose.
_qemu_user() {
  local u="" line=""
  if [ -r "$QEMU_CONF" ]; then
    line="$(grep -E '^[[:space:]]*user[[:space:]]*=' "$QEMU_CONF" 2>/dev/null | tail -1)"
    [ -n "$line" ] || line="$(grep -E '^[[:space:]]*#+[[:space:]]*user[[:space:]]*=' "$QEMU_CONF" 2>/dev/null | tail -1)"
    u="$(printf '%s' "$line" | sed -e 's/^[^=]*=[[:space:]]*//' -e 's/["'"'"']//g' -e 's/[[:space:]]*$//')"
  fi
  printf '%s\n' "${u:-root}"
}

# never test -r / access() here: CI and the bats tier run as root, where a real read probe passes
# on a device the qemu user cannot open. Decide from the mode bits against that user's groups.
_kvm_usable() {
  local user="$1" mode owner group digit
  [ "$user" != root ] || return 0
  read -r mode owner group <<<"$(stat -c '%a %U %G' "$KVM_DEVICE" 2>/dev/null)"
  [ -n "${mode:-}" ] || return 1
  mode="${mode: -3}"
  if [ "$user" = "${owner:-}" ]; then
    digit="${mode:0:1}"
  elif id -nG "$user" 2>/dev/null | tr ' ' '\n' | grep -qx "${group:-}"; then
    digit="${mode:1:1}"
  else
    digit="${mode:2:1}"
  fi
  case "$digit" in
  [0-7]) [ $((8#$digit & 6)) -eq 6 ] ;;
  *) return 1 ;;
  esac
}

check_kvm() {
  local qemu_user
  if [ ! -e "$KVM_DEVICE" ]; then
    _warn kvm "$TCG_HEADLINE" "$TCG_PREAMBLE
$TCG_NO_DEVICE
$TCG_FOOTER"
    return 0
  fi
  qemu_user="$(_qemu_user)"
  if _kvm_usable "$qemu_user"; then
    _pass "$KVM_DEVICE is readable and writable by the libvirt qemu user '$qemu_user'"
  else
    _warn kvm "$TCG_HEADLINE" "$TCG_PREAMBLE
$TCG_NO_ACCESS
$TCG_FOOTER"
  fi
}

# write-then-rename, matching the lab's own marker readers: a reader never sees a half file.
write_marker() {
  local dir="${DEVENV_STATE:-}" path tty=false
  [ -n "$dir" ] || return 0
  [ "$HAVE_TTY" != 1 ] || tty=true
  path="$dir/host-access.json"
  mkdir -p "$dir" 2>/dev/null || return 0
  python3 -c '
import json, sys
n = sys.argv
out = {"checkedAt": int(n[1]), "hadTty": n[2] == "true", "blocked": int(n[3]), "warned": int(n[4]),
       "findings": [dict(zip(("probe", "severity", "title", "fix"), n[i:i + 4]))
                    for i in range(5, len(n), 4)]}
sys.stdout.write(json.dumps(out) + "\n")
' "$(date +%s)" "$tty" "$blocked" "$warned" ${FINDINGS+"${FINDINGS[@]}"} >"$path.tmp" 2>/dev/null || return 0
  mv "$path.tmp" "$path" 2>/dev/null || return 0
}

finish() {
  write_marker
  if [ "$blocked" != 0 ] && [ "$DOWNGRADE" = 1 ]; then
    printf '%s\n' "⚠ host access: $blocked blocking issue(s) above — no terminal to stop on, so the bring-up continues over a host that cannot work."
    exit 0
  elif [ "$blocked" = "$stale_blocked" ] && [ "$blocked" != 0 ]; then
    # 78 is install.sh's RC_GROUPS_STALE: nothing failed, so the caller stops as a checkpoint
    printf '%s\n' "· host access: nothing failed — a fresh login is all that is outstanding."
    exit 78
  elif [ "$blocked" != 0 ]; then
    printf '%s\n' "✗ host access: $blocked blocking issue(s) above — fix them, then re-run 'task up'."
    exit 1
  elif [ "$warned" != 0 ]; then
    printf '%s\n' "⚠ host access: $warned advisory warning(s) above — the bring-up will still run."
    [ "$REPORT" != 1 ] || exit 2
    exit 0
  fi
  printf '%s\n' "✓ host access: every check passed."
  exit 0
}

if [ "${BROKK_SKIP_HOST_CHECK:-}" = 1 ]; then
  printf '%s\n' "· host access check skipped (BROKK_SKIP_HOST_CHECK=1)."
  write_marker
  exit 0
fi

if [ "$(uname -s 2>/dev/null)" = Darwin ]; then
  check_docker
else
  check_groups
  check_libvirt
  check_docker
  check_kvm
fi
finish
