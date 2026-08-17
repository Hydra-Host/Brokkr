#!/usr/bin/env bash
# shellcheck shell=bash
#
# Serialization + backup/restore for the cases that read or write the real checkout's devenv
# config (devenv.local.nix, stack.slot.nix, the applied-slot stamp).
#
# A case that only evaluates the checkout calls lock_checkout; a case that writes to it calls
# stash_file per path first. teardown always calls restore_checkout. Backups live in
# BATS_TEST_TMPDIR, which is per-case, so a case only ever restores what it itself stashed — a
# teardown can never delete a file some other case owns.
#
# The lock covers the whole checkout rather than one path. A case pinning devenv.local.nix and a
# case pinning stack.slot.nix both change what `devenv eval` resolves, and they share one eval
# cache, so per-path locks would still let them corrupt each other's reads. Keying the lock on the
# checkout root leaves runs in other worktrees lock-free.
#
# Both refusals below are hard failures, never skips — a skip reports the hazard as green.
#
# Requires devenv/lib/bats-helpers.bash to be sourced first (for repo_root).

_checkout_lock_path() {
  local root key
  root="$(repo_root)"
  key="$(printf '%s' "$root" | shasum | cut -c1-16)"
  printf '%s/brokkr-bats-checkout-%s.lock' "${TMPDIR:-/tmp}" "$key"
}

lock_checkout() {
  local dir="$BATS_TEST_TMPDIR/stash"
  mkdir -p "$dir"
  [ -f "$dir/lock" ] && return 0

  # ln-hardlink lock holding the owner's pid, the same portable idiom as
  # devenv/lib/with-hardlink-lock.sh (no flock on darwin) minus its EXIT trap, which would
  # displace bats's own. A killed run therefore cannot wedge the suite: the next run sees a pid
  # that no longer answers kill -0 and steals the lock. Released in restore_checkout.
  local lock mine holder waited=0
  lock="$(_checkout_lock_path)"
  mine="$lock.$$"
  printf '%s\n' "$$" >"$mine"
  until ln "$mine" "$lock" 2>/dev/null; do
    holder="$(cat "$lock" 2>/dev/null || true)"
    if [ -z "$holder" ] || [ "$holder" = "$$" ] || ! kill -0 "$holder" 2>/dev/null; then
      rm -f "$lock" 2>/dev/null || true
    fi
    if [ "$waited" -ge 1800 ]; then
      printf 'refusing to use the checkout: %s held by live pid %s for 900s\n' \
        "$lock" "$holder" >&2
      rm -f "$mine"
      return 1
    fi
    sleep 0.5
    waited=$((waited + 1))
  done
  printf '%s\n%s\n' "$lock" "$mine" >"$dir/lock"
}

stash_file() {
  local target=$1
  # a `>` redirect follows a symlink and truncates the primary checkout's copy
  if [ -L "$target" ]; then
    printf 'refusing to mutate %s: it is a symlink, writing it would truncate the link target\n' \
      "$target" >&2
    return 1
  fi
  lock_checkout || return 1

  local dir="$BATS_TEST_TMPDIR/stash"
  if [ -f "$dir/manifest" ] && grep -qxF "$target" "$dir/manifest"; then
    return 0
  fi
  local slot
  slot="$dir/$(printf '%s' "$target" | tr / _)"
  rm -f "$slot"
  if [ -e "$target" ]; then
    # a failed cp must NOT reach the manifest: restore_checkout treats "manifested but no slot"
    # as "did not exist before" and rm -f's the target, which would delete the very file the
    # stash was taken to protect.
    cp -p "$target" "$slot" || return 1
  fi
  printf '%s\n' "$target" >>"$dir/manifest"
}

restore_checkout() {
  local dir="$BATS_TEST_TMPDIR/stash"
  local target slot
  if [ -f "$dir/manifest" ]; then
    while IFS= read -r target; do
      slot="$dir/$(printf '%s' "$target" | tr / _)"
      if [ -e "$slot" ]; then
        cp -p "$slot" "$target"
      else
        rm -f "$target"
      fi
    done <"$dir/manifest"
    rm -f "$dir/manifest"
  fi
  if [ -f "$dir/lock" ]; then
    local lock mine
    { read -r lock && read -r mine; } <"$dir/lock"
    rm -f "$mine"
    # only drop the lock if we still own it — a run that timed us out for dead now holds it
    if [ "$(cat "$lock" 2>/dev/null || true)" = "$$" ]; then
      rm -f "$lock"
    fi
    rm -f "$dir/lock"
  fi
}
