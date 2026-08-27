setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  FIXTURE="$BATS_TEST_TMPDIR/checkout"
  PHASE="$BATS_TEST_TMPDIR/phase"
  export PC_JSON="$BATS_TEST_TMPDIR/pc.json"
  export PC_SOCKET_PATH="$BATS_TEST_TMPDIR/pc.sock"
  mkdir -p "$FIXTURE" "$PHASE"
  unix_socket "$PC_SOCKET_PATH"
  mock_bin devenv 'shift 3; exec "$@"'
  mock_bin process-compose 'case " $* " in *" process "*) exec cat "$PC_JSON" ;; *) exit 1 ;; esac'
}

pc_state() { # <json>
  printf '%s\n' "$1" >"$PC_JSON"
}

run_verify() {
  run env BROKKR_INSTALL_LIB=1 bash -c '
    . ./install.sh
    PHASE_DIR="$1"
    TARGET_DIR="$2"
    HAVE_TTY=0
    verify_stack_ready
  ' _ "$PHASE" "$FIXTURE"
}

@test "a stack whose processes are all healthy verifies clean" {
  pc_state '[{"name":"hub-api","status":"Running","is_ready":"Ready","exit_code":0,"restarts":0},
             {"name":"hub:migrate","status":"Completed","is_ready":"-","exit_code":0,"restarts":0}]'
  run_verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"every supervised process is healthy"* ]]
}

@test "a failed one-shot task fails the verification and is named with its exit code" {
  pc_state '[{"name":"hub-api","status":"Running","is_ready":"Ready","exit_code":0,"restarts":0},
             {"name":"hub:init","status":"Completed","is_ready":"-","exit_code":1,"restarts":0}]'
  run_verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"the stack came up but processes failed"* ]]
  [[ "$output" == *"hub:init (status=Completed exit=1 restarts=0)"* ]]
  [[ "$output" == *"task status"* ]]
}

@test "a crash-looped process in Error is reported with its restart count" {
  pc_state '[{"name":"spoke","status":"Error","is_ready":"Not Ready","exit_code":1,"restarts":5}]'
  run_verify
  [ "$status" -ne 0 ]
  [[ "$output" == *"spoke (status=Error exit=1 restarts=5)"* ]]
}

@test "a process still starting is not reported as a failure" {
  pc_state '[{"name":"hub-api","status":"Pending","is_ready":"-","exit_code":0,"restarts":0},
             {"name":"spoke","status":"Running","is_ready":"Not Ready","exit_code":0,"restarts":1}]'
  run_verify
  [ "$status" -eq 0 ]
}

@test "a running process that carries a stale exit code from an earlier restart is healthy" {
  pc_state '[{"name":"spoke","status":"Running","is_ready":"Ready","exit_code":1,"restarts":5},
             {"name":"fleet","status":"Running","is_ready":"Not Ready","exit_code":1,"restarts":5},
             {"name":"postgres","status":"Running","is_ready":"Ready","exit_code":0,"restarts":0}]'
  run_verify
  [ "$status" -eq 0 ]
}

@test "a live process with many restarts is not failed here, unlike proc-health.ts" {
  pc_state '[{"name":"fleet","status":"Running","is_ready":"Not Ready","exit_code":0,"restarts":5},
             {"name":"postgres","status":"Running","is_ready":"Ready","exit_code":0,"restarts":0}]'
  run_verify
  [ "$status" -eq 0 ]
}

@test "a stop-signal exit code is not read as a crash" {
  pc_state '[{"name":"hub-web","status":"Completed","is_ready":"-","exit_code":143,"restarts":0}]'
  run_verify
  [ "$status" -eq 0 ]
}

@test "an unreachable process-compose socket warns without failing the run" {
  pc_state '[]'
  rm -f "$PC_SOCKET_PATH"
  run_verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"could not verify the stack"* ]]
}

@test "unparseable process-compose output warns without failing the run" {
  pc_state 'not json'
  run_verify
  [ "$status" -eq 0 ]
  [[ "$output" == *"could not verify the stack"* ]]
}

@test "the stack bring-up's own output reaches the install log" {
  run env BROKKR_INSTALL_LIB=1 bash -c '
    . ./install.sh
    LOG_FILE="$1"
    : >"$LOG_FILE"
    printf "hub:init failed\n" | tee_stack_log
    cat "$LOG_FILE"
  ' _ "$BATS_TEST_TMPDIR/install.log"
  [ "$status" -eq 0 ]
  [ "$(grep -c 'hub:init failed' <<<"$output")" -eq 2 ]
}

@test "read_rc reports failure when the command never recorded a status" {
  run env BROKKR_INSTALL_LIB=1 bash -c '
    . ./install.sh
    : >"$1"
    printf "%s " "$(read_rc "$1")"
    printf "7\n" >"$1"
    printf "%s\n" "$(read_rc "$1")"
  ' _ "$BATS_TEST_TMPDIR/rc"
  [ "$status" -eq 0 ]
  [ "$output" = "1 7" ]
}
