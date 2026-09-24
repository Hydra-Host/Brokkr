#!/usr/bin/env bash
# Reap brokkr-owned devenv-stack process orphans that survive `process-compose down`, so the next
# `task up` is clean. Two classes — both devenv-supervised processes; the simulator FLEET plane
# (ipmi_sim / sushy / socket_vmnet + libvirt domains) is torn down by the engine's `local.fleet
# down`/`nuke`, not here:
#   1. orphaned prod hub/spoke build — a detached `apps/{api,bridge}/dist/main` reparented to PID 1
#      (a prior `pnpm start:prod` / crashed supervisor) squatting :3000/:8000; the EADDRINUSE that
#      blocks preflight.
#   2. a leftover session `virtqemud` — `process-compose down` stops the supervised one; a crashed/
#      orphaned one (or the transient one `fleet nuke`'s virsh calls spawn) is reaped here so it
#      can't hold the socket into the next `task up`. No-op on Linux (system libvirtd, not matched).
#      Gated on no sibling stack's pc.sock answering — the daemon is shared across stacks.
#
# Every mode is contained to this checkout's own hub/spoke worktrees, so a sibling checkout — or an
# unrelated repo whose NestJS build has the same `apps/api/dist/main` path — is never touched.
#
# Shared by stack-down (`task down`) + stack-reset/purge. Three modes:
#   --reap       (default) kill everything matched; exit 0 only if every straggler actually died.
#   --check      report only; exit 1 if any straggler is present.
#   --post-down  used only after a verified pc-daemon exit: drops the pc-ancestry exemption for
#                classes 1/1b (a lingering port-holder is then a mid-shutdown orphan).
#
# Everything below the matchers is behind a `sourced?` guard so the specs can source this file and
# call the real matchers; sourcing must not parse the caller's argv, kill anything, or exit it.

found=0
reaped=0
REAP=1

# Kill a pid reliably: SIGTERM first (lets a well-behaved process clean up), then SIGKILL if it
# ignores it — an orphaned NestJS prod build installs shutdown hooks that catch SIGTERM and hang,
# so a plain `kill` leaves it alive (and still squatting its port). Verify; return 0 iff it died.
kill_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null
  for _ in 1 2 3 4 5; do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  return 1
}

# Count + (in --reap mode) kill a straggler, verifying the kill actually took before claiming it.
reap() { # <pid> <label>
  found=$((found + 1))
  if [ "$REAP" = 0 ]; then
    printf '  ✗ %s (PID %s)\n' "$2" "$1"
    return 0
  fi
  if kill_pid "$1"; then
    reaped=$((reaped + 1))
    printf '  ↻ reaped %s (PID %s)\n' "$2" "$1"
  else
    printf '  ⚠ %s (PID %s) survived SIGKILL — still alive\n' "$2" "$1"
  fi
  return 0
}

# macOS `ps -o comm=` prints the FULL executable path (and, for argv-rewriting daemons like redis,
# appends the process title) where Linux prints the bare name — so every matcher below compares the
# basename. A path-anchored pattern here silently never matches, which turns the pc-ancestry
# exemption into a no-op and makes --reap kill live, supervised processes of sibling stacks.
pc_ancestored() { # <pid> → 0 if any live ancestor is process-compose
  local p="$1" comm
  while [ -n "$p" ] && [ "$p" != "0" ] && [ "$p" != "1" ]; do
    comm="$(ps -o comm= -p "$p" 2>/dev/null | tr -d ' ')" || return 1
    case "${comm##*/}" in process-compose*) return 0 ;; esac
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

proc_binary() { # <pid> → executable basename, empty if unknown
  local c
  c="$(ps -o comm= -p "$1" 2>/dev/null)" || return 1
  c="${c%% *}"
  printf '%s' "${c##*/}"
}

# macOS has no /proc, so the readlink returns nothing there and every path-containment test below
# would vacuously skip its candidate; lsof is the portable read of a live process's cwd. REAP_LSOF
# is the nix-pinned binary the stack-reap wrapper exports — pkgs.lsof is not on the devenv PATH, so
# without the pin this silently no-ops again on a host that has no ambient lsof.
proc_cwd() { # <pid> → resolved cwd, empty if unknown
  local pid="$1" cwd=""
  [ -d /proc ] && cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
  [ -n "$cwd" ] || cwd="$("${REAP_LSOF:-lsof}" -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)"
  printf '%s' "$cwd"
}

# Containment must be identity-based, not prefix-based: this repo nests its git worktrees INSIDE the
# checkout (.worktrees/<slug>, .claude/worktrees/<slug>), so a sibling stack's processes are
# genuinely under repo_root and a bare prefix test reaps them. The path boundary still rules out the
# strict-prefix sibling checkout (.../boss-backup vs .../boss); ownership is then decided by the
# worktree that owns the cwd having to BE the root's own. A root outside git keeps the boundary test
# alone — HUB_REPO_PATH/SPOKE_REPO_PATH may point anywhere in a polyrepo layout.
cwd_owned_by() { # <cwd> <root> → 0 if cwd belongs to root's checkout
  local cwd="$1" root="$2" cwd_top root_top
  [ -n "$cwd" ] || return 1
  case "$cwd/" in "$root/"*) ;; *) return 1 ;; esac
  root_top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || return 0
  cwd_top="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ "$cwd_top" = "$root_top" ]
}

# 1. orphaned prod hub/spoke builds. Match ONLY the node runtime by comm (node | MainThread) to
# exclude shells/greps whose command line merely contains the pattern and the `/bin/sh -c node …`
# wrapper. `apps/(api|bridge)/dist/main` is ordinary NestJS layout that a sibling repo hits too, so
# containment to this checkout's hub/spoke roots applies in every mode. Default/--check additionally
# exempts anything under a live process-compose; --post-down drops that exemption.
reap_orphan_builds() { # <post-down> <hub-root> <spoke-root>
  local post_down="$1" hub_root="$2" spoke_root="$3" pid comm cmd cwd
  for pid in $(pgrep -f 'apps/.*/dist/main' 2>/dev/null); do
    comm="$(ps -o comm= -p "$pid" 2>/dev/null | tr -d ' ')"
    case "$comm" in node | MainThread) ;; *) continue ;; esac
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    printf '%s' "$cmd" | grep -qE 'apps/(api|bridge)/dist/main' || continue
    # an unreadable cwd fails containment: skipping a stranger beats killing one
    cwd="$(proc_cwd "$pid")"
    cwd_owned_by "$cwd" "$hub_root" || cwd_owned_by "$cwd" "$spoke_root" || continue
    if [ "$post_down" != 1 ] && pc_ancestored "$pid"; then
      continue
    fi
    reap "$pid" "orphaned hub/spoke build: $cmd"
  done
}

# A pure string test on values the caller already read. port-guard.sh's classifier hands an
# ours-orphan verdict straight to reap_datastores below, so both must apply the same rule.
datastore_owned_by() { # <cmd> <cwd> <root>
  case "$1 $2" in *"$3/.devenv"*) return 0 ;; esac
  return 1
}

# `pgrep -x` misses these on macOS (the name it matches is the full store path), so select on the
# nix-store path segment and re-confirm by executable basename. Ownership is the cwd: a datastore's
# cwd is its state dir under the owning checkout's .devenv, which is what excludes sibling stacks.
reap_datastores() { # <post-down> <repo-root>
  local post_down="$1" root="$2" name pid cmd cwd
  for name in redis-server postgres; do
    for pid in $(pgrep -f "/bin/$name" 2>/dev/null); do
      [ "$(proc_binary "$pid")" = "$name" ] || continue
      cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
      cwd="$(proc_cwd "$pid")"
      datastore_owned_by "$cmd" "$cwd" "$root" || continue
      [ "$post_down" = 1 ] || { pc_ancestored "$pid" && continue; }
      reap "$pid" "orphaned devenv datastore: $name ($cmd)"
    done
  done
}

# 2. leftover session virtqemud — shared adopt-or-spawn daemon (devenv/lib/virtqemud-wrapper.sh):
# every stack's domains hang off it, so reap only when NO stack's pc.sock answers. --post-down for
# the last stack still reaps: its own socket is already dead by then.
reap_session_virtqemud() {
  local parent sock pid live=0
  parent="$(dirname "${DEVENV_RUNTIME:?DEVENV_RUNTIME unset — run inside the devenv shell}")"
  for sock in "$parent"/devenv-*/pc.sock; do
    [ -S "$sock" ] || continue
    if process-compose -U -u "$sock" process list -o json >/dev/null 2>&1; then
      live=1
      break
    fi
  done
  [ "$live" = 0 ] || return 0
  for pid in $(pgrep -x virtqemud 2>/dev/null); do
    reap "$pid" "leftover session virtqemud"
  done
}

reap_stale_main() { # [mode]
  local mode="${1:---reap}" post_down=0 root hub_root spoke_root
  case "$mode" in
  --reap) ;;
  --check) REAP=0 ;;
  --post-down) post_down=1 ;;
  *)
    echo "reap-stale: unknown mode '$mode' (expected --reap | --check | --post-down)" >&2
    return 2
    ;;
  esac

  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  hub_root="${HUB_REPO_PATH:-$root}"
  spoke_root="${SPOKE_REPO_PATH:-$root}"

  reap_orphan_builds "$post_down" "$hub_root" "$spoke_root"
  reap_datastores "$post_down" "$root"
  reap_session_virtqemud

  if [ "$found" = 0 ]; then
    echo "✓ reap-stale: no brokkr stragglers"
    return 0
  fi
  if [ "$REAP" = 0 ]; then
    echo "✗ reap-stale: $found straggler(s) present — 'task down' (or the next 'task up') will reap them"
    return 1
  fi
  if [ "$reaped" = "$found" ]; then
    echo "✓ reap-stale: reaped $found straggler(s)"
    return 0
  fi
  echo "⚠ reap-stale: reaped $reaped/$found — $((found - reaped)) survived (still alive)"
  return 1
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -u
  reap_stale_main "$@"
  exit $?
fi
