
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . apps/local-sim/provisioning/linux-bootstrap.sh
  export HOME=/home/dev
}

@test "slot 0 state root yields one rule covering every slot" {
  LOCAL_STATE=/home/dev/.local/share/local run _overlay_rule_glob
  [ "$status" -eq 0 ]
  [ "$output" = '/home/dev/.local/share/local{,-s[0-9],-s[0-9][0-9]}/disks/overlays' ]
}

@test "a slot-suffixed state root yields the same rule as slot 0" {
  LOCAL_STATE=/home/dev/.local/share/local-s7 run _overlay_rule_glob
  slot7=$output
  LOCAL_STATE=/home/dev/.local/share/local run _overlay_rule_glob
  [ "$output" = "$slot7" ]
}

@test "a two-digit slot suffix is stripped" {
  LOCAL_STATE=/home/dev/.local/share/local-s46 run _overlay_rule_glob
  [ "$output" = '/home/dev/.local/share/local{,-s[0-9],-s[0-9][0-9]}/disks/overlays' ]
}

@test "an unset state root falls back to HOME" {
  unset LOCAL_STATE
  run _overlay_rule_glob
  [ "$output" = '/home/dev/.local/share/local{,-s[0-9],-s[0-9][0-9]}/disks/overlays' ]
}

@test "a path whose own name contains -s is left intact" {
  LOCAL_STATE=/home/my-stuff/local run _overlay_rule_glob
  [ "$output" = '/home/my-stuff/local{,-s[0-9],-s[0-9][0-9]}/disks/overlays' ]
}

@test "a custom state root outside HOME is honoured" {
  LOCAL_STATE=/srv/brokkr/state-s3 run _overlay_rule_glob
  [ "$output" = '/srv/brokkr/state{,-s[0-9],-s[0-9][0-9]}/disks/overlays' ]
}
