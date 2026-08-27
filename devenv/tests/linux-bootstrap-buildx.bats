
setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  . devenv/lib/bats-helpers.bash
  . apps/local-sim/provisioning/linux-bootstrap.sh

  export HOME="$BATS_TEST_TMPDIR/home"
  export DOCKER_CONFIG="$BATS_TEST_TMPDIR/docker"
  export DEVENV_ROOT="$BATS_TEST_TMPDIR/repo"
  export PKGLOG="$BATS_TEST_TMPDIR/pkg.log"
  export BUILDX_OK="$BATS_TEST_TMPDIR/buildx-ok"
  export APT_AVAILABLE=""
  mkdir -p "$HOME" "$DEVENV_ROOT/.devenv/profile/bin"

  mock_bin sudo 'exec "$@"'
  mock_bin systemctl 'exit 0'
  mock_bin docker '
if [ "$1" = buildx ] && [ "$2" = version ]; then
  [ -f "$BUILDX_OK" ] || exit 1
  echo "github.com/docker/buildx v0.14.0"
fi
exit 0'
  mock_bin apt-get '
printf "%s\n" "$*" >>"$PKGLOG"
case " ${APT_AVAILABLE:-} " in
*" $4 "*)
  : >"$BUILDX_OK"
  exit 0
  ;;
esac
exit 100'
}

profile_buildx() {
  printf '%s\n' "$DEVENV_ROOT/.devenv/profile/bin/docker-buildx"
}

plugin_link() {
  printf '%s\n' "$DOCKER_CONFIG/cli-plugins/docker-buildx"
}

install_profile_buildx() {
  printf 'stub\n' >"$(profile_buildx)"
  chmod +x "$(profile_buildx)"
}

@test "an already-present plugin installs nothing and links nothing" {
  : >"$BUILDX_OK"
  install_profile_buildx

  run ensure_docker_buildx apt

  [ "$status" -eq 0 ]
  [ ! -f "$PKGLOG" ]
  [ ! -e "$(plugin_link)" ]
}

@test "the first apt name that resolves satisfies the plugin without a symlink" {
  export APT_AVAILABLE="docker-buildx"
  install_profile_buildx

  run ensure_docker_buildx apt

  [ "$status" -eq 0 ]
  [ "$(grep -c . "$PKGLOG")" -eq 1 ]
  grep -q 'docker-buildx$' "$PKGLOG"
  [ ! -e "$(plugin_link)" ]
}

@test "both apt names failing falls back to the devenv profile binary" {
  install_profile_buildx

  run ensure_docker_buildx apt

  [ "$status" -eq 0 ]
  [ "$(grep -c . "$PKGLOG")" -eq 2 ]
  grep -q 'docker-buildx-plugin$' "$PKGLOG"
  [ -L "$(plugin_link)" ]
  [ "$(readlink "$(plugin_link)")" = "$(profile_buildx)" ]
}

@test "a dangling plugin symlink is repointed at the live profile path" {
  install_profile_buildx
  mkdir -p "$DOCKER_CONFIG/cli-plugins"
  ln -s "$BATS_TEST_TMPDIR/rotated-away" "$(plugin_link)"

  run ensure_docker_buildx apt

  [ "$status" -eq 0 ]
  [ "$(readlink "$(plugin_link)")" = "$(profile_buildx)" ]
  [ -x "$(plugin_link)" ]
}

@test "no package and no profile binary prints the manual step and still returns 0" {
  run ensure_docker_buildx apt

  [ "$status" -eq 0 ]
  [[ "$output" == *"cli-plugins/docker-buildx"* ]]
  [ ! -e "$(plugin_link)" ]
}

@test "a wedged docker daemon does not hang the bootstrap" {
  mock_bin docker '
if [ "$1" = buildx ] && [ "$2" = version ]; then
  sleep 30
fi
exit 0'
  export BROKK_BOOTSTRAP_TIMEOUT=1
  export APT_AVAILABLE=""
  SECONDS=0
  run ensure_docker_buildx apt
  [ "$SECONDS" -lt 20 ]
  [ "$status" -eq 0 ]
}

@test "the qemu.conf backup keeps the pristine original across two rewrites" {
  export BROKK_BOOTSTRAP_QEMU_CONF="$BATS_TEST_TMPDIR/qemu.conf"
  printf 'user = "libvirt-qemu"\ngroup = "libvirt-qemu"\nmax_processes = 0\n' >"$BROKK_BOOTSTRAP_QEMU_CONF"
  cp "$BROKK_BOOTSTRAP_QEMU_CONF" "$BATS_TEST_TMPDIR/pristine"

  USER=alice run _configure_qemu_conf
  [ "$status" -eq 0 ]
  USER=bob run _configure_qemu_conf
  [ "$status" -eq 0 ]

  [ "$(cat "$BATS_TEST_TMPDIR/pristine")" = "$(cat "$BROKK_BOOTSTRAP_QEMU_CONF.brokk-bak")" ]
  grep -q 'user = "bob"' "$BROKK_BOOTSTRAP_QEMU_CONF"
  grep -q 'max_processes = 0' "$BROKK_BOOTSTRAP_QEMU_CONF"
  [ ! -e "$BROKK_BOOTSTRAP_QEMU_CONF.brokk-tmp" ]
}

@test "a missing qemu.conf does not abort a set -e caller" {
  run env BROKK_BOOTSTRAP_QEMU_CONF="$BATS_TEST_TMPDIR/absent.conf" bash -c \
    'set -euo pipefail; . apps/local-sim/provisioning/linux-bootstrap.sh; _configure_qemu_conf; echo reached-the-end'

  [ "$status" -eq 0 ]
  [[ "$output" == *reached-the-end* ]]
}
