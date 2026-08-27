# shellcheck shell=bash
# this file has no shebang by design — sim-priv.nix readFile-concatenates it into a
# writeShellApplication (which supplies `#!/usr/bin/env bash` + set -euo pipefail); the directive
# above just tells shellcheck the dialect.
#
# brokkr-sim-priv — the sole privileged helper for the local-sim fleet.
#
# Invoked as root through a bare-path NOPASSWD sudoers rule (modules/sudo.nix), so the
# sudoers layer does ZERO argument filtering — every guard below IS the security boundary.
# sudo-rs (Ubuntu 25.10+) forbids non-trailing wildcards, so the old per-op arg-globs
# (rm -rf /home/*/.../ipmi-sim/*, chown * /opt/brokkr, pkill -f *lan.conf, …) can't be
# expressed there anyway; routing every generic op through this helper both fixes that and
# tightens scope (containment is enforced in code, not by fnmatch — which also matches / and ..).
#
# Invariants kept by every verb:
#   * default-deny dispatch with exact per-verb arity (the dispatcher never forwards "$@");
#   * file/dir args are canonicalised (parent-chain symlinks resolved via cd+pwd -P —
#     cross-platform, no GNU realpath) and re-validated UNDER the calling user's home before
#     any mutation; the raw argument is never passed to a tool, and a symlink leaf is rejected;
#   * canonical paths are absolute (/-leading), so no operand can be misparsed as an option —
#     that, not "--" (whose BSD support is uneven), is what blocks option injection;
#   * tools resolve to absolute paths from a fixed candidate set (PATH-independent — env_reset);
#   * IPv4 / pid / unit inputs match anchored patterns or a fixed allowlist.
#
# Accepted residuals on a single-user dev box (a user with this NOPASSWD grant is root-capable
# by construction): a same-user TOCTOU swap of an intermediate directory component after
# canonicalisation is not closed in bash; and ipmi_sim runs as root reading a user-owned
# lan.conf, so its chassis_control shell-out is an inherent local-root vector (ipmi-launch
# only constrains WHERE -c points, not the file's contents). Fully closing either needs a
# compiled openat2 helper / rootless ipmi_sim — tracked separately.

set -euo pipefail
set -f # noglob: an unquoted '*' in any value can't undergo pathname expansion as root
IFS=$' \t\n'

PROG=brokkr-sim-priv
IPMI_SIM="${IPMI_SIM:-}" # pinned /nix/store ipmi_sim path; injected by sim-priv.nix, used only by ipmi-launch
FLOCK="${FLOCK:-}"       # pinned /nix/store flock path (linux); injected by sim-priv.nix, used only by _bootptab_lock

die() {
  printf '%s: %s\n' "$PROG" "$1" >&2
  exit "${2:-1}"
}

# First existing+executable candidate (PATH-independent under env_reset).
_abs() {
  local c
  for c in "$@"; do [ -x "$c" ] && {
    printf '%s' "$c"
    return 0
  }; done
  die "required tool not found (tried: $*)" 70
}

RM=$(_abs /bin/rm /usr/bin/rm)
CHMOD=$(_abs /bin/chmod /usr/bin/chmod)
MKDIR=$(_abs /bin/mkdir /usr/bin/mkdir)
CHOWN=$(_abs /usr/sbin/chown /bin/chown /usr/bin/chown)
KILL=$(_abs /bin/kill /usr/bin/kill)
PKILL=$(_abs /usr/bin/pkill /bin/pkill)
PS=$(_abs /bin/ps /usr/bin/ps)
INSTALL=$(_abs /usr/bin/install /bin/install)
SED=$(_abs /usr/bin/sed /bin/sed)

is_macos() { [ "$(uname)" = Darwin ]; }

caller="${SUDO_USER:?run via sudo (SUDO_USER unset)}"

_homedir() {
  local line
  if is_macos; then
    local dscl
    dscl=$(_abs /usr/bin/dscl)
    line=$("$dscl" . -read "/Users/$caller" NFSHomeDirectory 2>/dev/null) || true
    printf '%s' "${line#NFSHomeDirectory: }"
  else
    local getent
    getent=$(_abs /usr/bin/getent /bin/getent)
    "$getent" passwd "$caller" 2>/dev/null | cut -d: -f6
  fi
}

home_raw=$(_homedir)
{ [ -n "$home_raw" ] && [ -d "$home_raw" ]; } || die "cannot resolve home for '$caller'"
HOME_DIR=$(cd "$home_raw" && pwd -P) || die "home not accessible: $home_raw"

# Canonicalise a path: resolve symlinks in the PARENT chain (parent must exist), keep the leaf
# un-followed so a symlink leaf is rejectable. Cross-platform (no GNU `realpath -m/-e`).
_canon() {
  local arg="$1" parent base cparent
  parent=$(dirname -- "$arg")
  base=$(basename -- "$arg")
  case "$base" in '' | . | .. | /) return 1 ;; esac
  cparent=$(cd "$parent" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s' "$cparent" "$base"
}

# A canonical path must be strictly under the caller's home (never equal to it).
_under_home() {
  case "$1" in "$HOME_DIR"/*) return 0 ;; *) return 1 ;; esac
}

# Resolve a regular-file argument under home (rejects symlink leaf / non-files).
_resolve_file() {
  local canon
  canon=$(_canon "$1") || die "path parent does not exist: $1"
  _under_home "$canon" || die "refuse: outside \$HOME: $canon"
  [ -L "$canon" ] && die "refuse: symlink leaf: $canon"
  [ -f "$canon" ] || die "refuse: not a regular file: $canon"
  printf '%s' "$canon"
}

# Resolve a path under home for unlink (socket / maybe-absent); rejects a symlink leaf.
_resolve_loose() {
  local canon
  canon=$(_canon "$1") || die "path parent does not exist: $1"
  _under_home "$canon" || die "refuse: outside \$HOME: $canon"
  [ -L "$canon" ] && die "refuse: symlink leaf: $canon"
  printf '%s' "$canon"
}

# Resolve an existing directory under home (the directory itself is canonicalised).
_resolve_dir() {
  local canon
  canon=$(cd "$1" 2>/dev/null && pwd -P) || die "dir does not exist: $1"
  _under_home "$canon" || die "refuse: outside \$HOME: $canon"
  [ "$canon" = "$HOME_DIR" ] && die "refuse: home root: $canon"
  printf '%s' "$canon"
}

# Require .../ipmi-sim/<node> shape on an already-canonical dir.
_assert_ipmi_node_dir() {
  [ "$(basename -- "$(dirname -- "$1")")" = ipmi-sim ] || die "refuse: not an ipmi-sim/<node> dir: $1"
  [[ "$(basename -- "$1")" =~ ^[A-Za-z0-9._-]+$ ]] || die "refuse: bad node dir: $1"
}

# A bootptab section marker interpolates into a sed address — pin it to a charset with no
# sed/regex metacharacters so the delete-range below can't be escaped.
_assert_marker() {
  case "$1" in *[!A-Za-z0-9_-]* | "") die "bad marker: $1" 64 ;; esac
  printf '%s' "$1"
}

_valid_ipv4() {
  local ip="$1" o
  [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"; do
    [ "$o" -le 255 ] || return 1
  done
  return 0
}

# Escape regex metacharacters so `pkill -f` matches the path literally (covers BRE + ERE).
_ere_escape() {
  printf '%s' "$1" | "$SED" 's/[][(){}.^$*+?|\\]/\\&/g'
}

verb="${1:-}"
[ $# -ge 1 ] && shift

# serialize the section verbs' read-modify-write of /etc/bootptab across concurrent stacks;
# the fd-held lock releases when the helper exits (lockf fd mode / flock both work this way).
# lockf's fd mode takes the fd as its ONLY operand — any trailing word makes the fd a filename
# and the word a command, so it silently locks the wrong thing.
_bootptab_lock() {
  local lk=/var/run/brokkr-bootptab.lk
  exec 9>"$lk"
  if is_macos; then
    local lockf
    lockf=$(_abs /usr/bin/lockf)
    "$lockf" -t 10 9 || die "bootptab lock timeout or contention" 69
  else
    # the _abs fallback is load-bearing, not belt-and-braces: the tests run this file directly
    # under bash, without sim-priv.nix's preamble, so $FLOCK is unset there.
    local flock
    flock=${FLOCK:-$(_abs /usr/bin/flock /bin/flock /run/current-system/sw/bin/flock)}
    "$flock" -w 10 9 || die "bootptab lock timeout" 69
  fi
}

case "$verb" in
noop)
  # authorisation probe: succeeds only while a sudoers drop-in still pins THIS helper path
  [ $# -eq 0 ] || die "usage: noop" 64
  ;;

lo-add | lo-del)
  [ $# -eq 1 ] || die "usage: $verb <ipv4>" 64
  ip="$1"
  _valid_ipv4 "$ip" || die "invalid IPv4: $ip"
  if is_macos; then
    ifc=$(_abs /sbin/ifconfig /usr/sbin/ifconfig)
    if [ "$verb" = lo-add ]; then "$ifc" lo0 alias "$ip/32"; else "$ifc" lo0 -alias "$ip"; fi
  else
    ipbin=$(_abs /usr/sbin/ip /sbin/ip /bin/ip)
    if [ "$verb" = lo-add ]; then "$ipbin" addr add "$ip/32" dev lo; else "$ipbin" addr del "$ip/32" dev lo; fi
  fi
  ;;

ipmi-stop | ipmi-kill)
  [ $# -eq 1 ] || die "usage: $verb <lan.conf path>" 64
  raw="$1"
  lan=$(_resolve_file "$raw") # validate under home + regular file via the canonical path
  case "$lan" in */lan.conf) ;; *) die "refuse: not a lan.conf: $lan" ;; esac
  case "$lan" in *"/ipmi-sim/"*) ;; *) die "refuse: outside ipmi-sim tree: $lan" ;; esac
  # match the path as it appears in the ipmi_sim cmdline (the caller's string — same one the
  # Python-side pgrep liveness check uses); canonicalising here could diverge under a symlinked home.
  pat=$(_ere_escape "$raw")
  if [ "$verb" = ipmi-stop ]; then "$PKILL" -f "$pat" || true; else "$PKILL" -9 -f "$pat" || true; fi
  ;;

ipmi-purge)
  [ $# -eq 1 ] || die "usage: ipmi-purge <state dir>" 64
  dir=$(_resolve_dir "$1")
  _assert_ipmi_node_dir "$dir"
  "$RM" -rf "$dir"
  ;;

ipmi-launch)
  [ $# -eq 1 ] || die "usage: ipmi-launch <cfg dir>" 64
  raw="$1"
  dir=$(_resolve_dir "$raw") # validate under home + node-dir shape via the canonical path
  _assert_ipmi_node_dir "$dir"
  # exec with the caller's path (not the canonical one) so the resulting cmdline carries the
  # same lan.conf string the Python-side pgrep/pkill liveness + teardown match on.
  lan="$raw/lan.conf"
  emu="$raw/sim.emu"
  st="$raw/state"
  { [ -f "$lan" ] && [ ! -L "$lan" ]; } || die "refuse: missing/!regular lan.conf: $lan"
  { [ -f "$emu" ] && [ ! -L "$emu" ]; } || die "refuse: missing/!regular sim.emu: $emu"
  { [ -d "$st" ] && [ ! -L "$st" ]; } || die "refuse: missing state dir: $st"
  { [ -n "$IPMI_SIM" ] && [ -x "$IPMI_SIM" ]; } || die "ipmi_sim binary unavailable: '$IPMI_SIM'" 70
  # exec preserves the Popen-created session + the redirected log fds. The helper builds
  # -c/-f/-s itself, so a caller can no longer point ipmi_sim at an arbitrary -c outside the
  # per-node state dir (the lan.conf contents stay user-writable — an inherent residual).
  exec "$IPMI_SIM" -c "$lan" -f "$emu" -s "$st" -n
  ;;

console-prepare)
  [ $# -eq 1 ] || die "usage: console-prepare <log file>" 64
  f=$(_resolve_file "$1")
  : >"$f" # truncate in place (portable; macOS has no truncate(1))
  "$CHMOD" a+r "$f"
  ;;

console-readable)
  [ $# -eq 1 ] || die "usage: console-readable <log file>" 64
  f=$(_resolve_file "$1")
  "$CHMOD" a+r "$f"
  ;;

vmnet-stop)
  [ $# -eq 2 ] || die "usage: vmnet-stop <pidfile> <sock>" 64
  pidfile=$(_resolve_file "$1")
  pid=""
  read -r pid <"$pidfile" || true
  { [[ $pid =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; } || die "refuse: bad pid '$pid'"
  comm=$("$PS" -o comm= -p "$pid" 2>/dev/null || true)
  [ "$(basename -- "$comm")" = socket_vmnet ] || die "refuse: pid $pid is not socket_vmnet (comm='$comm')"
  "$KILL" -TERM "$pid" || true
  sock=$(_resolve_loose "$2")
  case "$(basename -- "$sock")" in socket_vmnet.*.sock) ;; *) die "refuse: not a socket_vmnet sock: $sock" ;; esac
  "$RM" -f "$sock"
  ;;

vmnet-sock-rm)
  [ $# -eq 1 ] || die "usage: vmnet-sock-rm <sock>" 64
  sock=$(_resolve_loose "$1")
  case "$(basename -- "$sock")" in socket_vmnet.*.sock) ;; *) die "refuse: not a socket_vmnet sock: $sock" ;; esac
  "$RM" -f "$sock"
  ;;

bootptab-install)
  [ $# -eq 1 ] || die "usage: bootptab-install <tmp file>" 64
  tmp=$(_resolve_file "$1")
  "$INSTALL" -m 644 -o root -g wheel "$tmp" /etc/bootptab
  ;;

bootptab-remove)
  [ $# -eq 0 ] || die "usage: bootptab-remove" 64
  "$RM" -f /etc/bootptab
  ;;

bootptab-section-install)
  # concurrent stacks share /etc/bootptab: replace only the caller's own marker section,
  # under an advisory lock so two slots' read-modify-write cycles can't lose a section
  [ $# -eq 2 ] || die "usage: bootptab-section-install <marker> <tmp file>" 64
  marker=$(_assert_marker "$1")
  tmp=$(_resolve_file "$2")
  _bootptab_lock
  cur=/etc/bootptab
  work=$(_resolve_loose "$(dirname -- "$tmp")/.bootptab.work")
  "$RM" -f "$work"
  if [ -f "$cur" ]; then
    "$SED" "/# >>> $marker\$/,/# <<< $marker\$/d" "$cur" >"$work"
  else
    printf '# Generated by local fleet:up. Do not edit by hand.\n%%%%\n' >"$work"
  fi
  CAT=$(_abs /bin/cat /usr/bin/cat)
  "$CAT" "$tmp" >>"$work"
  "$INSTALL" -m 644 -o root -g wheel "$work" "$cur"
  "$RM" -f "$work"
  ;;

bootptab-section-remove)
  [ $# -eq 1 ] || die "usage: bootptab-section-remove <marker>" 64
  marker=$(_assert_marker "$1")
  _bootptab_lock
  cur=/etc/bootptab
  [ -f "$cur" ] || exit 0
  work=$(_resolve_loose "$HOME_DIR/.bootptab.work.$$")
  "$RM" -f "$work"
  "$SED" "/# >>> $marker\$/,/# <<< $marker\$/d" "$cur" >"$work"
  GREP=$(_abs /usr/bin/grep /bin/grep)
  if ! "$GREP" -q '^# >>> brokkr-slot-' "$work"; then
    "$RM" -f "$cur" # last section removed — file goes away
    "$RM" -f "$work"
  else
    "$INSTALL" -m 644 -o root -g wheel "$work" "$cur"
    "$RM" -f "$work"
  fi
  ;;

bpf-grant | bpf-revoke)
  # Grant/revoke unprivileged /dev/bpf* for raw DHCP L2 (launchd owns :67 dgram → BPF is macOS's only
  # broadcast-DHCP path). Broad: raw capture on ALL host interfaces; owner 0600 on grant, root on revoke.
  is_macos || die "refuse: $verb is macos-only"
  [ $# -eq 0 ] || die "usage: $verb" 64
  [[ ${SUDO_UID:-} =~ ^[0-9]+$ ]] || die "refuse: bad SUDO_UID '${SUDO_UID:-}'"
  if [ "$verb" = bpf-grant ]; then owner="$SUDO_UID"; else owner=root; fi
  set +f # enable globbing to enumerate the kernel's fixed /dev/bpf* nodes
  matched=0
  for dev in /dev/bpf*; do
    [ -c "$dev" ] || continue # character-special only; also skips the un-expanded literal on no match
    "$CHOWN" "$owner" "$dev"
    # On grant: force 0600. On revoke: let ChmodBPF manage (forcing would permanently narrow mode).
    [ "$verb" = bpf-grant ] && "$CHMOD" 0600 "$dev"
    matched=1
  done
  set -f
  { [ "$matched" = 1 ] || [ "$verb" = bpf-revoke ]; } || die "no /dev/bpf* character devices found" 70
  ;;

vmnet-hostip)
  # socket_vmnet --vmnet-disable-dhcp assigns bridge .0 (API has no set-host-address); pin to .1
  # gateway so DHCP router/serverId + spoke HTTP live at a valid host IP. Netmask from fleet CIDR.
  is_macos || die "refuse: vmnet-hostip is macos-only"
  { [ $# -eq 1 ] || [ $# -eq 2 ]; } || die "usage: vmnet-hostip <gateway-ipv4> [netmask]" 64
  gw="$1"
  _valid_ipv4 "$gw" || die "invalid gateway IPv4: $gw"
  mask="${2:-255.255.255.0}"
  _valid_ipv4 "$mask" || die "invalid netmask: $mask"
  ifc=$(_abs /sbin/ifconfig /usr/sbin/ifconfig)
  GREP=$(_abs /usr/bin/grep /bin/grep) # only used in this branch
  net24="${gw%.*}"                     # first three octets, e.g. 192.168.200
  esc=$(_ere_escape "$net24")
  target=""
  for b in $("$ifc" -l 2>/dev/null); do
    case "$b" in bridge[0-9]*) ;; *) continue ;; esac
    if "$ifc" "$b" 2>/dev/null | "$GREP" -qE "inet ${esc}\.[0-9]+ "; then
      target="$b"
      break
    fi
  done
  [ -n "$target" ] || die "no bridge* interface found on ${net24}.0/x"
  # Idempotent: EEXIST (alias already present) is success. Propagate other errors (bad iface, permission, etc.).
  if ! addout=$("$ifc" "$target" inet "$gw" netmask "$mask" 2>&1); then
    case "$addout" in
    *"File exists"* | *"already"*) : ;; # alias already present — treat as success
    *) die "failed to add inet alias to ${target}: ${addout}" ;;
    esac
  fi
  ;;

svc-start)
  [ $# -eq 1 ] || die "usage: svc-start <unit>" 64
  unit="$1"
  case "$unit" in libvirtd | virtqemud.socket) ;; *) die "refuse: unit not allowed: $unit" ;; esac
  sctl=$(_abs /usr/bin/systemctl /bin/systemctl)
  "$sctl" start "$unit"
  ;;

memlock-raise)
  is_macos && die "refuse: memlock-raise is linux-only"
  [ $# -eq 1 ] || die "usage: memlock-raise <pid>" 64
  pid="$1"
  { [[ $pid =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ]; } || die "refuse: bad pid '$pid'"
  owner=$("$PS" -o uid= -p "$pid" 2>/dev/null | tr -d ' ') || true
  [ -n "$owner" ] || die "refuse: pid $pid not found"
  [ "$owner" = "${SUDO_UID:?}" ] || die "refuse: pid $pid not owned by caller (uid=$owner)"
  prlimit=$(_abs /usr/bin/prlimit /bin/prlimit)
  "$prlimit" --pid "$pid" --memlock=unlimited:unlimited
  ;;

bridge-ensure)
  # Create/refresh the flat L2 data-plane bridge (Linux).
  is_macos && die "refuse: bridge-ensure is linux-only"
  [ $# -eq 3 ] || die "usage: bridge-ensure <name> <gw-ipv4> <prefixlen>" 64
  name="$1"
  gw="$2"
  plen="$3"
  case "$name" in br-[A-Za-z0-9_-]*) ;; *) die "refuse: bridge name must match br-*: $name" ;; esac
  _valid_ipv4 "$gw" || die "invalid gateway IPv4: $gw"
  { [[ $plen =~ ^[0-9]+$ ]] && [ "$plen" -ge 1 ] && [ "$plen" -le 32 ]; } || die "refuse: bad prefixlen: $plen"
  ipbin=$(_abs /usr/sbin/ip /sbin/ip /bin/ip)
  "$ipbin" link show "$name" >/dev/null 2>&1 || "$ipbin" link add name "$name" type bridge
  "$ipbin" link set "$name" up
  "$ipbin" addr add "$gw/$plen" dev "$name" 2>/dev/null || true # re-add of an existing addr is a harmless EEXIST
  ;;

bridge-nat)
  # l2 bridge masquerade rules (Linux)
  is_macos && die "refuse: bridge-nat is linux-only"
  [ $# -eq 2 ] || die "usage: bridge-nat <bridge> <cidr>" 64
  br="$1"
  cidr="$2"
  case "$br" in br-[A-Za-z0-9_-]*) ;; *) die "refuse: bridge name must match br-*: $br" ;; esac
  case "$cidr" in */*)
    net="${cidr%/*}"
    plen="${cidr#*/}"
    ;;
  *) die "refuse: not a CIDR: $cidr" ;; esac
  _valid_ipv4 "$net" || die "invalid CIDR network: $cidr"
  { [[ $plen =~ ^[0-9]+$ ]] && [ "$plen" -ge 1 ] && [ "$plen" -le 32 ]; } || die "refuse: bad prefixlen in CIDR: $cidr"
  ipt=$(_abs /usr/sbin/iptables /sbin/iptables /usr/bin/iptables)
  sc=$(_abs /usr/sbin/sysctl /sbin/sysctl)
  "$sc" -w net.ipv4.ip_forward=1 >/dev/null
  "$ipt" -t nat -C POSTROUTING -s "$cidr" ! -d "$cidr" -j MASQUERADE 2>/dev/null ||
    "$ipt" -t nat -A POSTROUTING -s "$cidr" ! -d "$cidr" -j MASQUERADE
  # Scope the inbound accept to the data-plane subnet (anti-spoof; matches what libvirt's
  # <forward mode='nat'/> did) rather than accepting any src arriving on the bridge.
  "$ipt" -C FORWARD -i "$br" -s "$cidr" -j ACCEPT 2>/dev/null ||
    "$ipt" -I FORWARD 1 -i "$br" -s "$cidr" -j ACCEPT
  "$ipt" -C FORWARD -o "$br" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null ||
    "$ipt" -I FORWARD 2 -o "$br" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
  ;;

bridge-del)
  is_macos && die "refuse: bridge-del is linux-only"
  { [ $# -eq 1 ] || [ $# -eq 2 ]; } || die "usage: bridge-del <name> [cidr]" 64
  name="$1"
  case "$name" in br-[A-Za-z0-9_-]*) ;; *) die "refuse: bridge name must match br-*: $name" ;; esac
  ipt=$(_abs /usr/sbin/iptables /sbin/iptables /usr/bin/iptables)
  "$ipt" -D FORWARD -o "$name" -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT 2>/dev/null || true
  if [ $# -eq 2 ]; then
    cidr="$2"
    # Same anchored validation as bridge-nat — never hand an unvalidated string to iptables,
    # even on the delete path (keeps the helper's validate-before-touch invariant).
    case "$cidr" in */*)
      net="${cidr%/*}"
      plen="${cidr#*/}"
      ;;
    *) die "refuse: not a CIDR: $cidr" ;; esac
    _valid_ipv4 "$net" || die "invalid CIDR network: $cidr"
    { [[ $plen =~ ^[0-9]+$ ]] && [ "$plen" -ge 1 ] && [ "$plen" -le 32 ]; } || die "refuse: bad prefixlen in CIDR: $cidr"
    # -s "$cidr" mirrors the scoped FORWARD accept bridge-nat installs.
    "$ipt" -D FORWARD -i "$name" -s "$cidr" -j ACCEPT 2>/dev/null || true
    "$ipt" -t nat -D POSTROUTING -s "$cidr" ! -d "$cidr" -j MASQUERADE 2>/dev/null || true
  fi
  ipbin=$(_abs /usr/sbin/ip /sbin/ip /bin/ip)
  if "$ipbin" link show "$name" >/dev/null 2>&1; then "$ipbin" link del "$name"; fi
  ;;

cap-net-bind)
  is_macos && die "refuse: cap-net-bind is linux-only"
  [ $# -eq 2 ] || die "usage: cap-net-bind <src-node-binary> <dest-path-under-home>" 64
  [[ ${SUDO_UID:-} =~ ^[0-9]+$ ]] || die "refuse: bad SUDO_UID '${SUDO_UID:-}'"
  [[ ${SUDO_GID:-} =~ ^[0-9]+$ ]] || die "refuse: bad SUDO_GID '${SUDO_GID:-}'"
  src="$1"
  { [ -f "$src" ] && [ ! -L "$src" ] && [ -x "$src" ]; } || die "refuse: src not an executable regular file: $src"
  destdir=$(dirname -- "$2")
  destbase=$(basename -- "$2")
  case "$destbase" in '' | . | .. | /) die "refuse: bad dest basename: $2" ;; esac
  [[ $destbase =~ ^[A-Za-z0-9._-]+$ ]] || die "refuse: bad dest basename: $2"
  # Reject any `..` segment before the ancestor walk: a deep existing prefix + `..` chain could
  # otherwise let `mkdir -p` resolve out of $HOME and create a dir outside it before the post-mkdir
  # _under_home check rejects the op (the dir side-effect would persist).
  case "/$2/" in */../*) die "refuse: dest outside \$HOME (path traversal): $2" ;; esac
  anc="$destdir"
  while [ ! -d "$anc" ]; do
    anc=$(dirname -- "$anc")
    [ "$anc" = / ] && die "refuse: no existing ancestor for dest: $2"
  done
  canc=$(cd "$anc" && pwd -P) || die "refuse: dest ancestor unusable: $anc"
  _under_home "$canc" || die "refuse: dest outside \$HOME: $2"
  "$MKDIR" -p "$destdir"
  cdest=$(cd "$destdir" 2>/dev/null && pwd -P) || die "refuse: dest dir unusable: $destdir"
  _under_home "$cdest" || die "refuse: dest outside \$HOME: $cdest"
  dest="$cdest/$destbase"
  [ -L "$dest" ] && die "refuse: dest is a symlink: $dest"
  cp=$(_abs /bin/cp /usr/bin/cp)
  setcap=$(_abs /usr/sbin/setcap /sbin/setcap /bin/setcap)
  mktemp=$(_abs /usr/bin/mktemp /bin/mktemp)
  mv=$(_abs /bin/mv /usr/bin/mv)
  # Close the TOCTOU between the symlink check and the write: stage into a fresh temp inode inside
  # the already-canonicalised+$HOME-checked $cdest, mutate ownership/perms/caps on the temp, then
  # atomically rename into place. `mv` in the same dir is rename(2) — it replaces whatever sits at
  # $dest (including a symlink an attacker plants in the window) WITHOUT following it, and preserves
  # the security.capability xattr (same inode). Template basename is a fixed literal, not attacker-fed.
  tmp=$("$mktemp" "$cdest/.node.XXXXXX") || die "refuse: cannot create temp in dest dir: $cdest"
  "$cp" -f "$src" "$tmp"
  "$CHOWN" "$SUDO_UID:$SUDO_GID" "$tmp"
  "$CHMOD" 0755 "$tmp"
  "$setcap" cap_net_bind_service,cap_net_raw=+ep "$tmp"
  "$mv" -f "$tmp" "$dest"
  ;;

hostpath-setup)
  [ $# -eq 0 ] || die "usage: hostpath-setup" 64
  [[ ${SUDO_UID:-} =~ ^[0-9]+$ ]] || die "refuse: bad SUDO_UID '${SUDO_UID:-}'"
  [[ ${SUDO_GID:-} =~ ^[0-9]+$ ]] || die "refuse: bad SUDO_GID '${SUDO_GID:-}'"
  [ -d /opt/brokkr ] || "$RM" -f /opt/brokkr # clear a stale non-dir (dangling symlink/file); never rm a live dir
  "$MKDIR" -p /opt/brokkr
  { [ -d /opt/brokkr ] && [ ! -L /opt/brokkr ]; } || die "refuse: /opt/brokkr is not a dir"
  "$CHOWN" "$SUDO_UID:$SUDO_GID" /opt/brokkr
  ;;

dropin-current)
  # The caller cannot stat /etc/sudoers.d where it is 0750 (Fedora, Arch), so answer as root.
  # Exit 3, never 1: sudo also returns 1 refusing -n, and the caller must tell those apart.
  [ $# -eq 2 ] || die "usage: dropin-current <name> <candidate>" 64
  case "$1" in brokkr-sim*) ;; *) die "bad drop-in name: $1" 64 ;; esac
  case "$1" in *[!A-Za-z0-9_-]* | "") die "bad drop-in name: $1" 64 ;; esac
  cand=$(_resolve_file "$2")
  # a legacy unhashed drop-in shadows every hashed one, and the caller's own check for it is
  # blind wherever /etc/sudoers.d denies search
  if [ -e /etc/sudoers.d/brokkr-sim ] && [ "$1" != brokkr-sim ]; then exit 3; fi
  if [ ! -f "/etc/sudoers.d/$1" ]; then exit 3; fi
  # $(<) is a bash builtin: diffutils is absent from a minimal Fedora, and this verb may not
  # trust PATH. It strips trailing newlines on both sides, which one generator renders alike.
  installed=$(<"/etc/sudoers.d/$1")
  candidate=$(<"$cand")
  if [ "$installed" != "$candidate" ]; then exit 3; fi
  ;;

*)
  die "unknown verb: '${verb:-}'" 64
  ;;
esac
