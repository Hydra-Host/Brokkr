
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
}

@test "a spoke stop signals the whole process group and escalates to sigkill after ten seconds" {
  run env SECRETSPEC_REASON="pin the spoke shutdown block" devenv eval processes.spoke.process-compose.shutdown
  [ "$status" -eq 0 ]
  [[ "$output" == *'"signal": 15'* ]]
  [[ "$output" == *'"timeout_seconds": 10'* ]]
  [[ "$output" == *'"parent_only": false'* ]]
  [[ "$output" != *'"command"'* ]]
}
