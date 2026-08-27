#!/usr/bin/env bash
# give a devenv task a tailable log + a machine-readable result: a task is not a process-compose
# process, so pc captures no log for it and a reader (the control center's [init] panes) has nothing
# to follow. Artifacts land in $DEVENV_RUNTIME/processes/logs: <task>.log (stderr merged into stdout)
# and <task>.status (line 1 the exit code — the whole contract; line 2 the bring-up epoch + writing
# pid, diagnostics only). Consumer states: .status newer than the pc socket → 0 completed, non-zero
# failed; absent while the log is newer than the socket → still running; either artifact older than
# the socket, or absent → did not run this bring-up.
#
# Single-flight per task, for correctness of both artifacts: `--mode all` schedules a task in EVERY
# dependent process runner's closure, so a cold bring-up runs the same task once per dependent,
# concurrently — the stampede. Unserialized, N writers interleave the log and race .status. So hold
# a per-task hardlink lock, keyed by checkout (devenv/lib/with-hardlink-lock.sh, portable — no flock
# on darwin), across truncate + body + status write: the first invocation does the work and the
# queued ones no-op through their own skip guards. The wait is unbounded while the holder is alive
# (a cold build takes many minutes) — hence the checkout key, or a concurrent stack's same-named
# task would block this one indefinitely — but a dead holder is detected via `kill -0` and its lock
# stolen, so it cannot deadlock.
#
# The per-up epoch is the pc socket's mtime (rebound fresh by every `devenv up`), NOT a per-runner
# marker: the first runner exits before the queued ones run, so nothing it owns survives for them to
# test. Truncating only a log that predates this up gives one reset per bring-up — the first pass
# streams, the queued repeats append. .status is scoped the same way, and within one epoch a write
# never replaces a 0 with a non-zero: serializing the writers does not stop a late one that did no
# work from clobbering a finished success (`fleet:init` has no skip guard, so every repeat runs its
# body in full, and the more invocations queue behind a slow holder the likelier that is).
#
# usage: . with-task-log.sh; begin_task_log <task-name>
# Do NOT take another hardlink lock and do NOT install your own EXIT trap afterwards (both would
# drop this one's release), and do NOT `exec` a command — the trap must fire to write .status.
. "${BASH_SOURCE[0]%/*}/with-hardlink-lock.sh"

begin_task_log() {
  local dir="${DEVENV_RUNTIME:-${TMPDIR:-/tmp}}/processes/logs"
  local log="$dir/$1.log"
  # globals like the lock helper's $lock: the EXIT trap resolves them by name when it fires.
  task_status_file="$dir/$1.status"
  task_status_socket="${PC_SOCKET_PATH:-${DEVENV_RUNTIME:-}/pc.sock}"
  mkdir -p "$dir"
  acquire_hardlink_lock \
    "${TMPDIR:-/tmp}/brokkr-task-log-$1-$(printf '%s' "${DEVENV_ROOT:-$PWD}" | cksum | cut -d' ' -f1).lock"
  # same epoch scope as the log: a previous bring-up's result must never read as this run's, but a
  # result this bring-up already recorded must survive the queued invocations behind it.
  if [ ! -e "$task_status_socket" ] || [ "$task_status_file" -ot "$task_status_socket" ]; then
    rm -f "$task_status_file"
  fi
  if [ ! -e "$task_status_socket" ] || [ ! -e "$log" ] || [ "$log" -ot "$task_status_socket" ]; then
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
  local prior=''
  if [ -e "$task_status_socket" ] && [ ! "$task_status_file" -ot "$task_status_socket" ]; then
    prior="$(head -n 1 "$task_status_file" 2>/dev/null)"
  fi
  # a queued invocation that did no work must not turn this bring-up's success into a failure; a
  # first failure is still overwritable, so a genuine second one lands.
  if [ "$prior" = 0 ] && [ "$1" != 0 ]; then
    return 0
  fi
  local tmp="$task_status_file.$BASHPID.tmp"
  # line 1 is the whole consumer contract (the exit code); line 2 only names the writer.
  printf '%s\n%s %s\n' "$1" "$(_task_status_epoch)" "$BASHPID" >"$tmp" &&
    mv -f "$tmp" "$task_status_file" ||
    rm -f "$tmp"
}

# the bring-up this result belongs to, independent of the file's own mtime: GNU stat, then BSD.
_task_status_epoch() {
  stat -c %Y "$task_status_socket" 2>/dev/null ||
    stat -f %m "$task_status_socket" 2>/dev/null ||
    printf 'none'
}
