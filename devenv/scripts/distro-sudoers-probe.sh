#!/usr/bin/env bash
# Exercise the REAL brokkr-sim-priv `dropin-current` verb against a REAL distro whose
# /etc/sudoers.d denies search to an unprivileged user (0750 on Fedora and Arch, 0755 on macOS and
# the apt family). Nothing else in the repo covers that: the CI toolchain image ships no sudo and
# no /etc/sudoers.d, and the one real-host job reimplements privileged ops with plain sudo.
#
# Usage: distro-sudoers-probe.sh <docker image>          (needs a working docker daemon)
# Every line it prints is `PASS <name>` or `FAIL <name> …`; it exits non-zero on any FAIL.
#
# sim-priv.sh resolves every tool it might need at startup, so a single missing binary (pkill on a
# minimal Fedora) makes even `noop` exit 70. The probe installs those first.
#
# The helper is shipped in over stdin rather than a bind mount: the daemon commonly runs in a VM
# (Docker Desktop, colima), where a host path is not visible to the container.
set -euo pipefail

image=${1:?usage: distro-sudoers-probe.sh <docker image>}
here=$(cd "$(dirname "$0")" && pwd -P)
helper="$here/../pkgs/sim-priv.sh"
[ -f "$helper" ] || {
  echo "FAIL setup helper not found at $helper" >&2
  exit 1
}

# amd64 explicitly: Arch publishes no arm64 image, so an Apple-Silicon host emulates it.
exec docker run --rm -i --platform linux/amd64 "$image" bash -s -- "$(base64 <"$helper" | tr -d '\n')" <<'PROBE'
set -u
b64=$1
say() { printf '%s %s\n' "$1" "$2"; }
fails=0
ok() { if [ "$1" = "$2" ]; then say PASS "$3"; else say FAIL "$3 (want $1, got $2)"; fails=$((fails + 1)); fi; }

need=
for t in useradd runuser sudo base64 stat pkill ps; do command -v "$t" >/dev/null 2>&1 || need=1; done
if [ -n "$need" ]; then
  if command -v dnf >/dev/null 2>&1; then dnf -q install -y shadow-utils util-linux sudo coreutils procps-ng >/dev/null 2>&1; fi
  if command -v pacman >/dev/null 2>&1; then pacman -S --noconfirm --needed shadow util-linux sudo coreutils procps-ng >/dev/null 2>&1; fi
fi
for t in useradd runuser sudo base64 stat pkill ps; do
  command -v "$t" >/dev/null 2>&1 || { say FAIL "setup $t unavailable on this image"; exit 1; }
done
id dev >/dev/null 2>&1 || useradd -m dev

store=/nix/store/aaaaaaaaaaaa1111-brokkr-sim-priv/bin
mkdir -p "$store"
printf '%s' "$b64" | base64 -d >"$store/brokkr-sim-priv"
chmod 0755 "$store/brokkr-sim-priv"
H="$store/brokkr-sim-priv"
NAME=brokkr-sim-aaaaaaaaaaaa

mkdir -p /etc/sudoers.d
printf 'dev ALL=(root) NOPASSWD: %s\n' "$H" >"/etc/sudoers.d/$NAME"
chmod 0440 "/etc/sudoers.d/$NAME"
printf 'dev ALL=(root) NOPASSWD: %s\n' "$H" >/home/dev/render
chown dev:dev /home/dev/render

ok 750 "$(stat -c %a /etc/sudoers.d)" "canary /etc/sudoers.d is still 0750 on this image"

as_dev() { runuser -u dev -- bash -c "$1" >/dev/null 2>&1; echo $?; }

ok 1 "$(as_dev "test -e /etc/sudoers.d/$NAME")" "an unprivileged test -e cannot see the drop-in"
ok 0 "$(as_dev "sudo -n $H noop")" "the NOPASSWD grant works"
ok 0 "$(as_dev "sudo -n $H dropin-current $NAME /home/dev/render")" "the verb reports a matching drop-in as current"

printf 'dev ALL=(root) NOPASSWD: /usr/bin/false\n' >/home/dev/stale
chown dev:dev /home/dev/stale
ok 3 "$(as_dev "sudo -n $H dropin-current $NAME /home/dev/stale")" "a differing render is not current, and exits 3 not 1"
ok 3 "$(as_dev "sudo -n $H dropin-current brokkr-sim-zzzzzzzzzzzz /home/dev/render")" "an absent drop-in is not current"

: >/etc/sudoers.d/brokkr-sim
chmod 0440 /etc/sudoers.d/brokkr-sim
ok 3 "$(as_dev "sudo -n $H dropin-current $NAME /home/dev/render")" "a legacy unhashed drop-in is reported as not current"
rm -f /etc/sudoers.d/brokkr-sim

ok 64 "$(as_dev "sudo -n $H dropin-current ../shadow /home/dev/render")" "a name escaping the directory is refused"
ok 64 "$(as_dev "sudo -n $H dropin-current $NAME")" "a missing candidate argument is refused"
ok 1 "$(as_dev "sudo -n $H dropin-current $NAME /etc/shadow")" "a candidate outside the caller home is refused"

[ "$fails" -eq 0 ] || exit 1
PROBE
