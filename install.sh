#!/bin/sh
# Brokkr local-stack installer — from nothing to a running stack in one command:
#
#   curl -fsSL https://raw.githubusercontent.com/Hydra-Host/Brokkr/master/install.sh | sh
#
# It owns only what must happen BEFORE a checkout exists (git/curl, Xcode CLT, Homebrew,
# the clone) plus the orchestration a non-interactive shell can't get from the direnv
# shell hook. Every host prerequisite — Nix, direnv, devenv, the virt stack, Docker
# Desktop — stays owned by apps/local-sim/provisioning/bootstrap.sh, which this calls.
#
# POSIX sh on purpose: piping into `sh` means the shebang is never honored, so on
# Debian/Ubuntu the interpreter is dash and any bashism is a live bug. shellcheck runs
# this file in POSIX mode (SC3xxx at warning level) via treefmt, which is what keeps it
# honest — hence prefixed globals instead of `local`.
#
# Every phase is idempotent. A second run adopts the clone, skips the OS packages, and
# reconciles the stack.
set -eu

DEFAULT_REPO_URL='https://github.com/Hydra-Host/Brokkr.git'
DEFAULT_DIR='boss'
DEFAULT_DOCKER_WAIT='180'

# exit code the group-activation wrapper uses to say "the new groups still are not live"
RC_GROUPS_STALE=78
DEFAULT_PROGRESS_INTERVAL='30'

# github's ed25519 host key, pinned: a `curl | sh` run has no terminal to answer ssh's authenticity
# prompt, and accept-new alone would trust whatever the first connection offers — the one
# connection worth attacking. Verify against https://api.github.com/meta ('ssh_keys');
# fingerprint SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU
GITHUB_HOST_KEY='github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl'

REPO_URL=''
REPO_REF=''
SSH_KEY=''
KNOWN_HOSTS_FILE=''
TARGET_DIR=''
NO_UP=''
ASSUME_YES=''
DOCKER_WAIT=''
STOP_AFTER=''
HOST_OS=''
HAVE_TTY=0
SUDO_KEEPALIVE_PID=''
PENDING_GROUPS=''
PROGRESS_INTERVAL=''
TICKER_PID=''
STEP_START=''
PHASE_DIR=''
PHASE_FILE=''
RUN_START=''
C_RESET='' C_BOLD='' C_DIM='' C_BLUE='' C_GREEN='' C_YELLOW='' C_RED=''

# setup_colors — colour only a real terminal. Piped output (CI logs, `| tee`) and NO_COLOR must
# stay plain, so every variable is defined unconditionally and simply stays empty.
setup_colors() {
  C_RESET='' C_BOLD='' C_DIM='' C_BLUE='' C_GREEN='' C_YELLOW='' C_RED=''
  [ -t 1 ] || return 0
  [ -z "${NO_COLOR:-}" ] || return 0
  [ "${TERM:-dumb}" != dumb ] || return 0
  C_RESET="$(printf '\033[0m')"
  C_BOLD="$(printf '\033[1m')"
  C_DIM="$(printf '\033[2m')"
  C_BLUE="$(printf '\033[34m')"
  C_GREEN="$(printf '\033[32m')"
  C_YELLOW="$(printf '\033[33m')"
  C_RED="$(printf '\033[31m')"
}

log() { printf '%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s⚠%s  %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die() {
  printf '%s✗%s  %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Brokkr local-stack installer.

Usage:
  curl -fsSL <url> | sh
  curl -fsSL <url> | sh -s -- [options]

Options:
  --repo URL        repository to clone   (env BROKKR_REPO_URL)
  --ref REF         branch or tag         (env BROKKR_REPO_REF)
  --ssh-key PATH    ssh key for a private remote (env BROKKR_SSH_KEY)
  --dir PATH        clone target          (env BROKKR_DIR,           default ./boss)
  --no-up           stop before `task up` (env BROKKR_NO_UP=1)
  --yes             never prompt          (env BROKKR_YES=1)
  --docker-wait N   macOS Docker budget   (env BROKKR_DOCKER_WAIT,   default 180)
  --stop-after P    stop after a phase    (env BROKKR_STOP_AFTER)
                    P is one of: deps clone bootstrap path ready
  --help            this text

Progress: the devenv build is mostly Nix evaluation, which prints nothing on its own for
minutes. The installer streams devenv's phase markers and, during genuine silence, names
the phase it is waiting on every 30s. BROKKR_PROGRESS_INTERVAL changes that interval (0
disables it); BROKKR_VERBOSE=1 streams devenv's full -v output unfiltered.

The installer stores no credential of its own. With no --ssh-key it reuses whatever git
already has (an ssh agent, or a stored https credential). --ssh-key points it at an ssh
key file you already hold — a read-only deploy key is enough: the key is referenced,
never copied, and is wired into the clone's own git config so later fetches keep working.
An ssh key cannot authenticate an https remote, so --ssh-key clones the default remote
over ssh.
EOF
}

parse_args() {
  REPO_URL="${BROKKR_REPO_URL:-$DEFAULT_REPO_URL}"
  REPO_REF="${BROKKR_REPO_REF:-}"
  SSH_KEY="${BROKKR_SSH_KEY:-}"
  TARGET_DIR="${BROKKR_DIR:-$DEFAULT_DIR}"
  NO_UP="${BROKKR_NO_UP:-}"
  ASSUME_YES="${BROKKR_YES:-}"
  DOCKER_WAIT="${BROKKR_DOCKER_WAIT:-$DEFAULT_DOCKER_WAIT}"
  STOP_AFTER="${BROKKR_STOP_AFTER:-}"
  PROGRESS_INTERVAL="${BROKKR_PROGRESS_INTERVAL:-$DEFAULT_PROGRESS_INTERVAL}"

  while [ "$#" -gt 0 ]; do
    case "$1" in
    --repo)
      REPO_URL="${2:?--repo needs a URL}"
      shift 2
      ;;
    --ref)
      REPO_REF="${2:?--ref needs a ref}"
      shift 2
      ;;
    --ssh-key)
      SSH_KEY="${2:?--ssh-key needs a path}"
      shift 2
      ;;
    --dir)
      TARGET_DIR="${2:?--dir needs a path}"
      shift 2
      ;;
    --docker-wait)
      DOCKER_WAIT="${2:?--docker-wait needs a number}"
      shift 2
      ;;
    --stop-after)
      STOP_AFTER="${2:?--stop-after needs a phase}"
      shift 2
      ;;
    --no-up)
      NO_UP=1
      shift
      ;;
    --yes | -y)
      ASSUME_YES=1
      shift
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *) die "unknown option: $1 (try --help)" ;;
    esac
  done

  case "$STOP_AFTER" in
  '' | deps | clone | bootstrap | path | ready) ;;
  *) die "--stop-after must be one of: deps clone bootstrap path ready" ;;
  esac

  # a non-numeric budget makes `[ n -ge "$DOCKER_WAIT" ]` fail with status 2 on every pass,
  # which the enclosing `if` reads as false — the timeout would never fire and the wait loop
  # would spin forever
  case "$DOCKER_WAIT" in
  '' | *[!0-9]*) die "--docker-wait must be a whole number of seconds" ;;
  esac

  case "$PROGRESS_INTERVAL" in
  '' | *[!0-9]*) die "BROKKR_PROGRESS_INTERVAL must be a whole number of seconds (0 disables)" ;;
  esac
}

# stop_here <phase> — true once the run has reached the requested --stop-after boundary. It
# announces the stop: a bounded run that just ends mid-output is indistinguishable from a crash.
stop_here() {
  [ -n "$STOP_AFTER" ] || return 1
  [ "$STOP_AFTER" = "$1" ] || return 1
  printf '\n'
  log "stopped after the '$1' phase, as asked (--stop-after)"
  return 0
}

# detect_host — reject an unsupported host before anything is installed or cloned.
# bootstrap.sh gates on the same facts, but failing after a multi-hundred-megabyte clone
# is a far worse experience than failing in a fraction of a second.
detect_host() {
  _dh_arch="$(uname -m)"
  case "$(uname -s)" in
  Darwin)
    [ "$_dh_arch" = arm64 ] ||
      die "macOS on $_dh_arch is unsupported — the sim VMs are arm64 and need HVF."
    HOST_OS=macos
    ;;
  Linux)
    case "$_dh_arch" in
    x86_64 | aarch64) ;;
    *) die "unsupported Linux architecture: $_dh_arch (need x86_64 or aarch64)." ;;
    esac
    HOST_OS=linux
    ;;
  *) die "unsupported OS: $(uname -s). Brokkr's local stack supports macOS and Linux." ;;
  esac
}

# detect_tty — under `curl | sh` fd 0 is the script itself, so a usable prompt has to come
# from /dev/tty. sudo reads the terminal directly, so a pipe started from an interactive
# shell still prompts fine; a genuinely headless run is what this distinguishes.
# the probe runs in a subshell on purpose: POSIX makes a redirection error on a SPECIAL
# builtin (`:`, `exec`) exit a non-interactive shell outright, so probing the terminal
# directly kills the installer on any headless host. The subshell contains that exit.
detect_tty() {
  if (true >/dev/tty) 2>/dev/null; then HAVE_TTY=1; else HAVE_TTY=0; fi
}

confirm() {
  [ -z "$ASSUME_YES" ] || return 0
  [ "$HAVE_TTY" = 1 ] ||
    die "no terminal to confirm on — re-run with BROKKR_YES=1 (or --yes) to proceed unattended."
  printf '\nProceed? [y/N] '
  read -r _cf_reply </dev/tty || _cf_reply=''
  case "$_cf_reply" in
  y | Y | yes | YES) return 0 ;;
  *) die "aborted." ;;
  esac
}

print_plan() {
  printf '\n'
  log "Brokkr local-stack installer"
  info "repository : $REPO_URL${REPO_REF:+ (ref $REPO_REF)}"
  [ -z "$SSH_KEY" ] || info "ssh key    : $SSH_KEY"
  info "clone into : $TARGET_DIR"
  info "host       : $HOST_OS $(uname -m)"
  # --stop-after outranks --no-up, and both outrank the default: the plan must name the phase
  # the run will actually end at, or a bounded run advertises work it never does
  if [ -n "$STOP_AFTER" ]; then
    info "finish at  : after the '$STOP_AFTER' phase (--stop-after)"
  elif [ -n "$NO_UP" ]; then
    info "finish at  : environment ready, before the stack comes up (--no-up)"
  else
    info "finish at  : the whole stack running"
  fi
  printf '\n'
  info "This installs, when missing: git/curl, Nix, direnv, devenv, and the"
  info "libvirt/qemu virt stack (Docker Desktop on macOS). It needs sudo for the"
  info "OS packages, the nix trusted-user entry, and a scoped passwordless drop-in"
  info "for the sim's privileged operations. You are asked for it once, up front."
}

# ---------------------------------------------------------------- sudo

# as_root — a root shell or a container usually has no sudo binary at all, so a blind
# `sudo` prefix fails there for no reason.
as_root() {
  if [ "$(id -u)" = 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

# prime_sudo — take the credential once, then hold it. The chain prompts in two places
# minutes apart (the OS package install, and install-sim-sudoers.sh under `task up`) with
# the first devenv build in between, so without a keepalive the sudo timestamp expires and
# the second prompt fires at an unattended terminal — which is the documented
# "3 incorrect password attempts" failure.
prime_sudo() {
  [ "$(id -u)" = 0 ] && return 0
  # `sudo -n true` succeeds for a NOPASSWD rule AND for a merely cached timestamp. Returning
  # here on that basis would skip the keepalive and let a cached credential expire mid-build —
  # exactly the failure this function exists to prevent. Only the prompt is conditional.
  if ! sudo -n true 2>/dev/null; then
    if [ "$HAVE_TTY" != 1 ]; then
      warn "no terminal for a sudo prompt — steps needing root will fail or be skipped."
      return 1
    fi
    sudo -v </dev/tty || return 1
  fi
  # bounded by the installer's own lifetime, not just by the trap: a trap cannot catch SIGKILL, and
  # an orphaned refresher would hold the sudo timestamp open indefinitely after the script is gone
  _ps_owner=$$
  while true; do
    sleep 50
    kill -0 "$_ps_owner" 2>/dev/null || exit 0
    sudo -n true 2>/dev/null || exit 0
  done &
  SUDO_KEEPALIVE_PID=$!
  return 0
}

stop_keepalive() {
  [ -n "$SUDO_KEEPALIVE_PID" ] || return 0
  kill "$SUDO_KEEPALIVE_PID" 2>/dev/null || true
  SUDO_KEEPALIVE_PID=''
}

# ---------------------------------------------------------------- progress

# elapsed <start-epoch> — "4m07s" since start.
elapsed() {
  _el_now="$(date +%s)"
  _el_d=$((_el_now - $1))
  printf '%dm%02ds' "$((_el_d / 60))" "$((_el_d % 60))"
}

# file_mtime <path> — epoch seconds, on GNU and BSD stat alike. Validate rather than rely on
# exit status: GNU `stat -f` is "filesystem info" and exits 0, so a plain `-f %m || -c %Y`
# chain silently returns a block-size report on a GNU host instead of falling through.
file_mtime() {
  _fm_v="$(stat -c %Y "$1" 2>/dev/null)"
  case "$_fm_v" in '' | *[!0-9]*) _fm_v="$(stat -f %m "$1" 2>/dev/null)" ;; esac
  case "$_fm_v" in '' | *[!0-9]*) return 1 ;; esac
  printf '%s' "$_fm_v"
}

# file_mode <path> — octal mode, on GNU and BSD stat alike. Same two-try shape as file_mtime,
# and for the same reason: neither flag spelling exists on both.
file_mode() {
  _fo_v="$(stat -c %a "$1" 2>/dev/null)"
  case "$_fo_v" in '' | *[!0-7]*) _fo_v="$(stat -f %Lp "$1" 2>/dev/null)" ;; esac
  printf '%s' "$_fo_v"
}

# init_phase_state — the ticker and the output filter run in different processes, so the current
# phase travels through a file. Its mtime doubles as "when did we last print", which is what lets
# the ticker stay quiet while output is flowing.
init_phase_state() {
  PHASE_DIR="$(mktemp -d)"
  PHASE_FILE="$PHASE_DIR/phase"
  : >"$PHASE_FILE"
}

# begin_step <message> — announce a long step and start ticking elapsed time.
#
# devenv's first activation is CPU-bound Nix EVALUATION, which prints nothing at all —
# measured here at a steady 100% CPU with no child process and no daemon activity for over
# six minutes. There is no output to stream, so liveness has to be manufactured: without a
# ticker a perfectly healthy run is indistinguishable from a hang, which is exactly how this
# was first reported.
begin_step() {
  log "$1"
  STEP_START="$(date +%s)"
  stop_ticker
  _bs_owner=$$
  _bs_start="$STEP_START"
  _bs_every="$PROGRESS_INTERVAL"
  [ "$_bs_every" -gt 0 ] 2>/dev/null || return 0
  [ -n "$PHASE_FILE" ] || return 0
  (
    while true; do
      sleep "$_bs_every"
      kill -0 "$_bs_owner" 2>/dev/null || exit 0
      # speak only into real silence: the filter touches PHASE_FILE on every line it prints, so
      # its mtime separates "nothing is happening" from "output is flowing"
      _bs_now="$(date +%s)"
      _bs_last="$(file_mtime "$PHASE_FILE" 2>/dev/null)"
      [ -n "$_bs_last" ] || _bs_last="$_bs_now"
      [ "$((_bs_now - _bs_last))" -ge "$_bs_every" ] || continue
      _bs_phase="$(cat "$PHASE_FILE" 2>/dev/null)"
      [ -n "$_bs_phase" ] || _bs_phase='working'
      printf '\r    %s… still: %s (%s)%s\n' \
        "$C_DIM" "$_bs_phase" "$(elapsed "$_bs_start")" "$C_RESET"
    done
  ) &
  TICKER_PID=$!
}

# end_step [message] — stop ticking and report how long the step took.
end_step() {
  stop_ticker
  [ -n "$STEP_START" ] || return 0
  ok "${1:-done} ${C_DIM}($(elapsed "$STEP_START"))${C_RESET}"
  STEP_START=''
}

# begin_step_quiet <message> — announce and time a step whose command prints its own output.
# Deliberately no ticker: the ticker exists for devenv's silent evaluation, and running it while
# `task` output is scrolling reports a stale phase name from the previous step.
begin_step_quiet() {
  log "$1"
  STEP_START="$(date +%s)"
  stop_ticker
}

stop_ticker() {
  [ -n "$TICKER_PID" ] || return 0
  kill "$TICKER_PID" 2>/dev/null || true
  TICKER_PID=''
}

# one owner for every background loop, so an interrupt cannot orphan a ticker or a keepalive
cleanup() {
  stop_ticker
  stop_keepalive
  [ -n "$PHASE_DIR" ] && rm -rf "$PHASE_DIR"
  PHASE_DIR=''
}

# ---------------------------------------------------------------- phase: pre-clone deps

# linux_install_pkgs — git is genuinely ours: linux-bootstrap.sh installs curl and
# ca-certificates but never git, and nothing can be cloned without it. Everything heavier
# stays in linux-bootstrap.sh; this is deliberately the smallest possible package list.
linux_install_pkgs() {
  # the ssh client is not in the base list on purpose — it is only needed for an --ssh-key clone,
  # and git merely Recommends it, so --no-install-recommends leaves a minimal image without one
  _lp_ssh=''
  [ -z "$SSH_KEY" ] || command -v ssh >/dev/null 2>&1 || _lp_ssh=1
  log "installing git and curl${_lp_ssh:+ and the ssh client}"
  if command -v apt-get >/dev/null 2>&1; then
    # `as_root env VAR=...`, never a `VAR=... as_root` prefix: sudo runs env_reset by default and
    # DEBIAN_FRONTEND is not in env_keep, so an ambient assignment never reaches apt and a debconf
    # prompt could still block an unattended run. Same reason run_stack passes HOME/PATH via env.
    as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git curl ca-certificates ${_lp_ssh:+openssh-client}
  elif command -v dnf >/dev/null 2>&1; then
    as_root dnf install -y git curl ca-certificates ${_lp_ssh:+openssh-clients}
  elif command -v pacman >/dev/null 2>&1; then
    as_root pacman -S --needed --noconfirm git curl ca-certificates ${_lp_ssh:+openssh}
  else
    die "no supported package manager (apt/dnf/pacman) — install git and curl, then re-run."
  fi
}

macos_ensure_clt() {
  xcode-select -p >/dev/null 2>&1 && return 0
  [ "$HAVE_TTY" = 1 ] ||
    die "Xcode Command Line Tools are missing — run 'xcode-select --install', then re-run."
  log "installing the Xcode Command Line Tools (a dialog opens — finish it here)"
  xcode-select --install >/dev/null 2>&1 || true
  _mc_waited=0
  while ! xcode-select -p >/dev/null 2>&1; do
    sleep 5
    _mc_waited=$((_mc_waited + 5))
    [ "$_mc_waited" -ge 1800 ] &&
      die "the Command Line Tools install did not finish — complete it, then re-run."
  done
  log "Command Line Tools ready"
}

# macos_ensure_brew — Homebrew exists here only to carry the Docker Desktop cask, and
# bootstrap.sh's install_docker_macos skips docker entirely when any docker is already on
# PATH. Mirror that guard so an OrbStack/Colima user is never made to install brew.
macos_ensure_brew() {
  command -v docker >/dev/null 2>&1 && return 0
  if ! command -v brew >/dev/null 2>&1; then
    log "installing Homebrew (needed for the Docker Desktop cask)"
    NONINTERACTIVE=1 /bin/bash -c \
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  # a fresh install is not on PATH in this process, and install_docker_macos hard-exits
  # when it cannot see brew
  for _mb_prefix in /opt/homebrew /usr/local; do
    if [ -x "$_mb_prefix/bin/brew" ]; then
      eval "$("$_mb_prefix/bin/brew" shellenv)"
      break
    fi
  done
  command -v brew >/dev/null 2>&1 ||
    die "Homebrew install did not put brew on PATH — install it from https://brew.sh, then re-run."
}

ensure_pre_clone_deps() {
  if [ "$HOST_OS" = macos ]; then
    macos_ensure_clt
    macos_ensure_brew
  else
    if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1 ||
      { [ -n "$SSH_KEY" ] && ! command -v ssh >/dev/null 2>&1; }; then
      linux_install_pkgs
    fi
  fi
  command -v git >/dev/null 2>&1 || die "git is still missing — install it, then re-run."
  command -v curl >/dev/null 2>&1 || die "curl is still missing — install it, then re-run."
  [ -n "$SSH_KEY" ] || return 0
  command -v ssh >/dev/null 2>&1 || die "ssh is missing — install the OpenSSH client, then re-run."
  # -P '' supplies an empty passphrase rather than prompting: an encrypted key would otherwise
  # stall on a passphrase prompt no `curl | sh` run can answer
  ssh-keygen -y -P '' -f "$SSH_KEY" >/dev/null 2>&1 ||
    die "$SSH_KEY is not a usable private key — it is encrypted, or not a key at all. It must be passphrase-free."
}

# ---------------------------------------------------------------- ssh key

# shq — single-quote a value for the command string git hands to `sh -c`. A key path containing a
# space is otherwise re-split by that shell, and ssh then reports a key that is not the one asked for.
shq() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# to_ssh_url — the scp-style spelling of an https remote. Anything else (ssh://, git@, file://,
# a local path) is returned untouched.
to_ssh_url() {
  printf '%s' "$1" |
    sed -e 's|^https\{0,1\}://[^@/]*@|https://|' \
      -e 's|^https\{0,1\}://\([^/]*\)/|git@\1:|'
}

# git_ssh_command — the ssh invocation for this checkout. IdentitiesOnly is the load-bearing
# option: an agent holding a personal key would otherwise authenticate with it first, and github
# answers a valid-but-unauthorized identity with "Repository not found" rather than a denial.
# Aggravated here because `task local:setup` later CREATES ~/.ssh/id_ed25519 for the sim, a
# default identity ssh would offer to github on every fetch after that.
# The pin file comes first so accept-new writes new hosts there and github is never "new".
git_ssh_command() {
  printf 'ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s' \
    "$(shq "$SSH_KEY")" "$(shq "$KNOWN_HOSTS_FILE $HOME/.ssh/known_hosts")"
}

# ensure_known_hosts — appended, never rewritten: a rotation ships as a second line and ssh
# accepts either, where an overwrite would strip the entry the running host still presents.
ensure_known_hosts() {
  KNOWN_HOSTS_FILE="$HOME/.ssh/brokkr_known_hosts"
  mkdir -p "$HOME/.ssh" || die "cannot create $HOME/.ssh for the ssh host-key pin."
  chmod 700 "$HOME/.ssh" 2>/dev/null || true
  if ! grep -qF "$GITHUB_HOST_KEY" "$KNOWN_HOSTS_FILE" 2>/dev/null; then
    printf '%s\n' "$GITHUB_HOST_KEY" >>"$KNOWN_HOSTS_FILE" ||
      die "cannot write $KNOWN_HOSTS_FILE — ssh has no way to verify github's host key without it."
  fi
}

# tighten_key_perms — ssh refuses a key other users can read, and a key saved from a browser or
# unpacked from a CI artifact arrives 0644. chmod only ever removes access, so doing it is safe;
# doing it silently is not.
tighten_key_perms() {
  _tk_before="$(file_mode "$SSH_KEY")"
  chmod 600 "$SSH_KEY" 2>/dev/null ||
    die "cannot chmod 600 $SSH_KEY — ssh refuses a key other users can read. Fix it, then re-run."
  [ "$_tk_before" = "$(file_mode "$SSH_KEY")" ] ||
    info "tightened $SSH_KEY to 0600 — ssh refuses a key other users can read"
}

# resolve_ssh_url — an ssh key authenticates ssh and nothing else; it cannot sign an https clone.
# Rewriting OUR OWN default's transport is safe and keeps the one-liner one line. A remote the
# caller typed is their stated intent, so that one is refused with the spelling to use instead —
# the scp rewrite is not always right for another forge.
resolve_ssh_url() {
  case "$REPO_URL" in
  http://* | https://*) ;;
  *) return 0 ;;
  esac
  if [ "$REPO_URL" = "$DEFAULT_REPO_URL" ]; then
    REPO_URL="$(to_ssh_url "$REPO_URL")"
    return 0
  fi
  warn "an ssh key cannot authenticate an https remote:"
  info "  $REPO_URL"
  info "Re-run with the ssh spelling:"
  info "  --repo $(to_ssh_url "$REPO_URL")"
  exit 1
}

# resolve_ssh_key — validate before use. `ssh -i <missing file>` does NOT fail: it warns and falls
# back to every default identity, which is the silent wrong-identity clone this whole path exists
# to avoid. The encrypted-key check lives in ensure_pre_clone_deps instead — it needs ssh-keygen,
# which on Linux only exists after the package step.
resolve_ssh_key() {
  [ -n "$SSH_KEY" ] || return 0
  # a quoted BROKKR_SSH_KEY='~/...' never passes through a shell that would expand the ~
  _rk_untilde="${SSH_KEY#\~/}"
  [ "$_rk_untilde" = "$SSH_KEY" ] || SSH_KEY="$HOME/$_rk_untilde"
  [ -f "$SSH_KEY" ] || die "no ssh key at $SSH_KEY (--ssh-key / BROKKR_SSH_KEY)."
  [ -r "$SSH_KEY" ] || die "cannot read the ssh key at $SSH_KEY."
  # ssh resolves -i against its own cwd, and later git runs it from inside the checkout, not from
  # here — a relative path would authenticate the clone and then break every fetch after it
  _rk_dir="$(CDPATH='' cd -- "$(dirname -- "$SSH_KEY")" && pwd)" ||
    die "cannot resolve the directory holding $SSH_KEY."
  SSH_KEY="$_rk_dir/$(basename -- "$SSH_KEY")"
  case "$(head -n 1 "$SSH_KEY")" in
  *'PRIVATE KEY'*) ;;
  *) die "$SSH_KEY is not a private key — pass the file WITHOUT the .pub suffix." ;;
  esac
  tighten_key_perms
  ensure_known_hosts
  resolve_ssh_url
}

# ---------------------------------------------------------------- phase: clone

# normalize_git_url — compare remotes for identity, not for byte equality: scp-style and
# https spellings of the same repo must match, as must a trailing slash or .git.
normalize_git_url() {
  # '|' as the delimiter, not ':' — a ':' delimiter collides with the ':' inside the
  # bracket expression below, and sed then silently mangles every URL to the same value,
  # which would make two DIFFERENT remotes compare equal
  printf '%s' "$1" |
    sed -e 's|^ssh://git@|https://|' \
      -e 's|^git@\([^:/]*\):|https://\1/|' \
      -e 's|/*$||' \
      -e 's|\.git$||' |
    tr '[:upper:]' '[:lower:]'
}

resolve_target_dir() {
  _rt_parent="$(dirname -- "$TARGET_DIR")"
  _rt_base="$(basename -- "$TARGET_DIR")"
  [ -d "$_rt_parent" ] || die "parent directory does not exist: $_rt_parent"
  TARGET_DIR="$(CDPATH='' cd -- "$_rt_parent" && pwd)/$_rt_base"
}

clone_or_adopt() {
  if [ -e "$TARGET_DIR" ] && [ ! -d "$TARGET_DIR" ]; then
    die "$TARGET_DIR exists and is not a directory. Pass --dir to choose another target."
  fi

  if [ -d "$TARGET_DIR" ] && [ -n "$(ls -A "$TARGET_DIR" 2>/dev/null)" ]; then
    if [ ! -e "$TARGET_DIR/.git" ]; then
      die "$TARGET_DIR is not empty and is not a git checkout. Pass --dir to choose another target."
    fi
    _ca_origin="$(git -C "$TARGET_DIR" remote get-url origin 2>/dev/null || true)"
    [ -n "$_ca_origin" ] ||
      die "$TARGET_DIR is a git checkout with no 'origin' remote. Pass --dir to choose another target."
    if [ "$(normalize_git_url "$_ca_origin")" != "$(normalize_git_url "$REPO_URL")" ]; then
      die "$TARGET_DIR already tracks $_ca_origin, not $REPO_URL. Pass --dir to choose another target."
    fi
    # adopt as-is: the checkout may carry local work, and moving it is never our call
    log "reusing the existing checkout at $TARGET_DIR"
    if [ -n "$SSH_KEY" ]; then
      git -C "$TARGET_DIR" config --local core.sshCommand "$(git_ssh_command)"
      # warn, never rewrite: the remote is the user's, and a checkout cloned over https before the
      # remote went private is the case that hits this
      case "$_ca_origin" in
      http://* | https://*)
        warn "origin is https ($_ca_origin) — the ssh key cannot authenticate a fetch from it"
        info "  switch it with: git -C $TARGET_DIR remote set-url origin $(to_ssh_url "$_ca_origin")"
        ;;
      esac
    fi
  else
    log "cloning $REPO_URL into $TARGET_DIR"
    # positional parameters are POSIX's only array, and building the argv collapses what was two
    # near-identical git clone calls
    set --
    [ -z "$REPO_REF" ] || set -- "$@" --branch "$REPO_REF"
    # --config is applied to the new repo BEFORE the fetch, so one flag both authenticates this
    # clone and leaves the key wired up for every fetch after it. Never GIT_SSH_COMMAND: run_stack
    # re-execs through `sudo -u ... env`, which drops it, and main() forks the stack supervisor,
    # which would inherit it for its whole lifetime.
    [ -z "$SSH_KEY" ] || set -- "$@" --config "core.sshCommand=$(git_ssh_command)"
    git clone "$@" -- "$REPO_URL" "$TARGET_DIR" || clone_failed
  fi

  [ -f "$TARGET_DIR/apps/local-sim/provisioning/bootstrap.sh" ] ||
    die "$TARGET_DIR has no apps/local-sim/provisioning/bootstrap.sh — wrong repository or ref?"
}

clone_failed() {
  warn "could not clone $REPO_URL"
  if [ -n "$SSH_KEY" ]; then
    info "The clone offered $SSH_KEY and no other identity."
    info "  authorized : the key must be authorized on THIS repository — 'Repository not found'"
    info "               means it authenticated as something else"
    info "  transport  : an ssh key works over ssh only (git@host:owner/repo.git)"
    info "  check it   : ssh -i $SSH_KEY -o IdentitiesOnly=yes -T git@github.com"
    exit 1
  fi
  info "For a private remote the installer reuses git's own credentials — it never takes one."
  info "  ssh URL   : make sure your key is loaded (ssh-add -l) and authorized on the host"
  info "  https URL : make sure a credential helper has a token stored"
  info "  elsewhere : point at another remote with BROKKR_REPO_URL (or --repo)"
  exit 1
}

# ---------------------------------------------------------------- phase: bootstrap

# run_bootstrap — BROKK_SETUP_QUIET=1 is deliberate and is NOT "skip the OS packages".
# bootstrap.sh's gate is `[ -z "$BROKK_SETUP_QUIET" ] || <content sha differs>`, so setting
# it hands the decision to the content hash: absent marker (fresh host) installs, matching
# marker skips silently, changed bootstrap re-applies once. It also suppresses the script's
# "next steps" epilogue, which tells the reader to do what this installer is about to do.
run_bootstrap() {
  log "running the host bootstrap (Nix, direnv, devenv, virt stack)"
  BROKK_SETUP_QUIET=1 bash "$TARGET_DIR/apps/local-sim/provisioning/bootstrap.sh" ||
    die "the host bootstrap failed — see devenv/README.md (Troubleshooting), fix, then re-run."
}

# ---------------------------------------------------------------- phase: PATH

# activate_nix_path — bootstrap.sh sources the nix profile into its own shell, a child
# process, so nothing reaches us. Sourcing the profile script here is unreliable: it
# early-returns when __ETC_PROFILE_NIX_SOURCED is already set. Prepend explicitly instead.
# direnv/devenv live in the user profile, nix in the default one, so both are needed.
activate_nix_path() {
  for _ap_dir in \
    "${XDG_STATE_HOME:-$HOME/.local/state}/nix/profile/bin" \
    "$HOME/.nix-profile/bin" \
    /nix/var/nix/profiles/default/bin; do
    [ -d "$_ap_dir" ] || continue
    case ":$PATH:" in
    *":$_ap_dir:"*) ;;
    *) PATH="$_ap_dir:$PATH" ;;
    esac
  done
  # install-sim-sudoers.sh calls visudo unqualified, and the devenv PATH is pure Nix store
  # with ours appended — so a caller without /usr/sbin breaks it
  for _ap_dir in /usr/sbin /sbin; do
    [ -d "$_ap_dir" ] || continue
    case ":$PATH:" in
    *":$_ap_dir:"*) ;;
    *) PATH="$PATH:$_ap_dir" ;;
    esac
  done
  export PATH

  command -v nix >/dev/null 2>&1 || die "nix is not on PATH after the bootstrap — re-run the installer."
  command -v devenv >/dev/null 2>&1 || die "devenv is not on PATH after the bootstrap — re-run the installer."
}

# ---------------------------------------------------------------- phase: readiness

# find_pending_groups — `id -nG` with no operand reports the LIVE process groups; with a
# user operand it reports the group database. The difference is exactly what usermod added
# and this session has not picked up.
find_pending_groups() {
  PENDING_GROUPS=''
  [ "$HOST_OS" = linux ] || return 0
  _fp_user="$(id -un)"
  for _fp_group in libvirt kvm docker; do
    id -nG "$_fp_user" 2>/dev/null | tr ' ' '\n' | grep -qx "$_fp_group" || continue
    id -nG 2>/dev/null | tr ' ' '\n' | grep -qx "$_fp_group" && continue
    PENDING_GROUPS="$PENDING_GROUPS $_fp_group"
  done
  PENDING_GROUPS="${PENDING_GROUPS# }"
}

# wait_for_docker — bootstrap.sh fires `open -a Docker` and moves on. Nothing downstream
# gates on the daemon: the doctor check only warns, and the preflight gate returns before
# reaching it — so `task up` succeeds and then fleet:init fails minutes later, after
# stack-up has already returned. Wait here, where the failure is still explainable.
wait_for_docker() {
  [ "$HOST_OS" = macos ] || return 0
  if ! command -v docker >/dev/null 2>&1; then
    warn "no docker on PATH — the fleet's iPXE/grub build (fleet:init) will fail."
    return 0
  fi
  docker info >/dev/null 2>&1 && return 0
  open -a Docker 2>/dev/null || true
  log "waiting for the Docker daemon (the fleet's iPXE/grub build needs it)"
  _wd_waited=0
  while ! docker info >/dev/null 2>&1; do
    sleep 3
    _wd_waited=$((_wd_waited + 3))
    if [ "$_wd_waited" -ge "$DOCKER_WAIT" ]; then
      warn "Docker was not ready within ${DOCKER_WAIT}s."
      info "The stack still comes up; only fleet:init fails until Docker runs."
      info "A first launch shows a licence dialog and can ask for an admin password."
      info "Start Docker Desktop, then: cd $TARGET_DIR && devenv --no-tui shell -- task up"
      return 0
    fi
  done
  log "Docker daemon ready"
}

# ---------------------------------------------------------------- phase: stack

# can_run_up — `task up` installs the sudoers drop-in, which needs a satisfiable prompt.
# A tty gives one; an already-installed drop-in makes it passwordless. With neither,
# attempting it guarantees the documented "3 incorrect password attempts" failure.
can_run_up() {
  [ "$(id -u)" = 0 ] && return 0
  [ "$HAVE_TTY" = 1 ] && return 0
  sudo -n true 2>/dev/null && return 0
  return 1
}

# devenv_run <command-string> — run inside the checkout's devenv shell, with the terminal
# attached when there is one. Never redirect /dev/tty unconditionally: on a headless host
# the redirect itself fails, turning "nothing to prompt with" into an opaque error.
devenv_run() {
  if [ "$HAVE_TTY" = 1 ]; then
    (cd "$TARGET_DIR" && devenv --no-tui shell -- sh -c "$1") </dev/tty
  else
    (cd "$TARGET_DIR" && devenv --no-tui shell -- sh -c "$1")
  fi
}

# strip_ansi — awk, not sed: GNU sed block-buffers when its stdout is a pipe, which would turn a
# live stream into an end-of-run dump. fflush() after every line keeps it live.
strip_ansi() {
  awk -v esc="$(printf '\033')" '{ gsub(esc "\\[[0-9;]*m", ""); print; fflush() }'
}

# filter_devenv_line <line> — keep devenv's own phase markers, drop its debug noise.
# `devenv -v` is the only way to get progress out of it: with no flag it prints 48 bytes for an
# entire multi-minute build. Markers begin `•` (starting) or `✓` (finished, with a duration);
# everything else is lock fingerprints and cache chatter.
filter_devenv_line() {
  _fl_plain="$(printf '%s' "$1" | strip_ansi)"
  case "$_fl_plain" in
  '•'*)
    _fl_label="${_fl_plain#• }"
    printf '%s\n' "$_fl_label" >"$PHASE_FILE"
    printf '\r    %s•%s %s\n' "$C_BLUE" "$C_RESET" "$_fl_label"
    ;;
  '✓'*)
    _fl_label="${_fl_plain#✓ }"
    # clear the label rather than record it: a ✓ line means that phase FINISHED, so leaving it
    # in place makes the ticker announce a completed step, duration and all, as if still running
    : >"$PHASE_FILE"
    printf '\r    %s✓%s %s%s%s\n' "$C_GREEN" "$C_RESET" "$C_DIM" "$_fl_label" "$C_RESET"
    ;;
  esac
}

# devenv_stream <command-string> — like devenv_run, but surfaces devenv's phase markers as they
# arrive. The while loop runs in a subshell, so devenv's exit status comes back through a file
# rather than a variable. BROKKR_VERBOSE=1 skips the filter entirely.
devenv_stream() {
  _ds_rcfile="$PHASE_DIR/rc"
  : >"$_ds_rcfile"
  if [ -n "${BROKKR_VERBOSE:-}" ]; then
    (cd "$TARGET_DIR" && devenv --no-tui -v shell -- sh -c "$1")
    return $?
  fi
  {
    (cd "$TARGET_DIR" && devenv --no-tui -v shell -- sh -c "$1" 2>&1)
    printf '%s\n' "$?" >"$_ds_rcfile"
  } | strip_ansi | while IFS= read -r _ds_line; do
    filter_devenv_line "$_ds_line"
  done
  _ds_rc="$(cat "$_ds_rcfile" 2>/dev/null)"
  [ -n "$_ds_rc" ] || _ds_rc=1
  return "$_ds_rc"
}

# warm_devenv — pay the first activation as its OWN announced step. Folding it into the
# bring-up is what made a 10-minute silent evaluation look like a hang: the cost belongs to a
# phase that names itself. The later activations hit the cache and cost seconds.
warm_devenv() {
  begin_step "building the devenv toolchain — first run only, several minutes"
  set +e
  devenv_stream 'true'
  _wd_rc=$?
  set -e
  stop_ticker
  [ "$_wd_rc" = 0 ] ||
    die "the devenv toolchain failed to build — see devenv/README.md (Troubleshooting), then re-run."
  end_step "devenv toolchain ready"
}

run_onboarding() {
  begin_step_quiet "onboarding (ssh key, any missing checkout)"
  set +e
  devenv_run 'task local:setup'
  _ro_rc=$?
  set -e
  stop_ticker
  [ "$_ro_rc" = 0 ] || die "task local:setup failed — fix the cause, then re-run."
  end_step "onboarding done"
}

# run_stack — the group wrapper matters more than it looks: devenv up -d forks the
# process-compose supervisor from THIS process, so it inherits our credentials for the
# life of the stack. Bringing it up half-privileged poisons every fleet operation until
# the stack is torn down and the user logs in again. sudo -u re-runs initgroups, which
# installs the complete current group set in one call, and the wrapper re-checks before
# committing rather than assuming it worked.
run_stack() {
  _rs_cmd="$1"
  if [ -z "$PENDING_GROUPS" ]; then
    devenv_run "$_rs_cmd"
    return $?
  fi

  log "activating new group membership ($PENDING_GROUPS) for the stack supervisor"
  # the stale-groups code arrives as $3 rather than a literal: this block is single-quoted, so
  # an inlined 78 could silently drift from RC_GROUPS_STALE, which the caller compares against
  _rs_inner='cd "$1" || exit 1
for g in libvirt kvm docker; do
  id -nG "$(id -un)" 2>/dev/null | tr " " "\n" | grep -qx "$g" || continue
  id -nG 2>/dev/null | tr " " "\n" | grep -qx "$g" || exit "$3"
done
exec devenv --no-tui shell -- sh -c "$2"'

  # env with an explicit HOME/PATH beats sudo -E, which default sudoers refuses without a
  # SETENV tag, and sidesteps secure_path. Dropping SUDO_* keeps sudo's bookkeeping out of
  # the long-lived supervisor, whose hostpaths:setup task chowns to SUDO_UID:SUDO_GID.
  set +e
  if [ "$HAVE_TTY" = 1 ]; then
    sudo -u "$(id -un)" -- \
      env -u SUDO_USER -u SUDO_UID -u SUDO_GID -u SUDO_COMMAND \
      HOME="$HOME" PATH="$PATH" \
      sh -c "$_rs_inner" _ "$TARGET_DIR" "$_rs_cmd" "$RC_GROUPS_STALE" </dev/tty
  else
    sudo -u "$(id -un)" -- \
      env -u SUDO_USER -u SUDO_UID -u SUDO_GID -u SUDO_COMMAND \
      HOME="$HOME" PATH="$PATH" \
      sh -c "$_rs_inner" _ "$TARGET_DIR" "$_rs_cmd" "$RC_GROUPS_STALE"
  fi
  _rs_rc=$?
  set -e

  if [ "$_rs_rc" = "$RC_GROUPS_STALE" ]; then
    stop_and_instruct_relogin
  fi
  return $_rs_rc
}

# stop_and_instruct_relogin — a planned checkpoint, not a failure, so exit 0. Everything
# before this point is idempotent, which is what makes "just run it again" cheap.
stop_and_instruct_relogin() {
  stop_keepalive
  printf '\n'
  log "one more step — new group membership needs a fresh login"
  info "You were added to: $PENDING_GROUPS"
  info "Group membership does not apply to an already-running session."
  printf '\n'
  info "Log out and back in (or reboot), then re-run the same command."
  info "Everything already done — clone, Nix, devenv, OS packages — is cached,"
  info "so the re-run resumes from here."
  printf '\n'
  exit 0
}

# ---------------------------------------------------------------- epilogue

print_ready_but_stopped() {
  printf '\n'
  log "environment ready at $TARGET_DIR"
  info "Bring the stack up with:"
  info "  cd $TARGET_DIR && devenv --no-tui shell -- task up"
  print_shell_note
}

print_shell_note() {
  printf '\n'
  info "The bootstrap added the direnv hook to your shell rc, but neither this"
  info "installer nor your current terminal benefits from it. Open a NEW terminal"
  info "and cd into $TARGET_DIR — the toolchain then loads automatically."
  info "Until then, reach the tools with: devenv --no-tui shell -- task <verb>"
  printf '\n'
}

print_epilogue() {
  printf '\n'
  log "stack is up ${C_DIM}(total $(elapsed "$RUN_START"))${C_RESET}"
  info "control center   http://localhost:5175"
  info "hub web          http://localhost:5173"
  info "hub API          http://localhost:3000"
  info "spoke            http://localhost:8000"
  printf '\n'
  info "sign in with     brokkr@brokkr.local / brokkr"
  printf '\n'
  info "task status      what is running"
  info "task logs        live process view"
  info "task up          reconcile a wedged stack (idempotent)"
  info "task down        stop everything"
  print_shell_note
}

# ---------------------------------------------------------------- main

main() {
  setup_colors
  # devenv starts an interactive TUI whenever stdout is a terminal, and that render loop can spin
  # at 100% CPU indefinitely — the reported "hang". Passing --no-tui to our own calls is not
  # enough: `task local:setup` runs `devenv tasks run` and stack-up runs `devenv up -d`, neither
  # of which we control. The env var is what reaches those.
  DEVENV_TUI=false
  export DEVENV_TUI
  parse_args "$@"
  # one trap for every background loop, installed before anything can spawn one
  trap 'cleanup' EXIT INT TERM
  init_phase_state
  RUN_START="$(date +%s)"
  detect_host
  detect_tty
  # before print_plan so the plan shows the absolute path the clone will really land in, and
  # so a bad parent directory fails before anything is installed
  resolve_target_dir
  # after resolve_target_dir and before print_plan: the plan must name the URL the run will really
  # clone, and an unusable key must fail before the sudo prompt, not after the OS packages
  resolve_ssh_key

  print_plan
  confirm
  prime_sudo || true

  ensure_pre_clone_deps
  stop_here deps && exit 0

  clone_or_adopt
  stop_here clone && exit 0

  run_bootstrap
  stop_here bootstrap && exit 0

  activate_nix_path
  stop_here path && exit 0

  find_pending_groups
  wait_for_docker
  stop_here ready && exit 0

  warm_devenv
  run_onboarding

  if [ -n "$NO_UP" ]; then
    print_ready_but_stopped
    exit 0
  fi

  if ! can_run_up; then
    warn "no terminal and no passwordless sudo — skipping the stack bring-up."
    print_ready_but_stopped
    exit 0
  fi

  begin_step_quiet "bringing up the stack (datastores, hub, spoke, control center, fleet)"
  set +e
  run_stack 'task up'
  _up_rc=$?
  set -e
  stop_ticker
  if [ "$_up_rc" != 0 ]; then
    warn "the stack did not come up cleanly."
    info "  cd $TARGET_DIR && devenv --no-tui shell -- task status   # what is down"
    info "  cd $TARGET_DIR && devenv --no-tui shell -- task logs     # why"
    info "  cd $TARGET_DIR && devenv --no-tui shell -- task up       # reconcile (idempotent)"
    exit 1
  fi
  end_step "stack up"

  stop_keepalive
  print_epilogue
}

# tests source this file to exercise single functions; only a real invocation runs main
[ "${BROKKR_INSTALL_LIB:-}" = 1 ] || main "$@"
