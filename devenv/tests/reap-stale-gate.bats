
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  TMP=$(mktemp -d)
  export DEVENV_RUNTIME="$TMP/devenv-self" REAPLOG="$TMP/reaped"
  mkdir -p "$DEVENV_RUNTIME" "$TMP/devenv-sib-live" "$TMP/devenv-sib-dead"
  unix_socket "$TMP/devenv-sib-live/pc.sock"
  unix_socket "$TMP/devenv-sib-dead/pc.sock"
  touch "$TMP/devenv-self/pc.sock"
  mock_bin process-compose '
case "$*" in
*sib-live*process\ list*) exit 0 ;;
*) exit 1 ;;
esac'

  OWN="$TMP/own"
  SIB="$TMP/sib"
  REDIS=/nix/store/aaaaaaaa-redis-7.2.11/bin/redis-server
  PG=/nix/store/bbbbbbbb-postgresql-16.10/bin/postgres
  PC=/nix/store/cccccccc-process-compose-1.64.1/bin/process-compose
  cat > "$TMP/proctable" <<EOF
999101|$REDIS 127.0.0.1:20515|1|$REDIS 127.0.0.1:20515|$OWN/.devenv/state/redis
999102|$REDIS 127.0.0.1:6379|999900|$REDIS 127.0.0.1:6379|$OWN/.devenv/state/redis
999103|$PG|1|$PG|$SIB/.devenv/state/postgres
999104|/nix/store/dddddddd-bash-5.2/bin/bash|1|/bin/sh -c $REDIS --port 1|$OWN/.devenv/state/redis
999900|$PC|1|$PC -f process-compose.yaml|$OWN
999201|node|1|node $OWN/apps/api/dist/main|$OWN/apps/api
999202|node|1|node $OWN/.worktrees/sibling/apps/api/dist/main|$OWN/.worktrees/sibling/apps/api
4242|virtqemud|1|virtqemud --timeout 0|
EOF
  proc_table "$TMP/proctable"
}

make_nested_worktree() {
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
  git init -q -b main "$OWN"
  git -C "$OWN" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init
  git -C "$OWN" worktree add -q --detach "$OWN/.worktrees/sibling"
  mkdir -p "$OWN/apps/api" "$OWN/.worktrees/sibling/apps/api"
}

teardown() {
  rm -rf "$TMP"
}

reaper() { # <function> [args...]
  run bash -c '. devenv/lib/reap-stale.sh; "$@"' _ "$@"
}

reaper_logging() { # <function> [args...]
  run env REAPLOG="$REAPLOG" \
    bash -c '. devenv/lib/reap-stale.sh; reap() { printf "%s\n" "$1" >>"$REAPLOG"; }; "$@"' _ "$@"
}

run_daemon_gate() {
  reaper_logging reap_session_virtqemud
}

run_datastore_gate() { # <post-down>
  reaper_logging reap_datastores "$1" "$OWN"
}

run_orphan_gate() { # <post-down>
  reaper_logging reap_orphan_builds "$1" "$OWN" "$OWN"
}

@test "sourcing the reaper does not parse argv, reap, or exit the caller" {
  run bash -c '. devenv/lib/reap-stale.sh --bogus; printf alive'
  [ "$status" -eq 0 ]
  [ "$output" = alive ]
}

@test "live sibling stack spares the shared daemon" {
  run_daemon_gate
  [ "$status" -eq 0 ]
  [ ! -f "$REAPLOG" ]
}

@test "no live sibling reaps the shared daemon" {
  rm -rf "$TMP/devenv-sib-live"
  run_daemon_gate
  [ "$status" -eq 0 ]
  [ "$(cat "$REAPLOG")" = 4242 ]
}

@test "non-socket pc.sock entries are not treated as live" {
  rm "$TMP/devenv-sib-live/pc.sock"
  touch "$TMP/devenv-sib-live/pc.sock"
  run_daemon_gate
  [ "$status" -eq 0 ]
  [ "$(cat "$REAPLOG")" = 4242 ]
}

@test "supervisor exemption matches a full-path process-compose ancestor" {
  reaper pc_ancestored 999102
  [ "$status" -eq 0 ]
}

@test "supervisor exemption declines a pid reparented to init" {
  reaper pc_ancestored 999101
  [ "$status" -eq 1 ]
}

@test "proc_cwd resolves a cwd without /proc" {
  reaper proc_cwd 999101
  [ "$status" -eq 0 ]
  [ "$output" = "$OWN/.devenv/state/redis" ]
}

@test "proc_cwd prefers the nix-pinned lsof over the ambient one" {
  printf '#!/bin/sh\necho n/pinned/cwd\n' > "$TMP/pinned-lsof"
  chmod +x "$TMP/pinned-lsof"
  export REAP_LSOF="$TMP/pinned-lsof"
  reaper proc_cwd 999999
  [ "$status" -eq 0 ]
  [ "$output" = /pinned/cwd ]
}

@test "the stack-reap wrapper exports the pinned lsof" {
  run grep -F 'export REAP_LSOF="${pkgs.lsof}/bin/lsof"' devenv.nix
  [ "$status" -eq 0 ]
}

@test "proc_cwd yields nothing for an unknown pid" {
  reaper proc_cwd 999999
  [ "$status" -eq 0 ]
  [ -z "$output" ]
}

@test "proc_binary strips the store path and the process title" {
  reaper proc_binary 999101
  [ "$status" -eq 0 ]
  [ "$output" = redis-server ]
}

@test "cwd_owned_by declines a strict-prefix sibling checkout" {
  reaper cwd_owned_by "$TMP/own-backup/apps/api" "$OWN"
  [ "$status" -eq 1 ]
}

@test "datastore matcher reaps this checkout's orphan only" {
  run_datastore_gate 0
  [ "$status" -eq 0 ]
  [ "$(cat "$REAPLOG")" = 999101 ]
}

@test "post-down datastore matcher drops the supervisor exemption but keeps containment" {
  run_datastore_gate 1
  [ "$status" -eq 0 ]
  [ "$(cat "$REAPLOG")" = "999101
999102" ]
}

@test "post-down containment spares a nested worktree stack's hub build" {
  make_nested_worktree
  run_orphan_gate 1
  [ "$status" -eq 0 ]
  [ "$(cat "$REAPLOG")" = 999201 ]
}

@test "reap_stale_main reports no stragglers and exits 0" {
  run bash -c '
    . devenv/lib/reap-stale.sh
    reap_orphan_builds() { :; }
    reap_datastores() { :; }
    reap_session_virtqemud() { :; }
    reap_stale_main
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"no brokkr stragglers"* ]]
}

@test "reap_stale_main --check reports the straggler, exits 1, and kills nothing" {
  run bash -c '
    . devenv/lib/reap-stale.sh
    kill_pid() { echo "KILLED"; return 0; }
    reap_orphan_builds() { reap 999999 "fake straggler"; }
    reap_datastores() { :; }
    reap_session_virtqemud() { :; }
    reap_stale_main --check
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"straggler(s) present"* ]]
  [[ "$output" != *KILLED* ]]
}

@test "reap_stale_main reaps every straggler and exits 0" {
  run bash -c '
    . devenv/lib/reap-stale.sh
    kill_pid() { return 0; }
    reap_orphan_builds() { reap 999999 "fake straggler"; }
    reap_datastores() { :; }
    reap_session_virtqemud() { :; }
    reap_stale_main
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"reaped 1 straggler"* ]]
}

@test "reap_stale_main exits 1 when a straggler survives the kill" {
  run bash -c '
    . devenv/lib/reap-stale.sh
    kill_pid() { return 1; }
    reap_orphan_builds() { reap 999999 "fake straggler"; }
    reap_datastores() { :; }
    reap_session_virtqemud() { :; }
    reap_stale_main
  '
  [ "$status" -eq 1 ]
  [[ "$output" == *"reaped 0/1"* ]]
}

@test "reap_stale_main rejects an unknown mode with exit 2" {
  run bash -c '. devenv/lib/reap-stale.sh; reap_stale_main --bogus'
  [ "$status" -eq 2 ]
  [[ "$output" == *"unknown mode"* ]]
}
