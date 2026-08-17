bats_require_minimum_version 1.5.0

setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  export LOCK="$BATS_TEST_TMPDIR/stack.lock"
  export WITNESS="$BATS_TEST_TMPDIR/witness"
}

sidecars() {
  find "$BATS_TEST_TMPDIR" -name 'stack.lock.*'
}

@test "acquisition hardlinks the pid record onto the lock path" {
  run bash -c '. devenv/lib/with-hardlink-lock.sh
acquire_hardlink_lock "$LOCK"
mine=$BASHPID
printf "%s %s %s %s\n" "$(cat "$LOCK")" "$mine" \
  "$(ls -i "$LOCK" | awk "{print \$1}")" "$(ls -i "$LOCK.$mine" | awk "{print \$1}")"'
  [ "$status" -eq 0 ]
  read -r content pid lock_inode record_inode <<<"$output"
  [ "$content" = "$pid" ]
  [ "$lock_inode" = "$record_inode" ]
}

@test "the exit trap releases the lock and its pid record" {
  run bash -c '. devenv/lib/with-hardlink-lock.sh; acquire_hardlink_lock "$LOCK"'
  [ "$status" -eq 0 ]
  [ ! -e "$LOCK" ]
  [ -z "$(sidecars)" ]
}

@test "a live holder blocks a second acquirer" {
  bash -c '. devenv/lib/with-hardlink-lock.sh; acquire_hardlink_lock "$LOCK"; printf held >"$WITNESS"; sleep 30' \
    >/dev/null 2>&1 &
  holder=$!
  await 10 test -s "$WITNESS"
  run timeout 2 bash -c '. devenv/lib/with-hardlink-lock.sh; acquire_hardlink_lock "$LOCK"; printf stole'
  kill "$holder" 2>/dev/null
  wait "$holder" 2>/dev/null || true
  [ "$status" -eq 124 ]
  [ "$output" != stole ]
}

@test "a dead holder's lock is stolen" {
  bash -c '. devenv/lib/with-hardlink-lock.sh; acquire_hardlink_lock "$LOCK"; trap - EXIT'
  [ -e "$LOCK" ]
  run timeout 10 bash -c '. devenv/lib/with-hardlink-lock.sh
acquire_hardlink_lock "$LOCK"
[ "$(cat "$LOCK")" = "$BASHPID" ] && printf stole'
  [ "$status" -eq 0 ]
  [ "$output" = stole ]
}

@test "release spares a lock another holder has taken over" {
  run bash -c '. devenv/lib/with-hardlink-lock.sh; acquire_hardlink_lock "$LOCK"; printf "999999\n" >"$LOCK"'
  [ "$status" -eq 0 ]
  [ -e "$LOCK" ]
  [ "$(cat "$LOCK")" = 999999 ]
  [ -z "$(sidecars)" ]
}

@test "the lock record names the subshell pid, not the top-level shell" {
  run bash -c '. devenv/lib/with-hardlink-lock.sh
( acquire_hardlink_lock "$LOCK"; printf "%s %s %s\n" "$$" "$BASHPID" "$(cat "$LOCK")" )'
  [ "$status" -eq 0 ]
  read -r toplevel subshell content <<<"$output"
  [ "$toplevel" != "$subshell" ]
  [ "$content" = "$subshell" ]
}

@test "a claim from a dead subshell does not block the next claim in the same shell" {
  run --separate-stderr timeout 10 bash -c '. devenv/lib/with-hardlink-lock.sh
( acquire_hardlink_lock "$LOCK"; kill -9 $BASHPID )
acquire_hardlink_lock "$LOCK"
printf second'
  [ "$status" -eq 0 ]
  [ "$output" = second ]
}

@test "the extra cleanup argument runs with the lock release" {
  run bash -c '. devenv/lib/with-hardlink-lock.sh; acquire_hardlink_lock "$LOCK" "printf extra >\"$WITNESS\""'
  [ "$status" -eq 0 ]
  [ ! -e "$LOCK" ]
  [ -z "$(sidecars)" ]
  [ "$(cat "$WITNESS")" = extra ]
}
