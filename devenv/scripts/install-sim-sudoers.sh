#!/usr/bin/env bash
# Install the scoped NOPASSWD sudoers drop-in for passwordless sim sudo (idempotent; reversible
# via `task sudo:teardown`). Single source of truth, called by both the devenv `sudo:setup` task
# (modules/sudo.nix) and the `task up` / `task sudo:setup` Taskfile verbs.
#
# The privileged `sudo install` must run in a foreground, terminal-attached shell. Under
# `devenv tasks run` the prompt has no usable tty/stdin on Linux (and there's no Touch-ID
# fallback like macOS), which is why `task up` died with "sudo: 3 incorrect password attempts"
# on Arch. The Taskfile verbs run this script directly so the single prompt is reliable on both
# macOS and Linux; the no-op guard below keeps re-runs silent.
#
# The sudoers *content* is generated declaratively by devenv (`files` in modules/sudo.nix) at
# $DEVENV_ROOT/.sudoers/brokkr-sim with a __USER__ placeholder — this only renders + installs it.
set -eu

: "${DEVENV_ROOT:?run inside the devenv shell (direnv allow / devenv shell)}"
: "${DEVENV_STATE:?run inside the devenv shell (direnv allow / devenv shell)}"
: "${LOCAL_SIM_PRIV_BIN:?run inside the devenv shell (direnv allow / devenv shell)}"

src="$DEVENV_ROOT/.sudoers/brokkr-sim"

# The installed file is named for the helper it authorises, so a sibling checkout at another
# revision installs its own file instead of deauthorising this one. Derivation duplicated in
# modules/sudo.nix and apps/local-lab's sudoersDropInName; the marker path below, in sudo.nix too.
store=$(basename "$(dirname "$(dirname "$LOCAL_SIM_PRIV_BIN")")")
suffix=${store:0:12}
if ! [[ $suffix =~ ^[0-9a-z]{12}$ ]]; then
  echo "✗ \$LOCAL_SIM_PRIV_BIN is not a /nix/store path ($LOCAL_SIM_PRIV_BIN) — not installing" >&2
  exit 1
fi
name="brokkr-sim-$suffix"
# Seam so a spec can seed a drop-in it cannot create root-owned. Grants nothing (it only moves
# where a still-prompting `sudo install` writes); the `noop` probes below stay unseamed.
sudoers_d="${BROKKR_SUDOERS_D:-/etc/sudoers.d}"
dst="$sudoers_d/$name"
# Host-global like the file it mirrors: under $DEVENV_STATE every fresh worktree pinning an
# already-authorised helper missed the fast path and re-prompted. $HOME-scoped, not /var — the
# render substitutes __USER__, so a shared marker would `cmp`-mismatch forever on a multi-user host.
marker_dir="${XDG_STATE_HOME:-$HOME/.local/state}/brokkr-local/sudoers"
marker="$marker_dir/$name.rev"
grp=$([ "$(uname)" = Darwin ] && echo wheel || echo root)

# Migration off the per-checkout marker, above the fast path on purpose: a checkout that takes
# that path never reaches the tail, so a sweep there would strand the dead state permanently.
rm -f "$DEVENV_STATE/sudoers/"*.rev
rmdir "$DEVENV_STATE/sudoers" 2>/dev/null || true

# The render must sit under the caller's home: dropin-current passes it through the helper's
# _resolve_file, which refuses anything outside. A bare mktemp lands in /var/folders on macOS.
case "$marker_dir" in
"$HOME"/*) ;;
*) echo '⚠ $XDG_STATE_HOME is outside $HOME — the helper cannot verify the drop-in, so this runs the slow path every time' >&2 ;;
esac
mkdir -p "$marker_dir"
rendered=$(mktemp "$marker_dir/.render.XXXXXX")
trap 'rm -f "$rendered"' EXIT
sed "s/__USER__/$(id -un)/g" "$src" >"$rendered"

# The filename claims which helper the file authorises; refuse to install one that pins another
# (a stale $DEVENV_ROOT/.sudoers render would otherwise make the drift check lie). The grant is a
# comma-separated command list, so both ends are padded to match a whole entry, not a prefix.
grant=$(grep -m 1 'ALL=(root) NOPASSWD:' "$rendered" || true)
case ", ${grant#*NOPASSWD: }," in
*", $LOCAL_SIM_PRIV_BIN,"*) ;;
*)
  echo "✗ $src pins a different helper than \$LOCAL_SIM_PRIV_BIN — re-enter the devenv shell" >&2
  exit 1
  ;;
esac

# Any OTHER brokkr-sim* drop-in is collected once it can no longer be a live, non-conflicting
# grant:
#   · it declares a Cmnd_Alias — the pre-content-addressing format. Alias names are a single
#     namespace across all of /etc/sudoers.d, so such a file shadows (or is shadowed by) every
#     other drop-in and makes sudo warn on every call. Collecting it can deauthorise a sibling
#     checkout still on that format; its own `task sudo:setup` restores it. Deliberate one-way
#     migration, not a regression.
#   · its pinned helper has left /nix/store — the path is unexecutable, so the grant is dead.
# Anything unparseable is left alone rather than guessed at. The glob is unprivileged, so on hosts
# where /etc/sudoers.d is 0750 (Fedora, Arch) it matches nothing and the sweep is a no-op — as it was
# before this rule existed. The post-install check below still catches a drop-in that shadows ours.
gc_colliding_dropins() {
  local f pinned
  for f in "$sudoers_d"/brokkr-sim*; do
    [ -f "$f" ] || continue
    [ "$f" = "$dst" ] && continue
    if sudo grep -q '^[[:space:]]*Cmnd_Alias' "$f"; then
      sudo rm -f "$f" && echo "  · removed $f (legacy Cmnd_Alias format — it collides with every other drop-in)"
      continue
    fi
    pinned=$(sudo grep -oE '/nix/store/[a-z0-9]+-brokkr-sim-priv/bin/brokkr-sim-priv' "$f" | head -n 1)
    case "$pinned" in /nix/store/*) ;; *) continue ;; esac
    [ -e "$pinned" ] && continue
    sudo rm -f "$f" && echo "  · removed stale $f (its helper is no longer in /nix/store)"
  done
}

# Asks the helper, which as root can read a drop-in the caller cannot stat at 0750. Only exit 3 is
# a trusted "no" — sudo returns 1 refusing -n too, so the fallback covers an older pinned helper.
dropin_current() {
  local rc=0
  sudo -n "$LOCAL_SIM_PRIV_BIN" dropin-current "$name" "$rendered" 2>/dev/null || rc=$?
  case $rc in
  0) return 0 ;;
  3) return 1 ;;
  *) [ -e "$dst" ] && [ -f "$marker" ] && [ "$(<"$rendered")" = "$(<"$marker")" ] ;;
  esac
}

# Prompt-free, so it can gate the fast path where the `noop` probe cannot: a live sudo ticket answers
# that probe for a policy granting nothing, which is how a shadowed host stays shadowed across
# `task up`. Not widened to any sibling — an alias-free one is legitimate, and blocking on it would
# re-prompt on every run.
#
# Needs search on /etc/sudoers.d, which is 0755 on macOS and the apt family but 0750 on Fedora and
# Arch. There this is constant-false — harmlessly, because `[ -e "$dst" ]` below needs the same bit,
# so the fast path is unreachable and every run reinstalls and verifies instead.
has_legacy_dropin() {
  [ -e "$sudoers_d/brokkr-sim" ] && [ "$dst" != "$sudoers_d/brokkr-sim" ]
}

# Already installed, unchanged, and unshadowed → silent no-op (no prompt). The `noop` probe asks
# the only question that matters — does the live policy authorise THIS helper — which
# `sudo -n /usr/bin/true` cannot, since a sibling checkout's drop-in allowlists that too.
if dropin_current && ! has_legacy_dropin &&
  sudo -n "$LOCAL_SIM_PRIV_BIN" noop 2>/dev/null; then
  echo "✓ passwordless sim sudo already current"
  exit 0
fi

if ! visudo -cf "$rendered"; then
  echo "✗ generated sudoers failed validation — not installing" >&2
  exit 1
fi

# Prime the credential here, in the foreground, so the one prompt is reliable cross-platform
# (macOS: Touch ID or password; Linux: password via the terminal's tty). The subsequent
# `sudo install` then runs within the cached window.
if ! sudo -n -v 2>/dev/null; then
  echo "→ sim needs sudo once (ipmi_sim port 623, loopback aliases, passwordless drop-in)…"
  sudo -v
fi

echo "installing $dst (one sudo prompt now; passwordless sim sudo thereafter)…"
sudo install -m 0440 -o root -g "$grp" "$rendered" "$dst"
gc_colliding_dropins

# `visudo -cf` above only ever saw the rendered file, so it cannot observe a conflict with another
# drop-in. Ask the live policy instead — this is the only check that proves the grant took effect,
# and the one that catches a collision the sweep above did not know how to resolve.
#
# `-k` is load-bearing: a bare `sudo -n` here could never fail. The credential primed above is still
# cached, and the operator necessarily holds a general grant (none of `sudo install`, `sudo rm` or
# `sudo -v` is allowlisted by the drop-in), so `-n` would find no prompt needed and report success
# whatever the drop-in does. Discarding the cached credential first leaves NOPASSWD as the only way
# to satisfy it. Costs nothing after this point: the remaining steps are unprivileged, and every
# later sim op depends on the NOPASSWD path this just proved. Do NOT copy `-k` up to the fast-path
# probe — there it would discard a credential the caller still needs and turn a silent no-op run
# into a prompt.
if ! sudo -k -n "$LOCAL_SIM_PRIV_BIN" noop 2>/dev/null; then
  echo "✗ installed $dst but the live policy still does not authorise $LOCAL_SIM_PRIV_BIN." >&2
  echo "  Another file in /etc/sudoers.d is overriding it. Inspect: sudo -n -l | grep brokkr-sim-priv" >&2
  exit 1
fi

cp "$rendered" "$marker"
echo "✓ installed $dst — task up / fleet ops + the control center now run without sudo prompts"
