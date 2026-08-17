#!/bin/bash
set -euo pipefail

# brokkr-local host bootstrap. Detects the host OS, runs the platform-unavoidable
# OS-level setup, then installs the bits Nix can't bootstrap itself — Nix (via the
# Determinate installer) + direnv — and wires the direnv shell hook + trusts the repo's
# .envrc, so a fresh shell + `cd` into the repo lands in the devenv shell with zero manual
# config. Idempotent: re-running is a no-op for anything already present. Run directly on a
# fresh machine (`bash sim/provisioning/bootstrap.sh`); `task up` runs it (once) thereafter.
#
# Platform split:
#   - macOS: Apple-Silicon-only; the toolchain (HVF-capable qemu, libvirt
#     user-session virtqemud, socket_vmnet, python+sushy, node, ...) is
#     entirely Nix. The one host dep Nix can't provide on Darwin is Docker Desktop
#     (Brewfile), which runs the linux/amd64 grub-build + iPXE-build containers.
#   - Linux: linux-bootstrap.sh contributes linux_host_packages() — the OS-level
#     system libvirtd (the stack connects to qemu:///system) + KVM access +
#     firmware blobs + docker that a non-NixOS host needs.

DIR="$(cd "$(dirname "$0")" && pwd)"

# Content-SHA marker (replaces the old binary host-bootstrapped sentinel). The cheap, idempotent
# steps (nix/direnv/devenv install, trusted-user ensure, direnv hook + allow) run on every
# invocation; only the slow, sudo-prompting OS-package step is gated — re-run it when this is a
# manual/explicit re-bootstrap (no BROKK_SETUP_QUIET — a bare `bash bootstrap.sh` or `task
# sim:setup`) OR when the bootstrap scripts changed since the last recorded success. `task up` sets
# BROKK_SETUP_QUIET=1, so its repeated runs skip apt/brew (no re-prompt) until the bootstrap itself
# changes — at which point it re-applies once.
_marker="${XDG_STATE_HOME:-$HOME/.local/state}/brokkr-local/host-bootstrap.sha"
_sha_cmd() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi; }
_bootstrap_sha() { cat "$DIR/bootstrap.sh" "$DIR/linux-bootstrap.sh" 2>/dev/null | _sha_cmd | awk '{print $1}'; }
needs_os_packages() {
  [ -z "${BROKK_SETUP_QUIET:-}" ] || [ "$(_bootstrap_sha)" != "$(cat "$_marker" 2>/dev/null || true)" ]
}

# _nix_user_trusted — true if $1 is a trusted nix user per the current config: the '*' wildcard, an
# explicit username, or membership in any @group listed in trusted-users (@admin on macos, @wheel on
# linux). extract only @-prefixed tokens so the '*' token can't reach the loop and glob-expand.
_nix_user_trusted() {
  local user="$1" trusted g
  trusted="$(nix config show trusted-users 2>/dev/null ||
    nix show-config 2>/dev/null | sed -n 's/^trusted-users = //p')"
  printf '%s' "$trusted" | grep -Eqw "(\*|$user)" && return 0
  for g in $(printf '%s\n' "$trusted" | tr ' ' '\n' | sed -n 's/^@//p'); do
    id -Gn "$user" 2>/dev/null | tr ' ' '\n' | grep -qx "$g" && return 0
  done
  return 1
}

# ensure_nix_trusted_user — add the current user to nix trusted-users so devenv's flake substituters
# (extra-substituters / -trusted-public-keys) aren't ignored (untrusted → builds from source) and
# privileged store ops don't fall back to root. Already-trusted (incl. via a group) is a no-op, no
# sudo. Otherwise append to /etc/nix/nix.custom.conf (the Determinate install's supported override
# file, !included by its nix.conf) and reload the daemon so it takes effect, then re-check: a clear
# warning fires if trust still didn't take (e.g. a nix-darwin host whose nix.conf doesn't include it).
ensure_nix_trusted_user() {
  local user custom="/etc/nix/nix.custom.conf"
  user="$(id -un)"
  if _nix_user_trusted "$user"; then
    echo "✓ $user is already a trusted nix user"
    return 0
  fi
  if [ -f "$custom" ] && grep -Eq "^extra-trusted-users[[:space:]]*=.*\b$user\b" "$custom"; then
    echo "==> $user already in $custom but not yet effective — reloading nix-daemon"
  else
    echo "==> adding $user to nix trusted-users ($custom)"
    printf 'extra-trusted-users = %s\n' "$user" | sudo tee -a "$custom" >/dev/null
  fi
  # reaching here ⇒ not yet trusted, so always reload to apply the entry (covers a prior run that
  # wrote the file but never reloaded; harmless when it's already live).
  if [ "$(uname)" = Darwin ]; then
    sudo launchctl kickstart -k system/org.nixos.nix-daemon 2>/dev/null || true
  else
    sudo systemctl restart nix-daemon 2>/dev/null || true
  fi
  if _nix_user_trusted "$user"; then
    echo "✓ $user added to nix trusted-users"
  else
    echo "⚠ $user still untrusted after updating $custom + reloading the daemon —"
    echo "   the generated nix.conf likely doesn't !include $custom (e.g. a nix-darwin host)."
    echo "   set nix.settings.trusted-users in your nix config, or add $user to the admin group."
  fi
}

install_nix_and_direnv() {
  # announce the DECISION, not the intention: printing a header and then silently doing nothing
  # reads as a stall, which is exactly how a long bootstrap gets misread as a hang
  if command -v nix >/dev/null 2>&1; then
    echo "✓ nix already installed ($(command -v nix))"
  else
    echo "==> installing Nix (Determinate installer)"
    curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix |
      sh -s -- install --no-confirm
  fi
  # make nix available in THIS shell for the direnv step below
  [ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ] &&
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh

  if command -v direnv >/dev/null 2>&1; then
    echo "✓ direnv already installed"
  else
    echo "==> installing direnv (via nix profile)"
    nix profile install nixpkgs#direnv
  fi

  # devenv itself — the repo's .envrc calls it (eval "$(devenv direnvrc)" / use devenv), so a
  # fresh shell can't load the environment without it. Nix can't bootstrap it implicitly; install
  # it the same way as direnv. Idempotent (skips when already on PATH).
  if command -v devenv >/dev/null 2>&1; then
    echo "✓ devenv already installed"
  else
    echo "==> installing devenv (via nix profile)"
    nix profile install nixpkgs#devenv
  fi
}

# install_docker_macos — Docker Desktop via the Brewfile cask. The one host dep Nix
# can't provide on Darwin (grub2 is Linux-only); the grub-build + iPXE-build
# containers run under it. Skipped when any docker is already on PATH, so an
# existing Docker/Colima/OrbStack install isn't overridden.
install_docker_macos() {
  if command -v docker >/dev/null 2>&1; then
    echo "✓ docker already on PATH ($(command -v docker)); skipping Docker Desktop install"
    return 0
  fi
  echo "==> Docker Desktop (Brewfile cask — runs the grub-build + iPXE-build containers)"
  if ! command -v brew >/dev/null 2>&1; then
    echo "❌ Homebrew is required to install Docker Desktop on macOS." >&2
    echo "   Install it from https://brew.sh and re-run, or install Docker yourself." >&2
    exit 1
  fi
  brew bundle --file "$DIR/../../../devenv/Brewfile"
  # the fleet iPXE build (fleet:init) needs the daemon running, not just installed — start Docker
  # Desktop now so it's up by the first `task up`. no-op for non-Docker.app runtimes (hence || true).
  open -a Docker 2>/dev/null || true
}

# detect_default_shell <fallback> — the user's real login shell ($SHELL), or the
# given OS-convention fallback when $SHELL is unset or names a shell we don't emit
# a direnv hook for (only zsh/bash hooks are offered below).
detect_default_shell() {
  case "$(basename "${SHELL:-}")" in
  zsh) echo zsh ;;
  bash) echo bash ;;
  *) echo "$1" ;;
  esac
}

# hook_direnv <fallback-shell> — append the direnv shell hook to the user's rc so a fresh shell
# auto-loads the devenv environment on `cd` into the repo. Idempotent (skips when already hooked)
# and touches only the detected default shell's rc — no manual rc editing, no surprise files.
hook_direnv() {
  local shell rc line
  shell="$(detect_default_shell "$1")"
  rc="$HOME/.${shell}rc"
  line="eval \"\$(direnv hook ${shell})\""
  if [ -f "$rc" ] && grep -q "direnv hook ${shell}" "$rc"; then
    echo "✓ direnv hook already in ~/.${shell}rc"
  else
    printf '\n%s\n' "$line" >>"$rc"
    echo "==> added the direnv hook to ~/.${shell}rc"
  fi
}

# allow_repo — trust the repo's committed .envrc so `cd` into it loads devenv without a manual
# `direnv allow`. No-op when direnv isn't on PATH yet or the .envrc is missing.
allow_repo() {
  local repo
  repo="$(cd "$DIR/../../.." && pwd)"
  if command -v direnv >/dev/null 2>&1 && [ -f "$repo/.envrc" ]; then
    direnv allow "$repo" 2>/dev/null && echo "==> direnv allow ${repo}" || true
  fi
}

# print_next_steps <platform-label> [extra-step]
# Renders the shared closing instructions. The direnv hook + repo allow are already done
# (hook_direnv/allow_repo), so the only remaining steps are a fresh shell + `task setup` + `task up`.
# <extra-step> is an optional already-numbered step injected before the final lines.
print_next_steps() {
  # suppressed when re-run from a context that already has a working devenv shell.
  [[ -n ${BROKK_SETUP_QUIET:-} ]] && return 0
  local label="$1" extra_step="${2:-}"
  echo ""
  echo "All ${label} host deps ready — Nix + direnv installed, direnv hook + repo allow done."
  echo ""
  echo "Next (no manual config left):"
  echo '  1. Start a fresh shell so the direnv hook loads:  exec $SHELL'
  local n=2
  if [[ -n $extra_step ]]; then
    echo "  ${n}. ${extra_step}"
    n=$((n + 1))
  fi
  echo "  ${n}. cd into this repo — direnv auto-loads the devenv shell (toolchain on PATH)."
  echo "  $((n + 1)). task setup   # commissioning: clone any missing hub/spoke checkout + make the ssh key (idempotent)"
  echo "  $((n + 2)). task up      # 1-shot: passwordless sim sudo + host bootstrap, then the whole stack"
  echo ""
}

bootstrap_main() {
  case "$OSTYPE" in
  darwin*)
    ARCH=$(uname -m)
    case "$ARCH" in
    arm64) echo "→ macOS Apple Silicon ($ARCH) — HVF accelerates arm64 guests" ;;
    x86_64)
      echo "❌ macOS Intel ($ARCH) is not supported — sim VMs are arm64 and need HVF" >&2
      exit 1
      ;;
    *)
      echo "❌ Unsupported macOS arch: $ARCH" >&2
      exit 1
      ;;
    esac
    install_nix_and_direnv
    ensure_nix_trusted_user
    if needs_os_packages; then
      install_docker_macos
    else
      echo "✓ OS packages already applied (bootstrap unchanged since last run)"
    fi
    hook_direnv zsh
    allow_repo
    print_next_steps "Mac-side"
    ;;
  linux-gnu* | linux*)
    # shellcheck source=apps/local-sim/provisioning/linux-bootstrap.sh
    source "$DIR/linux-bootstrap.sh"
    if needs_os_packages; then
      linux_host_packages
    else
      echo "✓ OS packages already applied (bootstrap unchanged since last run)"
    fi
    install_nix_and_direnv
    ensure_nix_trusted_user
    hook_direnv bash
    allow_repo
    print_next_steps "Linux-side" \
      "If you were just added to 'libvirt'/'kvm'/'docker', run 'newgrp <group>' or
     log out + back in so virsh + docker work without sudo."
    ;;
  *)
    echo "❌ Unsupported OS: $OSTYPE. brokkr-local supports macOS + Linux only." >&2
    exit 1
    ;;
  esac

  # Record the bootstrap scripts' content hash (reached only on success — set -e aborts earlier on
  # failure). needs_os_packages compares against this so the slow OS-package step re-applies only
  # when the bootstrap changes. Retire the old binary sentinel from pre-SHA checkouts.
  mkdir -p "$(dirname "$_marker")"
  _bootstrap_sha >"$_marker"
  rm -f "$(dirname "$_marker")/host-bootstrapped"
}

# tests source this file to exercise single functions; only a real invocation dispatches
[ "${BROKK_BOOTSTRAP_LIB:-}" = 1 ] || bootstrap_main
