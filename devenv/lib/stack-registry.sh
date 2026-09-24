#!/usr/bin/env bash
# host slot registry: one JSON entry per claimed stack slot (0-46) at
# ${XDG_STATE_HOME:-~/.local/state}/brokkr-local/stacks/stack-N.json. entries tombstone on
# down and are lazily GC'd on every claim (checkout gone, or supervisor pid dead AND pc.sock
# not answering). every locked section runs in a subshell: acquire_hardlink_lock overwrites
# the caller's EXIT trap, so the release must fire at subshell exit — callers must not set
# their own EXIT trap after sourcing this file in the same shell.

. "$(dirname "${BASH_SOURCE[0]}")/with-hardlink-lock.sh"

registry_dir() { printf '%s/brokkr-local/stacks' "${XDG_STATE_HOME:-$HOME/.local/state}"; }

# every slot read from an entry is registry-sourced text until proven numeric —
# validate before it reaches a path/exec/arithmetic sink
assert_slot() {
  case "$1" in '' | *[!0-9]*)
    echo "bad slot: $1" >&2
    return 64
    ;;
  esac
  [ "$1" -le 46 ] || {
    echo "bad slot: $1" >&2
    return 64
  }
}

_registry_entry() { printf '%s/stack-%s.json' "$(registry_dir)" "$1"; }

json_get() { python3 -c 'import json,sys; print(json.loads(sys.stdin.read())[sys.argv[1]])' "$1"; }

_entry_json() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1" "$2"; }

_stack_entry_pid_nl() { # <entry-file> → pcDaemonPid, or 0 when absent
  python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("pcDaemonPid") or 0)' "$1"
}

# Does the entry's supervisor still answer on its socket? A missing socket is a No, so the caller
# that treats a dead pid as reapable does not need its own else-branch.
_stack_entry_socket_answers_nl() { # <entry-file>
  local sock
  sock=$(_entry_json "$1" pcSock 2>/dev/null) || return 1
  [ -S "$sock" ] || return 1
  timeout 5 process-compose -U -u "$sock" process list -o json >/dev/null 2>&1
}

# pid 0 = pre-supervisor window (claim happened, refresh-pid hasn't) — never reap on that alone.
_stack_registry_gc_nl() {
  local f checkout pid
  for f in "$(registry_dir)"/stack-*.json; do
    [ -e "$f" ] || continue
    checkout=$(_entry_json "$f" checkout 2>/dev/null) || continue
    if [ ! -d "$checkout" ]; then
      rm -f "$f"
      continue
    fi
    pid=$(_stack_entry_pid_nl "$f")
    case "$pid" in '' | *[!0-9]*) continue ;; esac
    if [ "$pid" != 0 ] && ! kill -0 "$pid" 2>/dev/null; then
      _stack_entry_socket_answers_nl "$f" || rm -f "$f"
    fi
  done
}

# merge patch into the entry and republish atomically (rename within the same dir)
_stack_registry_update_nl() {
  local slot=$1 patch=$2 staged
  assert_slot "$slot" || return $?
  staged="$(registry_dir)/.update.$$"
  python3 - "$(_registry_entry "$slot")" "$staged" "$patch" <<'EOF'
import json, sys
entry_path, staged, patch = sys.argv[1:4]
try:
    with open(entry_path) as fh:
        data = json.load(fh)
except (OSError, ValueError):
    data = {}
data.update(json.loads(patch))
with open(staged, "w") as fh:
    json.dump(data, fh)
EOF
  mv -f "$staged" "$(_registry_entry "$slot")"
}

_stack_registry_touch_nl() {
  # re-claiming is an up-signal: restore the tombstone state too, or a stack
  # downed via down:others/down:all would read state=down while live forever
  _stack_registry_update_nl "$1" "{\"state\": \"up\", \"lastUpAt\": $(date +%s)}"
}

_stack_registry_mark_down_nl() {
  _stack_registry_update_nl "$1" '{"state": "down"}'
}

_stack_registry_release_nl() {
  assert_slot "$1" || return $?

  rm -f "$(_registry_entry "$1")"
}

_stack_registry_refresh_pid_nl() {
  local slot=$1 pid=$2 ports=${3:-}
  if [ -z "$ports" ]; then
    ports=$(devenv eval ports 2>/dev/null | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["ports"]))' 2>/dev/null || printf '{}')
  fi
  _stack_registry_update_nl "$slot" "$(python3 -c '
import json, sys, time
print(json.dumps({"pcDaemonPid": int(sys.argv[1]), "lastUpAt": int(time.time()),
                  "ports": json.loads(sys.argv[2])}))' "$pid" "$ports")"
}

# an entry nothing was ever brought up on: gc keeps it forever (pid 0 is the pre-supervisor window)
# and stack-reslot refuses to migrate it for want of the applied stamp, so a caller that knows the
# claim was never applied can re-point it instead.
_stack_registry_entry_unused_nl() { # <entry-file>
  local f=$1 pid
  pid=$(_stack_entry_pid_nl "$f")
  # an unreadable pid is not a license to release: refuse what we cannot judge
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  [ "$pid" = 0 ] && return 0
  kill -0 "$pid" 2>/dev/null && return 1
  ! _stack_entry_socket_answers_nl "$f"
}

# owner fast-path: a re-claim naming this checkout refreshes its own entry and returns its
# OWN slot — it never conflicts with itself and never picks a new one.
_stack_registry_claim_nl() {
  local want=$1 checkout=$2 runtime=$3 unapplied=${4:-0} slot f owner staged
  _stack_registry_gc_nl
  for f in "$(registry_dir)"/stack-*.json; do
    [ -e "$f" ] || continue
    owner=$(_entry_json "$f" checkout 2>/dev/null) || continue
    if [ "$owner" = "$checkout" ]; then
      slot=$(_entry_json "$f" slot)
      assert_slot "$slot" || return $?
      if [ "$want" != auto ] && [ "$want" != "$slot" ]; then
        # the drift refusal is right for a stack that came up; for one that never did, it is a
        # dead end — stack-reslot needs the stamp this claim never wrote, so a pinned slot was
        # unreachable and the only escape was deleting the entry by hand.
        if [ "$unapplied" = 1 ] && _stack_registry_entry_unused_nl "$f"; then
          echo "releasing the unused slot-$slot claim (this checkout never came up) → slot $want" >&2
          _stack_registry_release_nl "$slot"
          break
        fi
        echo "this checkout owns slot $slot but requests $want — run task stack:reslot" >&2
        return 3
      fi
      _stack_registry_touch_nl "$slot"
      printf '%s' "$slot"
      return 0
    fi
  done
  if [ "$want" = auto ]; then
    slot=""
    for s in $(seq 0 46); do
      if [ ! -e "$(_registry_entry "$s")" ]; then
        slot=$s
        break
      fi
    done
    if [ -z "$slot" ]; then
      echo "no free slots (0-46 all claimed)" >&2
      return 4
    fi
  else
    slot=$want
    if [ -e "$(_registry_entry "$slot")" ]; then
      owner=$(_entry_json "$(_registry_entry "$slot")" checkout)
      echo "slot $slot already claimed by: $owner" >&2
      return 3
    fi
  fi
  staged="$(registry_dir)/.claim.$$"
  python3 - "$staged" "$slot" "$checkout" "$runtime" <<'EOF'
import json, sys, time
path, slot, checkout, runtime = sys.argv[1:5]
now = int(time.time())
with open(path, "w") as fh:
    json.dump({"slot": int(slot), "checkout": checkout, "devenvRuntime": runtime,
               "pcSock": f"{runtime}/pc.sock", "pcDaemonPid": 0, "state": "up",
               "claimedAt": now, "lastUpAt": now, "ports": {}}, fh)
EOF
  if ! ln "$staged" "$(_registry_entry "$slot")" 2>/dev/null; then
    rm -f "$staged"
    echo "slot $slot claimed concurrently" >&2
    return 3
  fi
  rm -f "$staged"
  printf '%s' "$slot"
}

stack_registry_gc() {
  mkdir -p "$(registry_dir)"
  (
    acquire_hardlink_lock "$(registry_dir)/.lock"
    _stack_registry_gc_nl
  )
}

stack_registry_claim() {
  mkdir -p "$(registry_dir)"
  (
    acquire_hardlink_lock "$(registry_dir)/.lock"
    _stack_registry_claim_nl "$@"
  )
}

stack_registry_touch() {
  mkdir -p "$(registry_dir)"
  (
    acquire_hardlink_lock "$(registry_dir)/.lock"
    _stack_registry_touch_nl "$1"
  )
}

stack_registry_mark_down() {
  mkdir -p "$(registry_dir)"
  (
    acquire_hardlink_lock "$(registry_dir)/.lock"
    _stack_registry_mark_down_nl "$1"
  )
}

stack_registry_release() {
  mkdir -p "$(registry_dir)"
  (
    acquire_hardlink_lock "$(registry_dir)/.lock"
    _stack_registry_release_nl "$1"
  )
}

stack_registry_refresh_pid() {
  mkdir -p "$(registry_dir)"
  (
    acquire_hardlink_lock "$(registry_dir)/.lock"
    _stack_registry_refresh_pid_nl "$@"
  )
}

stack_registry_list() {
  local f
  for f in "$(registry_dir)"/stack-*.json; do
    [ -e "$f" ] || continue
    cat "$f"
    printf '\n'
  done
}

stack_registry_assert_slot() {
  local f
  f=$(_registry_entry "$1")
  [ -e "$f" ] || return 1
  [ "$(_entry_json "$f" checkout 2>/dev/null)" = "$2" ]
}

if [ "${BASH_SOURCE[0]:-}" = "${0:-}" ]; then
  set -eu
  case "${1:-}" in
  gc) stack_registry_gc ;;
  list) stack_registry_list ;;
  claim)
    shift
    stack_registry_claim "$@"
    ;;
  touch)
    shift
    stack_registry_touch "$@"
    ;;
  mark-down)
    shift
    stack_registry_mark_down "$@"
    ;;
  release)
    shift
    stack_registry_release "$@"
    ;;
  assert-slot)
    shift
    stack_registry_assert_slot "$@"
    ;;
  refresh-pid)
    pid=${2:?usage: refresh-pid <pid> [checkout]}
    checkout=${3:-$PWD}
    slot=""
    for f in "$(registry_dir)"/stack-*.json; do
      [ -e "$f" ] || continue
      if [ "$(_entry_json "$f" checkout 2>/dev/null || true)" = "$checkout" ]; then
        slot=$(_entry_json "$f" slot)
        break
      fi
    done
    [ -n "$slot" ] || {
      echo "refresh-pid: no registry entry for $checkout" >&2
      exit 1
    }
    stack_registry_refresh_pid "$slot" "$pid"
    ;;
  *)
    echo "usage: stack-registry.sh {gc|list|claim|touch|mark-down|release|refresh-pid|assert-slot}" >&2
    exit 64
    ;;
  esac
fi
