#!/usr/bin/env bash
# give a devenv task a tailable log + a machine-readable result: a task is not a process-compose
# process, so pc captures no log for it and a reader (the control center's [init] panes) has nothing
# to follow. Artifacts land in $DEVENV_RUNTIME/processes/logs: <task>.log (stderr merged into stdout)
# and <task>.status (the exit code). Consumer states: .status present → 0 completed, non-zero failed;
# absent while the log is newer than the pc socket → still running; log older than the socket, or
# absent → did not run this bring-up.
#
# Single-flight per task, for correctness of both artifacts: `--mode all` schedules a task in EVERY
# dependent process runner's closure, so a cold bring-up runs the same task once per dependent,
# concurrently — the stampede. Unserialized, N writers interleave the log and race .status (last
# writer wins, so a failing pass can overwrite a success). So hold a per-task hardlink lock, keyed
# by checkout (devenv/lib/with-hardlink-lock.sh, portable — no flock on darwin), across truncate +
# body + status write: the first invocation does the work and the queued ones no-op through their
# own skip guards. The wait is unbounded while the holder is alive (a cold build takes many
# minutes) — hence the checkout key, or a concurrent stack's same-named task would block this one
# indefinitely — but a dead holder is detected via `kill -0` and its lock stolen, so it cannot
# deadlock.
#
# The per-up epoch is the pc socket's mtime (rebound fresh by every `devenv up`), NOT a per-runner
# marker: the first runner exits before the queued ones run, so nothing it owns survives for them to
# test. Truncating only a log that predates this up gives one reset per bring-up — the first pass
# streams, the queued repeats append.
#
# usage: . with-task-log.sh; begin_task_log <task-name>
# Do NOT take another hardlink lock and do NOT install your own EXIT trap afterwards (both would
# drop this one's release), and do NOT `exec` a command — the trap must fire to write .status.
. "${BASH_SOURCE[0]%/*}/with-hardlink-lock.sh"

begin_task_log() {
  local dir="${DEVENV_RUNTIME:-${TMPDIR:-/tmp}}/processes/logs"
  local log="$dir/$1.log"
  local pcsock="${PC_SOCKET_PATH:-${DEVENV_RUNTIME:-}/pc.sock}"
  # global like the lock helper's $lock: the EXIT trap resolves it by name when it fires.
  task_status_file="$dir/$1.status"
  mkdir -p "$dir"
  acquire_hardlink_lock \
    "${TMPDIR:-/tmp}/brokkr-task-log-$1-$(printf '%s' "${DEVENV_ROOT:-$PWD}" | cksum | cut -d' ' -f1).lock"
  # never let the previous bring-up's result read as this run's — an in-progress run has no .status.
  rm -f "$task_status_file"
  if [ ! -e "$pcsock" ] || [ ! -e "$log" ] || [ "$log" -ot "$pcsock" ]; then
    : >"$log"
  fi
  local prev
  prev="$(trap -p EXIT)"
  # $? must be read first, so our write fronts the lock's release ("trap -- 'body' EXIT", already
  # correctly quoted by bash, so it re-parses verbatim after the concatenation).
  if [ -n "$prev" ]; then
    eval "trap '_write_task_status \$?; '${prev#trap -- }"
  else
    trap '_write_task_status $?' EXIT
  fi
  # ONE tee (stderr merged in) — two appends to one file would split merged lines. The task's own
  # stdout still shows its output. tee runs in a process-sub child the shell never waits on, and the
  # EXIT trap is output-independent, so it still fires promptly.
  exec > >(tee -a "$log") 2>&1
}

_write_task_status() {
  printf '%s\n' "$1" >"$task_status_file"
}
