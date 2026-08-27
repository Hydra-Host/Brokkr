setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  task_test_setup
}

code() { # <task>
  head -n 1 "$LOGS/$1.status"
}

inode() { # <path>
  ls -i "$1" | awk '{print $1}'
}

@test "a queued invocation exiting non-zero leaves this bring-up's recorded success" {
  unix_socket "$SOCK"
  task_log demo 'printf "did the work\n"'
  [ "$status" -eq 0 ]
  [ "$(code demo)" = 0 ]

  task_log demo 'exit 1'
  [ "$status" -eq 1 ]
  [ "$(code demo)" = 0 ]
}

@test "a failure with no recorded success in this bring-up lands its own code" {
  unix_socket "$SOCK"
  task_log demo 'printf "boom\n"; exit 5'
  [ "$status" -eq 5 ]
  [ "$(code demo)" = 5 ]
}

@test "the second of two failures replaces the first" {
  unix_socket "$SOCK"
  task_log demo 'exit 3'
  [ "$(code demo)" = 3 ]

  task_log demo 'exit 4'
  [ "$(code demo)" = 4 ]
}

@test "a success may still replace a failure recorded earlier in this bring-up" {
  unix_socket "$SOCK"
  task_log demo 'exit 3'
  [ "$(code demo)" = 3 ]

  task_log demo 'printf "retry worked\n"'
  [ "$(code demo)" = 0 ]
}

@test "a result predating this bring-up is gone before the body runs" {
  mkdir -p "$LOGS"
  printf '0\n' >"$LOGS/demo.status"
  touch -t 200001010000 "$LOGS/demo.status"
  unix_socket "$SOCK"

  task_log demo "[ ! -e '$LOGS/demo.status' ]"
  [ "$status" -eq 0 ]
}

@test "a result predating this bring-up never suppresses a failure" {
  mkdir -p "$LOGS"
  printf '0\n' >"$LOGS/demo.status"
  touch -t 200001010000 "$LOGS/demo.status"
  unix_socket "$SOCK"

  task_log demo 'exit 6'
  [ "$(code demo)" = 6 ]
}

@test "with no socket to date artifacts against every run replaces the result" {
  task_log demo 'printf "ok\n"'
  [ "$(code demo)" = 0 ]

  task_log demo 'exit 2'
  [ "$(code demo)" = 2 ]
}

@test "the result is renamed into place, so no reader sees a truncated file" {
  unix_socket "$SOCK"
  task_log demo 'exit 3'
  before=$(inode "$LOGS/demo.status")

  task_log demo 'printf "ok\n"'
  [ "$(code demo)" = 0 ]
  [ "$before" != "$(inode "$LOGS/demo.status")" ]
  ! ls "$LOGS"/*.tmp >/dev/null 2>&1
}

@test "the result names the writer without disturbing line one" {
  unix_socket "$SOCK"
  task_log demo 'exit 4'

  [ "$(code demo)" = 4 ]
  [ "$(wc -l <"$LOGS/demo.status")" -eq 2 ]
  run sed -n 2p "$LOGS/demo.status"
  [[ $output =~ ^[0-9]+[[:space:]][0-9]+$ ]]
}

@test "the log still appends within one bring-up while the result is preserved" {
  unix_socket "$SOCK"
  task_log demo 'printf "first\n"'
  task_log demo 'printf "second\n"; exit 1'

  await 10 grep -q second "$LOGS/demo.log"
  grep -q first "$LOGS/demo.log"
  [ "$(code demo)" = 0 ]
}

@test "a log predating this bring-up is still truncated once" {
  mkdir -p "$LOGS"
  unix_socket "$SOCK"
  printf 'previous\n' >"$LOGS/demo.log"
  touch -t 200001010000 "$LOGS/demo.log"

  task_log demo 'printf "fresh\n"'
  await 10 grep -q fresh "$LOGS/demo.log"
  ! grep -q previous "$LOGS/demo.log"
}
