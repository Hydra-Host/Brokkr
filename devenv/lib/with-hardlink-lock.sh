#!/usr/bin/env bash
# exclusive cross-process lock via ln-hardlink (portable — no flock on darwin): steals the lock
# from a dead holder (kill -0 probe) and releases it via an EXIT trap; an optional extra cleanup
# command ($2) is appended to that trap.
#
# acquire_hardlink_lock installs (and overwrites) the shell's EXIT trap, so put any extra cleanup
# in $2 — do NOT set your own `trap ... EXIT` afterwards, it would drop the lock release. at most
# one lock per shell: a second call overwrites the first's trap (and the global $lock/$lockmine,
# which the trap references by name at EXIT-time, so they can't be function-local like $holder/$release).
# usage: . with-hardlink-lock.sh; acquire_hardlink_lock <lock-path> [extra-exit-cleanup]
acquire_hardlink_lock() {
  # $$ is the TOP-LEVEL shell's pid even inside (…) subshells — two sequential claims from
  # one long-lived shell (e.g. the claim + a later mutator in one script) collide on it and
  # the holder never dies. $BASHPID is per-(sub)shell, so the record dies with the holder.
  lock="$1"
  lockmine="$lock.$BASHPID"
  printf '%s\n' "$BASHPID" >"$lockmine"
  local release='rm -f "$lockmine"; [ "$(cat "$lock" 2>/dev/null || true)" = "$BASHPID" ] && rm -f "$lock" 2>/dev/null'
  # SC2064: expanding now is deliberate — $release is single-quote-authored, so its
  # variables (and any in $2) still expand when the trap fires (its value is baked into the trap
  # string here, so $release itself is not referenced at EXIT and is safe to keep function-local).
  # shellcheck disable=SC2064
  trap "$release${2:+; $2}" EXIT
  local holder
  while ! ln "$lockmine" "$lock" 2>/dev/null; do
    holder=$(cat "$lock" 2>/dev/null || true)
    if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
      sleep 1
    else
      rm -f "$lock" 2>/dev/null || true
    fi
  done
}
