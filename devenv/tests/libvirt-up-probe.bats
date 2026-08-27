
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  PROBE=apps/local-sim/scripts/tasks/stack-libvirt-up.sh
  export CALLS="$BATS_TEST_TMPDIR/calls"
  export LOCAL_SIM_PRIV_BIN=/usr/local/bin/local-sim-priv
  mock_bin uname 'echo Linux'
}

@test "an active unit with a refused socket reports permission, not a stopped daemon" {
  mock_bin systemctl 'exit 0'
  mock_bin virsh 'echo "error: failed to connect to the hypervisor" >&2
echo "error: Failed to connect socket to /var/run/libvirt/libvirt-sock: Permission denied" >&2
exit 1'
  run bash "$PROBE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"Permission denied"* ]]
  [[ "$output" != *"✓ system libvirtd active"* ]]
}

@test "an active unit with a non-permission virsh failure reports unreachable" {
  mock_bin systemctl 'exit 0'
  mock_bin virsh 'echo "error: no route to host" >&2
exit 1'
  run bash "$PROBE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"active but qemu:///system is unreachable"* ]]
  [[ "$output" == *"no route to host"* ]]
  [[ "$output" != *"✓ system libvirtd active"* ]]
  [ ! -s "$CALLS" ] || [[ "$(cat "$CALLS")" != *"svc-start"* ]]
}

@test "a reachable libvirt reports active" {
  mock_bin systemctl 'exit 1'
  mock_bin virsh 'exit 0'
  run bash "$PROBE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ system libvirtd active"* ]]
}

@test "a stopped daemon is started through the privileged helper" {
  mock_bin systemctl 'exit 3'
  mock_bin virsh 'if [ -f "$CALLS" ]; then exit 0; fi
exit 1'
  mock_bin sudo 'shift
printf "%s\n" "$*" >>"$CALLS"'
  run bash "$PROBE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"✓ libvirtd started"* ]]
  run cat "$CALLS"
  [[ "$output" == *"svc-start libvirtd"* ]]
}

@test "a daemon that will not start exits with the start hint" {
  mock_bin systemctl 'exit 3'
  mock_bin virsh 'exit 1'
  mock_bin sudo 'exit 1'
  run bash "$PROBE"
  [ "$status" -eq 1 ]
  [[ "$output" == *"sudo systemctl start libvirtd"* ]]
}

@test "macos skips the probe without calling virsh" {
  mock_bin uname 'echo Darwin'
  mock_bin virsh 'printf "called\n" >>"$CALLS"
exit 0'
  run bash "$PROBE"
  [ "$status" -eq 0 ]
  [[ "$output" == *"(skip)"* ]]
  [ ! -f "$CALLS" ]
}
