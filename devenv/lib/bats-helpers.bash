#!/usr/bin/env bash
# shellcheck shell=bash
#
# Shared scaffolding for the devenv bats suites under devenv/tests.
#
# It lives here rather than beside the specs because the review rules classify every path under a
# tests/ root as a spec that must carry no comments at all — not even a shellcheck pragma. A helper
# this indirect is unreadable under that rule; a spec does not need it.
#
# Every spec's setup() cds to the repo root before sourcing this, so the source line is written
# `. devenv/lib/bats-helpers.bash` and stays correct however deeply the spec itself is nested.

# The suites sit at two different depths under devenv/tests, so anything sourced by them has to
# find the root by search rather than by a fixed number of `..` hops.
repo_root() {
  local dir=$BATS_TEST_DIRNAME
  while [ "$dir" != / ]; do
    if [ -f "$dir/devenv.nix" ]; then
      printf '%s\n' "$dir"
      return 0
    fi
    dir=$(dirname "$dir")
  done
  printf 'bats-helpers: no devenv.nix above %s\n' "$BATS_TEST_DIRNAME" >&2
  return 1
}

# Put an executable stub on PATH for the duration of one case. The shebang is printf'd instead of
# being carried in the caller's heredoc because a column-0 '#' inside a spec reads as a comment to
# the review rules, which bar comments in specs outright.
mock_bin() { # <name> <body>
  local dir="$BATS_TEST_TMPDIR/mock-bin" target
  mkdir -p "$dir"
  target="$dir/$1"
  printf '#!/usr/bin/env bash\n' >"$target"
  printf '%s\n' "$2" >>"$target"
  chmod +x "$target"
  case ":$PATH:" in
  *":$dir:"*) ;;
  *) export PATH="$dir:$PATH" ;;
  esac
}

# Point the stack registry at a private state root. bats removes BATS_TEST_TMPDIR after each case,
# so no teardown is needed — and nothing here can reach the developer's real registry.
isolated_state() {
  export XDG_STATE_HOME="$BATS_TEST_TMPDIR/state"
  mkdir -p "$XDG_STATE_HOME"
}

# Poll a predicate to a deadline. For the artifacts a helper writes through a `tee` in a process
# substitution: the shell under test exits before that child flushes, so an immediate read races it.
await() { # <seconds> <predicate...>
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ "$SECONDS" -lt "$deadline" ] || return 1
    sleep 0.05
  done
}

# Bind and abandon a unix socket: the filesystem entry outlives the process, which is exactly what
# the pc.sock liveness probes test for.
unix_socket() { # <path>
  python3 -c 'import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])' "$1"
}

# A registry entry written straight to disk, for the states the claim helpers refuse to produce:
# a slot already taken by someone else, a dead supervisor pid, a full 47-slot table.
registry_entry() { # <path> <slot> <checkout> [runtime] [pc-sock] [pc-daemon-pid]
  printf '{"slot": %s, "checkout": "%s", "devenvRuntime": "%s", "pcSock": "%s", "pcDaemonPid": %s, "state": "up", "claimedAt": 1, "lastUpAt": 1, "ports": {}}\n' \
    "$2" "$3" "${4:-/tmp/devenv-x}" "${5:-/tmp/x.sock}" "${6:-0}" >"$1"
}

# ps/pgrep/lsof driven by a fake process table, one pipe-separated record per line:
#   <pid>|<comm>|<ppid>|<command>|<cwd>
# Those four views are the entire process surface the reap matchers read. comm records carry the
# full store path and, for argv-rewriting daemons, the process title — that is what darwin's real
# `ps -o comm=` prints, and half the matchers exist to survive it.
proc_table() { # <path>
  export PROCTABLE=$1
  local pgrep_stub ps_stub lsof_stub
  pgrep_stub=$(
    cat <<'STUB'
case "$1" in
-x)
  awk -F'|' -v name="$2" '{ c = $2; sub(/^.*\//, "", c); if (c == name) { print $1; hit = 1 } } END { exit hit ? 0 : 1 }' "$PROCTABLE"
  ;;
-f)
  awk -F'|' -v pat="$2" '$4 ~ pat { print $1; hit = 1 } END { exit hit ? 0 : 1 }' "$PROCTABLE"
  ;;
*)
  exit 1
  ;;
esac
STUB
  )
  ps_stub=$(
    cat <<'STUB'
awk -F'|' -v pid="$4" -v field="$2" '$1 == pid {
  if (field == "comm=") print $2
  else if (field == "ppid=") print $3
  else if (field == "command=") print $4
  hit = 1
} END { exit hit ? 0 : 1 }' "$PROCTABLE"
STUB
  )
  lsof_stub=$(
    cat <<'STUB'
awk -F'|' -v pid="$3" '$1 == pid && $5 != "" { print "p" $1; print "n" $5; hit = 1 } END { exit hit ? 0 : 1 }' "$PROCTABLE"
STUB
  )
  mock_bin pgrep "$pgrep_stub"
  mock_bin ps "$ps_stub"
  mock_bin lsof "$lsof_stub"
}

# util-linux's script only accepts a command via `-c <string>` (a trailing `-- cmd` is rejected
# with "unexpected number of arguments", despite what its SYNOPSIS suggests); BSD's takes the
# command positionally and has no `-c`. No single spelling works on both, so probe rather than
# guess — the container tier runs under GNU, developers run under BSD. printf %q re-quotes argv
# into the single string `-c` wants, which the backslash form keeps safe under dash.
pty_run() { # <cmd> [args...]
  if script --version 2>/dev/null | grep -q util-linux; then
    local cmd
    cmd=$(printf '%q ' "$@")
    script -q -c "$cmd" /dev/null
  else
    script -q /dev/null "$@"
  fi
}

# with-task-log.sh's specs all need the same sandbox: a fake runtime dir, a lock dir TMPDIR points
# at, and a checkout the lock key hashes. Shared so a second spec file cannot drift from the first.
task_test_setup() {
  ROOT="$PWD"
  RUNTIME="$BATS_TEST_TMPDIR/runtime"
  LOCKS="$BATS_TEST_TMPDIR/locks"
  CHECKOUT="$BATS_TEST_TMPDIR/checkout"
  # shellcheck disable=SC2034
  LOGS="$RUNTIME/processes/logs"
  # shellcheck disable=SC2034
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

# Print `<task>|<before,...>|<after,...>` for every task in the built graph, one line each. Those
# edges are what decides which tasks devenv schedules under a given root, which is the whole
# subject of the shell-entry spec. It goes through task.config rather than reading the attribute
# directly because `devenv eval` splits an attribute path on `.` while every task name carries
# colons, so `tasks."devenv:enterTest".after` is unaddressable. `build`, not `eval`: eval returns
# the store path without realizing it, so a garbage collection between runs leaves it missing.
devenv_task_edges() {
  local path
  path=$(devenv build task.config |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["task.config"])') || return 1
  python3 -c '
import json, sys
for t in json.load(open(sys.argv[1])):
    print("|".join([t["name"], ",".join(t.get("before") or []), ",".join(t.get("after") or [])]))
' "$path"
}
