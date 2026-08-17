
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  ROOT="$PWD"
  RUNTIME="$BATS_TEST_TMPDIR/runtime"
  LOCKS="$BATS_TEST_TMPDIR/locks"
  CHECKOUT="$BATS_TEST_TMPDIR/checkout"
  LOGS="$RUNTIME/processes/logs"
  SOCK="$RUNTIME/pc.sock"
  mkdir -p "$RUNTIME" "$LOCKS" "$CHECKOUT"
}

task_env() {
  env -u PC_SOCKET_PATH DEVENV_RUNTIME="$RUNTIME" TMPDIR="$LOCKS" DEVENV_ROOT="$CHECKOUT" "$@"
}

task_log() { # <task> <body>
  run task_env bash -c '. "$1/devenv/lib/with-task-log.sh"; begin_task_log "$2"; shift 2; eval "$@"' \
    _ "$ROOT" "$@"
}

line_count() { # <file> <n>
  [ -f "$1" ] && [ "$(wc -l < "$1")" -eq "$2" ]
}

lock_path() { # <devenv-root> <cwd>
  local out="$BATS_TEST_TMPDIR/lockpath"
  (
    cd "$2" || exit 1
    env -u PC_SOCKET_PATH DEVENV_RUNTIME="$RUNTIME" TMPDIR="$LOCKS" DEVENV_ROOT="$1" \
      bash -c '. "$1/devenv/lib/with-task-log.sh"; begin_task_log keyed; printf "%s\n" "$lock" >"$2"' \
      _ "$ROOT" "$out"
  ) >/dev/null 2>&1
  cat "$out"
}

@test "the log and status land under the runtime processes dir" {
  task_log demo 'printf "hello\n"'
  [ "$status" -eq 0 ]
  [ -f "$LOGS/demo.status" ]
  await 10 grep -q hello "$LOGS/demo.log"
}

@test "a failing task's exit code reaches the status file" {
  task_log demo 'printf "boom\n"; exit 7'
  [ "$status" -eq 7 ]
  [ "$(cat "$LOGS/demo.status")" = 7 ]
}

@test "a succeeding task records zero and replaces the previous result" {
  mkdir -p "$LOGS"
  printf '9\n' > "$LOGS/demo.status"
  task_log demo 'printf "ok\n"'
  [ "$status" -eq 0 ]
  [ "$(cat "$LOGS/demo.status")" = 0 ]
}

@test "a concurrent stampede is serialized, not interleaved" {
  witness="$BATS_TEST_TMPDIR/witness"
  unix_socket "$SOCK"
  for i in 1 2 3 4 5; do
    task_env bash -c '. "$1/devenv/lib/with-task-log.sh"
begin_task_log stampede
printf "in-%s\n" "$2" >>"$3"
printf "in-%s\n" "$2"
sleep 0.3
printf "out-%s\n" "$2" >>"$3"
printf "out-%s\n" "$2"' _ "$ROOT" "$i" "$witness" > /dev/null 2>&1 &
  done
  wait
  run awk 'NR % 2 == 1 { if ($0 !~ /^in-/) exit 1; id = substr($0, 4) }
NR % 2 == 0 { if ($0 != "out-" id) exit 1 }
END { exit NR == 10 ? 0 : 1 }' "$witness"
  [ "$status" -eq 0 ]
  await 10 line_count "$LOGS/stampede.log" 10
}

@test "a log predating this bring-up is truncated once" {
  mkdir -p "$LOGS"
  unix_socket "$SOCK"
  printf 'previous\n' > "$LOGS/demo.log"
  touch -t 200001010000 "$LOGS/demo.log"
  task_log demo 'printf "fresh\n"'
  [ "$status" -eq 0 ]
  await 10 grep -q fresh "$LOGS/demo.log"
  ! grep -q previous "$LOGS/demo.log"
}

@test "a log from this bring-up is appended to, not truncated" {
  mkdir -p "$LOGS"
  unix_socket "$SOCK"
  touch -t 200001010000 "$SOCK"
  printf 'earlier\n' > "$LOGS/demo.log"
  task_log demo 'printf "later\n"'
  [ "$status" -eq 0 ]
  await 10 grep -q later "$LOGS/demo.log"
  grep -q earlier "$LOGS/demo.log"
}

@test "the lock key separates two checkouts" {
  a=$(lock_path "$BATS_TEST_TMPDIR/checkout-a" "$ROOT")
  b=$(lock_path "$BATS_TEST_TMPDIR/checkout-b" "$ROOT")
  [ -n "$a" ]
  [ "$a" != "$b" ]
}

@test "the lock key ignores the working directory one checkout is invoked from" {
  mkdir -p "$BATS_TEST_TMPDIR/elsewhere"
  a=$(lock_path "$BATS_TEST_TMPDIR/checkout-a" "$ROOT")
  b=$(lock_path "$BATS_TEST_TMPDIR/checkout-a" "$BATS_TEST_TMPDIR/elsewhere")
  [ -n "$a" ]
  [ "$a" = "$b" ]
}
