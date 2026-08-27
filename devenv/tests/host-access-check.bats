
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  isolated_state
  SCRIPT=devenv/scripts/host-access-check.sh
  export DEVENV_STATE="$BATS_TEST_TMPDIR/devenv-state"
  export CALLS="$BATS_TEST_TMPDIR/calls.log"
  mkdir -p "$DEVENV_STATE"
  : >"$CALLS"
  export BROKK_KVM_DEVICE="$BATS_TEST_TMPDIR/dev-kvm"
  export BROKK_HOST_CHECK_QEMU_CONF="$BATS_TEST_TMPDIR/qemu.conf"
  : >"$BROKK_KVM_DEVICE"
  printf 'user = "qemu"\n' >"$BROKK_HOST_CHECK_QEMU_CONF"
  export BROKK_FLEET_AUTOSTART=true
  export FAKE_UID=1000 FAKE_USER=dev
  export FAKE_DB_GROUPS="dev libvirt kvm docker"
  export FAKE_LIVE_GROUPS="dev libvirt kvm docker"
  export FAKE_HOST_GROUPS="libvirt kvm docker"
  export FAKE_QEMU_USER=qemu FAKE_QEMU_GROUPS="qemu kvm"
  export FAKE_KVM_MODE=660 FAKE_KVM_OWNER=root FAKE_KVM_GROUP=kvm
  export FAKE_UNAME=Linux
  export FAKE_SYSTEMCTL_RC=0
  export FAKE_VIRSH_RC=0 FAKE_VIRSH_ERR=""
  export FAKE_DOCKER_RC=0 FAKE_DOCKER_ERR="" FAKE_BUILDX_RC=0
  stub_host
}

stub_host() {
  mock_bin id '
case "$1" in
-u) echo "${FAKE_UID:-1000}" ;;
-un) echo "${FAKE_USER:-dev}" ;;
-nG)
  if [ -n "${2:-}" ]; then
    if [ "$2" = "${FAKE_QEMU_USER:-}" ]; then printf "%s\n" "${FAKE_QEMU_GROUPS:-}"
    else printf "%s\n" "${FAKE_DB_GROUPS:-}"; fi
  else printf "%s\n" "${FAKE_LIVE_GROUPS:-}"; fi ;;
*) exit 1 ;;
esac'
  mock_bin getent '
echo "getent $*" >>"$CALLS"
[ "$1" = group ] || exit 2
for g in ${FAKE_HOST_GROUPS:-}; do
  [ "$g" = "$2" ] && exit 0
done
exit 2'
  mock_bin uname 'echo "${FAKE_UNAME:-Linux}"'
  mock_bin systemctl '
echo "systemctl $*" >>"$CALLS"
exit "${FAKE_SYSTEMCTL_RC:-0}"'
  mock_bin virsh '
echo "virsh $*" >>"$CALLS"
[ -z "${FAKE_VIRSH_ERR:-}" ] || echo "$FAKE_VIRSH_ERR" >&2
exit "${FAKE_VIRSH_RC:-0}"'
  mock_bin docker '
echo "docker $*" >>"$CALLS"
case "$1" in
buildx) exit "${FAKE_BUILDX_RC:-0}" ;;
esac
[ -z "${FAKE_DOCKER_SLEEP:-}" ] || exec sleep "$FAKE_DOCKER_SLEEP"
[ -z "${FAKE_DOCKER_ERR:-}" ] || echo "$FAKE_DOCKER_ERR" >&2
exit "${FAKE_DOCKER_RC:-0}"'
  mock_bin stat '
echo "stat $*" >>"$CALLS"
printf "%s %s %s\n" "${FAKE_KVM_MODE:-660}" "${FAKE_KVM_OWNER:-root}" "${FAKE_KVM_GROUP:-kvm}"'
}

hide_docker() {
  local kept="" d
  rm -f "$BATS_TEST_TMPDIR/mock-bin/docker"
  local IFS=:
  for d in $PATH; do
    [ -x "$d/docker" ] && continue
    kept="$kept:$d"
  done
  export PATH="${kept#:}"
}

no_tty_run() {
  python3 -c 'import os, sys
pid = os.fork()
if pid == 0:
    os.setsid()
    try:
        os.execvp(sys.argv[1], sys.argv[1:])
    finally:
        os._exit(127)
_, st = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(st))' "$@"
}

marker_field() {
  python3 -c 'import json, sys; print(json.dumps(json.load(open(sys.argv[1]))[sys.argv[2]]))' \
    "$DEVENV_STATE/host-access.json" "$1"
}

first_finding() {
  python3 -c 'import json, sys
f = json.load(open(sys.argv[1]))["findings"][0]
print(f["probe"], f["severity"], bool(f["title"]), bool(f["fix"]))' \
    "$DEVENV_STATE/host-access.json"
}

finding_fix_line() {
  python3 -c 'import json, sys
f = [x for x in json.load(open(sys.argv[1]))["findings"] if x["probe"] == sys.argv[2]][0]
print(f["fix"].splitlines()[int(sys.argv[3])])' \
    "$DEVENV_STATE/host-access.json" "$1" "$2"
}

@test "every blocker being a stale group is a checkpoint: exit 78, re-login named, no usermod" {
  export FAKE_LIVE_GROUPS="dev"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 78 ]
  [[ "$output" == *"new group membership is not active in this session"* ]]
  [[ "$output" == *"log out and back in"* ]]
  [[ "$output" == *"nothing failed"* ]]
  [[ "$output" != *"usermod"* ]]
  [[ "$output" != *"blocking issue(s)"* ]]
}

@test "the stale groups collapse into one finding that names every pending group once" {
  export FAKE_LIVE_GROUPS="dev"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 78 ]
  [[ "$output" == *"not active in this session: libvirt, kvm, docker"* ]]
  [ "$(printf '%s\n' "$output" | grep -c "log out and back in (or reboot)")" -eq 1 ]
  [ "$(printf '%s\n' "$output" | grep -c "BROKK_SKIP_HOST_CHECK=1")" -eq 1 ]
  [ "$(marker_field blocked)" -eq 1 ]
}

@test "a real blocker alongside stale groups still exits 1" {
  export FAKE_DB_GROUPS="dev kvm docker"
  export FAKE_LIVE_GROUPS="dev docker"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 1 ]
  [[ "$output" == *"not a member of 'libvirt'"* ]]
  [[ "$output" == *"not active in this session: kvm"* ]]
  [[ "$output" == *"✗ host access: 2 blocking issue(s)"* ]]
}

@test "a group never added names sudo usermod and never claims the user was added" {
  export FAKE_DB_GROUPS="dev kvm docker"
  export FAKE_LIVE_GROUPS="dev kvm docker"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 1 ]
  [[ "$output" == *"not a member of 'libvirt'"* ]]
  [[ "$output" == *"sudo usermod -aG libvirt dev"* ]]
  [[ "$output" != *"added"* ]]
}

@test "a group absent from the host prints a skip line and produces no finding" {
  export FAKE_HOST_GROUPS="libvirt kvm"
  export FAKE_DB_GROUPS="dev libvirt kvm"
  export FAKE_LIVE_GROUPS="dev libvirt kvm"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 0 ]
  [[ "$output" == *"· no 'docker' group on this host"* ]]
  [[ "$output" != *"not a member of 'docker'"* ]]
  [[ "$output" != *"'docker' membership is not active"* ]]
}

@test "a fully ready linux host reports only passes" {
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ host access: every check passed."* ]]
  [[ "$output" != *"⚠"* ]]
  [[ "$output" != *"✗"* ]]
}

@test "libvirtd active plus a permission-denied virsh names permission, not a stopped daemon" {
  export FAKE_VIRSH_RC=1 FAKE_VIRSH_ERR="error: Failed to connect socket: Permission denied"
  export FAKE_SYSTEMCTL_RC=0
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 0 ]
  [[ "$output" == *"permission denied on qemu:///system"* ]]
  [[ "$output" != *"systemctl"* ]]
  [[ "$output" != *"libvirtd is not running"* ]]
}

@test "libvirtd genuinely down warns and does not block" {
  export FAKE_VIRSH_RC=1 FAKE_VIRSH_ERR="error: failed to connect to the hypervisor"
  export FAKE_SYSTEMCTL_RC=3
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [[ "$output" == *"⚠ libvirtd is not running"* ]]
  [[ "$output" == *"sudo systemctl enable --now libvirtd"* ]]
}

@test "a missing buildx plugin warns, names type=local, and exits zero" {
  export FAKE_BUILDX_RC=1
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"⚠ docker buildx plugin missing"* ]]
  [[ "$output" == *"type=local"* ]]
}

@test "a missing docker on linux warns" {
  hide_docker
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [[ "$output" == *"⚠ docker not found"* ]]
}

@test "darwin skips the group, libvirt and kvm probes" {
  export FAKE_UNAME=Darwin
  export FAKE_LIVE_GROUPS="dev"
  rm -f "$BROKK_KVM_DEVICE"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 0 ]
  [[ "$output" != *"membership"* ]]
  [[ "$output" != *"libvirt"* ]]
  [[ "$output" != *"TCG"* ]]
  run grep -c virsh "$CALLS"
  [ "$output" = "0" ]
}

@test "BROKK_SKIP_HOST_CHECK short-circuits stale groups too: zero, one line, no probe" {
  export BROKK_SKIP_HOST_CHECK=1
  export FAKE_LIVE_GROUPS="dev"
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ "${#lines[@]}" -eq 1 ]
  [[ "$output" == *"BROKK_SKIP_HOST_CHECK"* ]]
  [ ! -s "$CALLS" ]
}

@test "--report returns 2 for warnings, 1 for a blocker and 78 for stale groups alone" {
  export FAKE_BUILDX_RC=1
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  export FAKE_DB_GROUPS="dev kvm docker"
  export FAKE_LIVE_GROUPS="dev kvm docker"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 1 ]
  export FAKE_DB_GROUPS="dev libvirt kvm docker"
  export FAKE_LIVE_GROUPS="dev"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 78 ]
}

@test "BROKK_FLEET_AUTOSTART=false downgrades not-a-member and leaves stale groups a checkpoint" {
  export BROKK_FLEET_AUTOSTART=false
  export FAKE_DB_GROUPS="dev kvm docker"
  export FAKE_LIVE_GROUPS="dev kvm docker"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [[ "$output" == *"⚠ not a member of 'libvirt'"* ]]

  export FAKE_DB_GROUPS="dev libvirt kvm docker"
  export FAKE_LIVE_GROUPS="dev libvirt docker"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 78 ]
  [[ "$output" == *"✗ new group membership is not active in this session: kvm"* ]]
}

@test "a uid of zero skips the group block entirely" {
  export FAKE_UID=0
  export FAKE_LIVE_GROUPS="dev"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 0 ]
  [[ "$output" != *"membership"* ]]
  [[ "$output" != *"not a member"* ]]
  run grep -c "^getent" "$CALLS"
  [ "$output" = "0" ]
}

@test "no controlling terminal downgrades every blocker to a warning and exits zero" {
  export FAKE_LIVE_GROUPS="dev"
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [[ "$output" == *"⚠ new group membership is not active in this session: libvirt, kvm, docker"* ]]
  [[ "$output" != *"✗"* ]]
  [[ "$output" == *"no terminal to stop on"* ]]
}

@test "a controlling terminal keeps the finding and exits 78 for stale groups" {
  export FAKE_LIVE_GROUPS="dev"
  run pty_run bash -c 'bash "$0"; echo "HOSTCHECK_RC=$?"' "$SCRIPT"
  [[ "$output" == *"host access:"* ]] || skip "harness ran no host check"
  [[ "$output" != *"no terminal to stop on"* ]] || skip "harness gave no controlling terminal"
  [[ "$output" == *"HOSTCHECK_RC=78"* ]]
  [[ "$output" == *"✗ new group membership is not active in this session: libvirt, kvm, docker"* ]]
  [[ "$output" == *"BROKK_SKIP_HOST_CHECK=1"* ]]
}

@test "a controlling terminal keeps a real blocker at exit one" {
  export FAKE_DB_GROUPS="dev kvm docker"
  export FAKE_LIVE_GROUPS="dev kvm docker"
  run pty_run bash -c 'bash "$0"; echo "HOSTCHECK_RC=$?"' "$SCRIPT"
  [[ "$output" == *"host access:"* ]] || skip "harness ran no host check"
  [[ "$output" != *"no terminal to stop on"* ]] || skip "harness gave no controlling terminal"
  [[ "$output" == *"HOSTCHECK_RC=1"* ]]
  [[ "$output" == *"✗ host access: 1 blocking issue(s)"* ]]
}

@test "an absent /dev/kvm names the guest cpu type and the power cycle" {
  rm -f "$BROKK_KVM_DEVICE"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [[ "$output" == *"Cause 1: the guest has no /dev/kvm."* ]]
  [[ "$output" == *"On Proxmox, set the guest CPU type to 'host'."* ]]
  [[ "$output" == *"Power the guest off, then on. A reset does not add CPU flags."* ]]
  [[ "$output" == *"To force one backend, set LOCAL_ACCEL to kvm, tcg, or hvf."* ]]
}

@test "an unreachable /dev/kvm names the group even when the suite runs as root" {
  export FAKE_QEMU_GROUPS="qemu"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [[ "$output" == *"Cause 2: /dev/kvm exists, but the libvirt qemu user cannot read and write it."* ]]
  [[ "$output" == *"Add that user to the group that owns /dev/kvm."* ]]

  export FAKE_UID=0
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [[ "$output" == *"Cause 2: /dev/kvm exists, but the libvirt qemu user cannot read and write it."* ]]
}

@test "a commented-out user key resolves to the distro default, not root" {
  printf '#user = "libvirt-qemu"\n' >"$BROKK_HOST_CHECK_QEMU_CONF"
  export FAKE_QEMU_USER=libvirt-qemu FAKE_QEMU_GROUPS="libvirt-qemu kvm"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 0 ]
  [[ "$output" == *"qemu user 'libvirt-qemu'"* ]]
  [[ "$output" != *"qemu user 'root'"* ]]
}

@test "an uncommented user key still wins over the commented default" {
  printf '#user = "libvirt-qemu"\nuser = "qemu"\n' >"$BROKK_HOST_CHECK_QEMU_CONF"
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 0 ]
  [[ "$output" == *"qemu user 'qemu'"* ]]
  [[ "$output" != *"qemu user 'libvirt-qemu'"* ]]
}

@test "a tabbed virsh stderr still yields a parseable marker" {
  export FAKE_VIRSH_RC=1
  export FAKE_VIRSH_ERR="$(printf 'error: failed to connect\n\tcontinuation\rcr\x0cff')"
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  run python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$DEVENV_STATE/host-access.json"
  [ "$status" -eq 0 ]
}

@test "the marker file is written on every path, including the skip path" {
  export FAKE_LIVE_GROUPS="dev"
  rm -f "$BROKK_KVM_DEVICE"
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$DEVENV_STATE/host-access.json" ]
  [ "$(marker_field hadTty)" = "false" ]
  [ "$(marker_field blocked)" -ge 1 ]
  [ "$(marker_field warned)" -ge 1 ]
  [ "$(marker_field checkedAt)" -gt 0 ]
  [ "$(first_finding)" = "groups block True True" ]
  [ "$(finding_fix_line kvm -1)" = "To force one backend, set LOCAL_ACCEL to kvm, tcg, or hvf." ]
  [ "$(finding_fix_line kvm 7)" = "  Run 'grep -c -E \" (vmx|svm) \" /proc/cpuinfo'. A zero means the CPU type is wrong." ]

  rm -f "$DEVENV_STATE/host-access.json"
  export BROKK_SKIP_HOST_CHECK=1
  run no_tty_run bash "$SCRIPT"
  [ "$status" -eq 0 ]
  [ -f "$DEVENV_STATE/host-access.json" ]
  [ "$(marker_field blocked)" -eq 0 ]
}

@test "a docker probe that sleeps past the bound does not hang the script" {
  export FAKE_DOCKER_SLEEP=20
  export BROKK_HOST_CHECK_TIMEOUT=1
  local started=$SECONDS
  run no_tty_run bash "$SCRIPT" --report
  [ "$status" -eq 2 ]
  [ $((SECONDS - started)) -lt 10 ]
  [[ "$output" == *"docker"* ]]
}
