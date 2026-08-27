#!/usr/bin/env bash
# body behind the `brokkr-pnpm-install` devenv script (devenv.nix wires the name to this file).
# Runs in $PWD; callers (hub:init/spoke:init/apps:init) cd into the target repo first.
set -uo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

_fix_pty() { find node_modules -path '*/node-pty/prebuilds/*/spawn-helper' -exec chmod +x {} + 2>/dev/null || true; }

# only ever purge at a real pnpm workspace root (defense-in-depth for the rm -rf below)
if [ ! -f package.json ] || [ ! -f pnpm-lock.yaml ]; then
  echo ">> brokkr-pnpm-install: $PWD is not a pnpm workspace root; running plain install" >&2
  exec pnpm install "$@"
fi

# Refuse a version skew rather than install through it: pnpm 8 against a v9 lockfile does not
# fail, it re-resolves and writes back a v6 one with every override silently dropped.
want_pnpm="$(node -p "require('./package.json').packageManager.split('@')[1].split('+')[0]" 2>/dev/null || true)"
have_pnpm="$(pnpm --version 2>/dev/null || true)"
if [ -n "$want_pnpm" ] && [ -n "$have_pnpm" ] && [ "$want_pnpm" != "$have_pnpm" ]; then
  echo ">> brokkr-pnpm-install: this checkout pins pnpm $want_pnpm, your shell has $have_pnpm." >&2
  echo "   Run 'direnv reload' (or re-enter the devenv shell), then retry." >&2
  exit 1
fi

# shellcheck source=devenv/lib/with-hardlink-lock.sh
. "$repo_root/devenv/lib/with-hardlink-lock.sh"
acquire_hardlink_lock \
  "${TMPDIR:-/tmp}/brokkr-pnpm-install-$(printf '%s' "$PWD" | cksum | cut -d' ' -f1).lock" \
  '[ -n "${log:-}" ] && rm -f "$log"'
log=""

# the lockfile mtime alone misses a newly added/edited workspace member, so also
# invalidate the skip when any workspace package.json is newer than .modules.yaml.
newer_pkg=""
if [ -e node_modules/.modules.yaml ]; then
  newer_pkg=$(find apps packages -maxdepth 3 -name package.json \
    -not -path '*/node_modules/*' -newer node_modules/.modules.yaml -print -quit 2>/dev/null || true)
fi
# an interrupted install leaves .modules.yaml fresh over an unlinked tree, so the mtime alone is
# not evidence the install finished — a linked binary is.
if [ -e node_modules/.modules.yaml ] &&
  [ node_modules/.modules.yaml -nt pnpm-lock.yaml ] &&
  [ -x node_modules/.bin/turbo ] &&
  [ -z "$newer_pkg" ]; then
  echo ">> brokkr-pnpm-install: node_modules up-to-date; skipping install" >&2
  _fix_pty
  exit 0
fi

log="$(mktemp)"
_run_install() {
  pnpm install "$@" 2>&1 | tee "$log"
  return "${PIPESTATUS[0]}"
}

if _run_install "$@"; then
  _fix_pty
  exit 0
fi

# MISSING_HOISTED_LOCATIONS was added after an observed pnpm 8 -> 11 upgrade: a node_modules
# left by the previous major fails with it, and pnpm's own advice is exactly this purge.
if grep -qiE 'ENOTEMPTY|EEXIST|reinstalled from scratch|not compatible|MISSING_HOISTED_LOCATIONS|gyp ERR! build error|\.o\.d\.raw' "$log"; then
  echo ">> brokkr-pnpm-install: incompatible/stale node_modules detected; purging this repo's node_modules and reinstalling once…" >&2
  # a partial purge leaves .modules.yaml behind, and the retry then no-ops ("Already up to date")
  # while reporting success — so a purge that fails must stop the run, not be retried through.
  if ! find . -type d -name node_modules -prune -exec rm -rf {} +; then
    echo ">> brokkr-pnpm-install: could not purge node_modules — remove it by hand, then retry" >&2
    exit 1
  fi
  _run_install "$@"
  rc="$?"
  [ "$rc" -eq 0 ] && _fix_pty
  exit "$rc"
fi
exit 1
