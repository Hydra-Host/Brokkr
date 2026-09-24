#!/usr/bin/env bash
# Blocking preflight gate for the two ports devenv RESERVES during `devenv up`'s evaluation.
# Its services.{postgres,redis} modules declare processes.<n>.ports.main.allocate, and devenv.yaml
# sets strict_ports, so a foreign listener on either port aborts the evaluation before any process
# starts — the caller sees ~600 lines of Nix trace ending in "Port N is already in use". Catching it
# here turns that into one named fault with a remedy. Every other stack port is plain config text:
# a conflict there crashes one process at bring-up, which stack readiness already reports.
#
# Called from modules/polyrepo.nix (the setup:preflight gate AND task doctor), which splices the
# numbers from config.ports.* — never P.ports.*, which resolves through ports.nix `allocated` to the
# allocator primop itself and would return the shifted port rather than the intended one.
#
# No `set -e`: every port must be probed, so one fault never hides the next.
set -u

# the ownership matchers + REAP_LSOF live here; sourcing is supported (its tail is $0-guarded) and
# sets found/reaped/REAP, so nothing below reuses those three names.
. "$(dirname "${BASH_SOURCE[0]}")/reap-stale.sh"

ROOT="${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"
SLOT="${1:-0}"
shift || true

pg_blocked=0
pg_suggested=""

# A bind probe, not an lsof read, is the authority. Two measured reasons: a probe of 127.0.0.1
# SUCCEEDS while another process holds the same port on a LAN address (so it misses the conflict a
# wildcard bind will hit), and lsof as a normal user does not reliably attribute a socket owned by
# root or _postgres on macOS, so a PID-only gate passes and lets the refusal happen anyway.
# No SO_REUSEADDR, and no listen() — bind alone raises EADDRINUSE, and listening on a non-loopback
# address is what makes the macOS application firewall prompt.
port_free() { # <port> → 0 when nothing holds it
  python3 - "$1" <<'PROBE'
import errno, socket, sys

TOLERATED = (errno.EADDRNOTAVAIL, errno.EAFNOSUPPORT)
port = int(sys.argv[1])
for family, addr in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::1")):
    try:
        s = socket.socket(family, socket.SOCK_STREAM)
    except OSError:
        continue
    try:
        s.bind((addr, port))
    except OSError as e:
        # a host with no IPv6, or no such address, is not a conflict
        if family is socket.AF_INET6 and e.errno in TOLERATED:
            continue
        sys.exit(1)
    finally:
        s.close()
sys.exit(0)
PROBE
}

holder_pid() { # <port> → the listening pid, empty when none is visible
  "${REAP_LSOF:-lsof}" -nP -iTCP:"$1" -sTCP:LISTEN -t 2>/dev/null | head -n 1
}

# datastore_owned_by is reap-stale.sh's own rule: an ours-orphan verdict here is handed straight to
# reap_datastores, so a second copy that drifted would reap what the reaper then skips.
owner_class() { # <pid> → ours-live | ours-orphan | foreign
  local pid="$1" cmd cwd
  cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
  cwd="$(proc_cwd "$pid")"
  if ! datastore_owned_by "$cmd" "$cwd" "$ROOT"; then
    printf 'foreign'
    return 0
  fi
  if pc_ancestored "$pid"; then printf 'ours-live'; else printf 'ours-orphan'; fi
}

# macOS `ps -o command=` renders an embedded newline as a literal \012 and pads lstart, so a
# command line can arrive as one unreadable paragraph. Squash and clip it — the point of the line
# is to let the reader recognize the program, not to reproduce its argv.
one_line() { # <text> [width]
  printf '%s' "$1" | tr '\t' ' ' | sed 's/\\012/ /g; s/  */ /g; s/^ //; s/ $//' |
    cut -c "1-${2:-110}"
}

# The shorthand env pin for ports.<label>, read from the alias catalog rather than hardcoded here,
# so the two files cannot drift. Empty when the knob has no shorthand.
pin_var() { # <label>
  sed -n "s/^\(BROKKR_PIN_[A-Z0-9_]*\)=ports\.$1\$/\1/p" \
    "$ROOT/devenv/env-pin-aliases.txt" 2>/dev/null | head -n 1
}

# A concrete free port beats "pick one": the operator pastes the remedy instead of guessing.
# 44000 up is the only safe band to suggest from. Every stack slot owns 500 ports at
# 20000 + 500*slot (modules/ports.nix), so slot 46 reaches 43499 — a naive port+10000 can land
# inside a sibling slot's block and conflict the day that checkout comes up. 49152 is where macOS
# starts allocating ephemeral ports, so the suggestion stays below it.
# pg_suggested keeps two conflicting datastores from being handed the same replacement port. The
# caller records the answer, because a command substitution runs this in a subshell.
suggest_port() {
  local try
  for try in 44000 44001 44002 44003; do
    case " $pg_suggested " in *" $try "*) continue ;; esac
    if port_free "$try"; then
      printf '%s' "$try"
      return 0
    fi
  done
  printf '44000'
}

report_conflict() { # <label> <port> <pid-or-empty>
  local label="$1" port="$2" pid="$3" cmd="" started="" pin free
  pg_blocked=$((pg_blocked + 1))
  pin="$(pin_var "$label")"
  free="$(suggest_port)"
  pg_suggested="$pg_suggested $free"

  if [ -n "$pid" ]; then
    cmd="$(ps -o command= -p "$pid" 2>/dev/null)"
    started="$(one_line "$(ps -o lstart= -p "$pid" 2>/dev/null)" 40)"
    printf '✗ port %s (%s, stack slot %s) is held by another program — PID %s\n' \
      "$port" "$label" "$SLOT" "$pid"
    [ -z "$cmd" ] || printf '    %s\n' "$(one_line "$cmd")"
    [ -z "$started" ] || printf '    started %s\n' "$started"
  else
    # occupied but unattributable: almost always a server running as root or its own service user
    printf '✗ port %s (%s, stack slot %s) is in use — the owner is not visible to this user\n' \
      "$port" "$label" "$SLOT"
    printf '    identify it:  sudo lsof -nP -iTCP:%s -sTCP:LISTEN\n' "$port"
  fi

  printf '\n'
  printf '    This stack reserves %s while it evaluates, so the bring-up cannot start.\n' "$port"
  printf '    Pick one, then re-run '\''task up'\'':\n\n'

  printf '      1. Stop the other program. It is not part of this stack:\n'
  case "$cmd" in
  */homebrew/* | */Cellar/*) printf '             brew services list        # find it, then: brew services stop <name>\n' ;;
  esac
  if [ -n "$pid" ]; then printf '             kill %s\n' "$pid"; fi

  printf '\n      2. Move this stack'\''s %s to a free port:\n' "$label"
  if [ -n "$pin" ]; then
    printf '             %s=%s task up\n' "$pin" "$free"
    printf '         To keep it without the variable, add one line to devenv.local.nix:\n'
  else
    printf '         Add one line to devenv.local.nix:\n'
  fi
  printf '             { ... }: { ports.%s = %s; }\n' "$label" "$free"

  printf '\n      3. Move the whole stack onto its own port block.\n'
  if [ -f "${DEVENV_STATE:-}/stack-slot-applied" ]; then
    # this checkout already came up on its slot, so the slot's disk state has to migrate first
    printf '         This checkout already came up on slot %s, so migrate it:\n' "$SLOT"
    printf '             task stack:reslot        # destructive: tears slot %s down\n' "$SLOT"
    printf '             printf '\''{ ... }: { stack.slot = %s; }\\n'\'' >> devenv.local.nix\n' "$((SLOT + 1))"
    printf '             task up\n'
  else
    printf '         Add one line to devenv.local.nix, then re-run '\''task up'\'':\n'
    printf '             { ... }: { stack.slot = %s; }\n' "$((SLOT + 1))"
  fi

  printf '\n'
  printf '    devenv will also suggest --strict-ports=false. Do not use it here. The slot map in\n'
  printf '    devenv/modules/ports.nix is this repo'\''s port contract, and an auto-allocated\n'
  printf '    datastore port desynchronizes the hub DATABASE_URL, the spoke and the registry.\n'
}

check_port() { # <label:port>
  local spec="$1" label port pid class
  label="${spec%%:*}"
  port="${spec##*:}"
  case "$port" in '' | *[!0-9]*)
    printf '⚠ port-guard: ignoring malformed spec %s\n' "$spec"
    return 0
    ;;
  esac

  if port_free "$port"; then
    printf '✓ port %s (%s) is free\n' "$port" "$label"
    return 0
  fi

  pid="$(holder_pid "$port")"
  class=foreign
  [ -z "$pid" ] || class="$(owner_class "$pid")"

  case "$class" in
  ours-live)
    printf '✓ port %s (%s) is held by this stack (PID %s)\n' "$port" "$label" "$pid"
    ;;
  ours-orphan)
    # our own datastore outliving its supervisor. reap_datastores owns this class; it spares
    # anything still under process-compose, so the ours-live branch above is never reached here.
    printf '⚠ port %s (%s) is held by an unsupervised datastore of this checkout (PID %s)\n' \
      "$port" "$label" "$pid"
    reap_datastores 0 "$ROOT"
    if port_free "$port"; then
      printf '✓ port %s (%s) is free after the reap\n' "$port" "$label"
    else
      printf '✗ port %s (%s) is still held after the reap — stop it by hand: kill %s\n' \
        "$port" "$label" "$pid"
      pg_blocked=$((pg_blocked + 1))
    fi
    ;;
  *)
    report_conflict "$label" "$port" "$pid"
    ;;
  esac
}

for _pg_spec in "$@"; do
  check_port "$_pg_spec"
done

[ "$pg_blocked" = 0 ] || exit 1
exit 0
