setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  LOG="$BATS_TEST_TMPDIR/install.log"
  PHASE="$BATS_TEST_TMPDIR/phase"
  mkdir -p "$PHASE"
}

slice() { # <log-body>
  printf '%s\n' "$1" >"$LOG"
}

explain() { # [mark]
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    LOG_FILE="$1"
    PHASE_DIR="$2"
    STEP_LOG_MARK="$3"
    TARGET_DIR=/home/dev/boss
    explain_step_failure
  ' _ "$LOG" "$PHASE" "${1:-0}"
}

mark_on() { # <file>
  run env BROKKR_INSTALL_LIB=1 sh -c '
    . ./install.sh
    LOG_FILE="$1"
    mark_step_log
    printf "%s\n" "$STEP_LOG_MARK"
  ' _ "$1"
}

@test "the devenv port refusal is translated into a named fault" {
  slice "unpacking sources
error: Error from custom function: Port 5432 is already in use (PID 840). Use --strict-ports=false to auto-allocate an available port.
task: Failed to run task \"up\": exit status 1"
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"port 5432 is already in use (PID 840)"* ]]
  [[ "$output" == *"lsof -nP -iTCP:5432 -sTCP:LISTEN"* ]]
  [[ "$output" == *"task doctor"* ]]
  [[ "$output" == *"Do not pass --strict-ports=false"* ]]
}

@test "a port refusal with no pid still names the port" {
  slice "error: Error from custom function: Port 6379 is already in use."
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"port 6379 is already in use "* ]]
  [[ "$output" != *"(PID "* ]]
}

@test "a preflight refusal is reprinted rather than paraphrased" {
  slice "  ✓ hub checkout: /home/dev/boss
✗ port 5432 (postgres, stack slot 0) is held by another program — PID 840
    /opt/homebrew/opt/postgresql@16/bin/postgres -D /opt/homebrew/var
      1. Stop the other program. It is not part of this stack:
             brew services list"
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"the preflight refused the bring-up"* ]]
  [[ "$output" == *"port 5432 (postgres, stack slot 0)"* ]]
  [[ "$output" == *"brew services list"* ]]
  [[ "$output" != *"hub checkout"* ]]
}

@test "a missing buildx plugin names the three distro installs" {
  slice "docker: 'buildx' is not a docker command.
See 'docker --help'"
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"no buildx plugin"* ]]
  [[ "$output" == *"docker-buildx"* ]]
  [[ "$output" == *"moby-buildx"* ]]
}

@test "an unshared checkout path is explained as a container file-sharing fault" {
  slice "[build-grub] /build.sh: /build.sh: Is a directory
returned non-zero exit status 126"
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"cannot see this checkout from inside its container"* ]]
  [[ "$output" == *"/home/dev/boss"* ]]
}

@test "a full disk is named as a disk fault" {
  slice "building '/nix/store/x.drv'...
error: writing to file: No space left on device"
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"disk filled up"* ]]
  [[ "$output" == *"nix store gc"* ]]
}

@test "an unrecognized failure quotes the step's own error lines" {
  slice "some progress
error: builder for '/nix/store/y.drv' failed with exit code 1
task: Failed to run task \"up\": exit status 1"
  explain
  [ "$status" -eq 0 ]
  [[ "$output" == *"the last errors this step logged"* ]]
  [[ "$output" == *"builder for '/nix/store/y.drv' failed"* ]]
  [[ "$output" == *"Failed to run task"* ]]
}

@test "a failure with no error lines at all says nothing" {
  slice "warming the cache
copying path from the binary cache"
  explain
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "only this step's slice is read" {
  slice "docker: 'buildx' is not a docker command.
more output
error: writing to file: No space left on device"
  explain 2
  [ "$status" -eq 0 ]
  [[ "$output" == *"disk filled up"* ]]
  [[ "$output" != *"buildx"* ]]
}

@test "a run with no log file is a silent no-op" {
  run env BROKKR_INSTALL_LIB=1 sh -c '. ./install.sh; LOG_FILE=""; explain_step_failure'
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "an unreadable log file is a silent no-op" {
  slice "error: something"
  chmod 000 "$LOG"
  explain
  [ "$status" -eq 0 ]
  chmod 644 "$LOG"
}

@test "mark_step_log records the log's line count" {
  printf 'a\nb\nc\nd\ne\n' >"$BATS_TEST_TMPDIR/five"
  mark_on "$BATS_TEST_TMPDIR/five"
  [ "$status" -eq 0 ]
  [ "$output" = 5 ]
}

@test "mark_step_log tolerates a padded wc count" {
  printf 'a\nb\n' >"$BATS_TEST_TMPDIR/two"
  mock_bin wc 'printf "       2\n"'
  mark_on "$BATS_TEST_TMPDIR/two"
  [ "$status" -eq 0 ]
  [ "$output" = 2 ]
}

@test "mark_step_log is zero when there is no log" {
  run env BROKKR_INSTALL_LIB=1 sh -c '. ./install.sh; LOG_FILE=""; mark_step_log; printf "%s\n" "$STEP_LOG_MARK"'
  [ "$status" -eq 0 ]
  [ "$output" = 0 ]
}

@test "both step helpers mark the log" {
  run grep -c '^  mark_step_log$' install.sh
  [ "$output" -eq 2 ]
}

@test "the bring-up and toolchain failures both explain themselves" {
  run grep -c '^\s*explain_step_failure$' install.sh
  [ "$output" -eq 2 ]
}
