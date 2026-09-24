
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  export DEVENV_ROOT="$PWD"
  isolated_state
  WTA=$(mktemp -d); WTB=$(mktemp -d); WTC=$(mktemp -d)
  . devenv/lib/stack-registry.sh
}

teardown() {
  rm -rf "$WTA" "$WTB" "$WTC"
}

@test "auto-claim picks the lowest free slot" {
  run stack_registry_claim auto "$WTA" /tmp/devenv-aaa
  [ "$status" -eq 0 ] && [ "$output" = 0 ]
  run stack_registry_claim auto "$WTB" /tmp/devenv-bbb
  [ "$status" -eq 0 ] && [ "$output" = 1 ]
}

@test "claim is idempotent for the owner" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_claim auto "$WTA" /tmp/devenv-aaa
  [ "$status" -eq 0 ] && [ "$output" = 0 ]
  run stack_registry_claim 0 "$WTA" /tmp/devenv-aaa
  [ "$status" -eq 0 ]
}

@test "owning one slot while requesting another points at reslot" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_claim 3 "$WTA" /tmp/devenv-aaa
  [ "$status" -eq 3 ]
  [[ "$output" == *stack:reslot* ]]
}

@test "configured slot conflict names the owner" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_claim 0 "$WTC" /tmp/devenv-ccc
  [ "$status" -eq 3 ]
  [[ "$output" == *"$WTA"* ]]
}

@test "gc reaps entries whose checkout is gone but keeps live ones" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  stack_registry_claim 5 /nonexistent-wt /tmp/devenv-ddd >/dev/null
  stack_registry_gc
  run stack_registry_list
  [[ "$output" == *'"slot": 0'* || "$output" == *'"slot":0'* ]]
  [[ "$output" != *'"slot": 5'* && "$output" != *'"slot":5'* ]]
}

@test "mark_down keeps a tombstone" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  stack_registry_mark_down 0
  run stack_registry_list
  [[ "$output" == *'"state": "down"'* || "$output" == *'"state":"down"'* ]]
}

@test "slot exhaustion exits 4" {
  reg="$(registry_dir)"
  mkdir -p "$reg"
  for s in $(seq 0 46); do
    registry_entry "$reg/stack-$s.json" "$s" /tmp
  done
  run stack_registry_claim auto "$WTA" /tmp/devenv-aaa
  [ "$status" -eq 4 ]
}

@test "_up does not stop sibling stacks" {
  run bash -c '! grep -q "down:others\|stack-down-others" <(sed -n "/^  _up:/,/^  [a-z]/p" Taskfile.yml)'
  [ "$status" -eq 0 ]
}

@test "local:status prints a STACKS table from the registry" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  run task local:status
  [ "$status" -eq 0 ]
  [[ "$output" == *STACKS* ]]
  [[ "$output" == *"$(basename "$WTA")"* ]]
}

@test "claim against a healthy stack conflicts and names the owner" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  stack_registry_refresh_pid 0 $$ '{}'
  run stack_registry_claim 0 "$WTC" /tmp/devenv-ccc
  [ "$status" -eq 3 ]
  [[ "$output" == *"$WTA"* ]]
}

@test "claim after a simulated reboot reaps the stale entry" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  sh -c 'exit 0' &
  dead=$!
  wait "$dead" || true
  stack_registry_refresh_pid 0 "$dead" '{}'
  run stack_registry_claim 0 "$WTC" /tmp/devenv-ccc
  [ "$status" -eq 0 ] && [ "$output" = 0 ]
}

@test "parallel claims: exactly one winner per slot, no torn entries" {
  for i in 1 2 3 4 5 6; do
    d=$(mktemp -d)
    bash -c '. devenv/lib/stack-registry.sh; stack_registry_claim auto "$1" "$2"' _ "$d" "/tmp/devenv-par-$i" >"$BATS_TEST_TMPDIR/out.$i" 2>"$BATS_TEST_TMPDIR/err.$i" &
  done
  wait
  values=$(for f in "$BATS_TEST_TMPDIR"/out.*; do cat "$f"; echo; done | sort -n | paste -sd, -)
  [ "$values" = "0,1,2,3,4,5" ]
  for f in "$XDG_STATE_HOME"/brokkr-local/stacks/stack-*.json; do
    python3 -m json.tool "$f" >/dev/null
  done
}

@test "deleting a worktree without down frees its slot via gc" {
  stack_registry_claim 0 "$WTA" /tmp/devenv-aaa >/dev/null
  rm -rf "$WTA"
  run stack_registry_claim 0 "$WTC" /tmp/devenv-ccc
  [ "$status" -eq 0 ] && [ "$output" = 0 ]
}

@test "gc asks a live socket before reaping a dead-pid entry" {
  export PROBE_SOCK="$BATS_TEST_TMPDIR/probe.sock"
  reg="$(registry_dir)"
  mkdir -p "$reg"
  registry_entry "$reg/stack-7.json" 7 "$WTA" /tmp/devenv-gc "$PROBE_SOCK" 999999
  unix_socket "$PROBE_SOCK"
  mock_bin process-compose '
[ -S "$PROBE_SOCK" ] && exit 0
exit 1'
  run stack_registry_gc
  [ "$status" -eq 0 ]
  [ -f "$reg/stack-7.json" ]
}

@test "gc reaps a dead-pid entry when the socket is silent" {
  sock="$BATS_TEST_TMPDIR/dead.sock"
  reg="$(registry_dir)"
  mkdir -p "$reg"
  registry_entry "$reg/stack-8.json" 8 "$WTA" /tmp/devenv-gc "$sock" 999999
  unix_socket "$sock"
  mock_bin process-compose 'exit 1'
  run stack_registry_gc
  [ "$status" -eq 0 ]
  [ ! -f "$reg/stack-8.json" ]
}

@test "stack-others report lists siblings with liveness and skips self" {
  sock="$BATS_TEST_TMPDIR/sib.sock"
  reg="$(registry_dir)"
  mkdir -p "$reg"
  registry_entry "$reg/stack-0.json" 0 "$DEVENV_ROOT" /tmp/devenv-self /tmp/self.sock
  registry_entry "$reg/stack-1.json" 1 "$reg/sib" /tmp/devenv-sib "$sock"
  unix_socket "$sock"
  mock_bin process-compose 'echo "[]"'
  run devenv/scripts/stack-others.sh report
  [ "$status" -eq 0 ]
  [[ "$output" == *"slot 1"* ]]
  [[ "$output" == *"live=1"* ]]
  [[ "$output" != *"slot 0"* ]]
}

@test "claim publishes the full entry key set the control center parses" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_list
  [ "$status" -eq 0 ]
  for key in slot checkout devenvRuntime pcSock pcDaemonPid state claimedAt lastUpAt ports; do
    [[ "$output" == *"\"$key\":"* ]]
  done
}

@test "a pinned slot re-points a claim whose bring-up never completed" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  slot=$(stack_registry_claim 4 "$WTA" /tmp/devenv-aaa 1 2>/dev/null)
  [ "$slot" = 4 ]
  [ ! -e "$(registry_dir)/stack-0.json" ]
  [ -e "$(registry_dir)/stack-4.json" ]
}

@test "re-pointing an unused claim says which slot it released" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_claim 4 "$WTA" /tmp/devenv-aaa 1
  [[ "$output" == *"releasing the unused slot-0 claim"* ]]
}

@test "a claim that already came up still refuses a different slot" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_claim 4 "$WTA" /tmp/devenv-aaa 0
  [ "$status" -eq 3 ]
  [[ "$output" == *stack:reslot* ]]
  [ -e "$(registry_dir)/stack-0.json" ]
}

@test "a claim with a live supervisor refuses a different slot even when unapplied" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  stack_registry_refresh_pid 0 "$$" '{}' >/dev/null
  run stack_registry_claim 4 "$WTA" /tmp/devenv-aaa 1
  [ "$status" -eq 3 ]
  [[ "$output" == *stack:reslot* ]]
  [ -e "$(registry_dir)/stack-0.json" ]
}

@test "an unapplied re-point does not disturb another checkout's claim" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  stack_registry_claim auto "$WTB" /tmp/devenv-bbb >/dev/null
  run stack_registry_claim 4 "$WTA" /tmp/devenv-aaa 1
  [ "$status" -eq 0 ]
  [ -e "$(registry_dir)/stack-1.json" ]
  run stack_registry_claim auto "$WTB" /tmp/devenv-bbb
  [ "$output" = 1 ]
}

@test "an entry with an unreadable pid is never treated as unused" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  printf 'not json' >"$(registry_dir)/stack-0.json"
  run _stack_registry_entry_unused_nl "$(registry_dir)/stack-0.json"
  [ "$status" -ne 0 ]
}

@test "an auto claim keeps its own slot even when nothing was ever brought up" {
  stack_registry_claim auto "$WTA" /tmp/devenv-aaa >/dev/null
  run stack_registry_claim auto "$WTA" /tmp/devenv-aaa 1
  [ "$status" -eq 0 ]
  [ "$output" = 0 ]
}
