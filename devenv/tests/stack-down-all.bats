
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  export DEVENV_ROOT="$PWD" LOCAL_SIM_PRIV_BIN="$BATS_TEST_TMPDIR/sim-priv"
  isolated_state
  export MOCKLOG="$BATS_TEST_TMPDIR/mocklog"
  mock_bin process-compose '
echo "process-compose $*" >> "$MOCKLOG"
case "$*" in *live*process\ list*) exit 0 ;; *process\ list*) exit 1 ;; esac
exit 0'
  mock_bin task 'echo "task $*" >> "$MOCKLOG"'
  mock_bin sudo '
echo "sudo $*" >> "$MOCKLOG"
case "$*" in
"-n $LOCAL_SIM_PRIV_BIN noop") exit 0 ;;
-n*) exit 1 ;;
esac
exit 0'
  . devenv/lib/stack-registry.sh
}

teardown() {
  if [ -n "${WTLIVE:-}" ]; then
    rm -rf "$WTLIVE"
  fi
}

@test "down-all downs siblings via their sockets before downing self" {
  stack_registry_claim 0 "$PWD" /tmp/devenv-self >/dev/null
  WTLIVE=$(mktemp -d)
  stack_registry_claim 1 "$WTLIVE" "$WTLIVE/devenv-live-b" >/dev/null
  bash devenv/scripts/stack-down-all.sh
  run grep -n 'devenv-live-b/pc.sock down' "$MOCKLOG"
  [ "$status" -eq 0 ]
  sibling_line=$(echo "$output" | head -1 | cut -d: -f1)
  run grep -n 'task down' "$MOCKLOG"
  [ "$status" -eq 0 ]
  self_line=$(echo "$output" | head -1 | cut -d: -f1)
  [ "$sibling_line" -lt "$self_line" ]
}

@test "down-all tombstones siblings in the registry" {
  stack_registry_claim 0 "$PWD" /tmp/devenv-self >/dev/null
  WTLIVE=$(mktemp -d)
  stack_registry_claim 1 "$WTLIVE" "$WTLIVE/devenv-live-b" >/dev/null
  bash devenv/scripts/stack-down-all.sh
  run stack_registry_list
  [[ "$output" == *'"down"'* ]]
}

@test "down-all gates the bootptab sweep on the helper, not on an allowlisted command" {
  stack_registry_claim 0 "$PWD" /tmp/devenv-self >/dev/null
  bash devenv/scripts/stack-down-all.sh
  run grep -F "sudo -n $LOCAL_SIM_PRIV_BIN noop" "$MOCKLOG"
  [ "$status" -eq 0 ]
  run grep -F "sudo $LOCAL_SIM_PRIV_BIN bootptab-section-remove brokkr-slot-0" "$MOCKLOG"
  [ "$status" -eq 0 ]
  run grep -F 'sudo -n true' "$MOCKLOG"
  [ "$status" -ne 0 ]
}
