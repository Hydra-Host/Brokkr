
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  if [ -z "${BROKKR_DISTRO_TESTS:-}" ]; then
    skip "set BROKKR_DISTRO_TESTS=1 to run the container tier (pulls images, emulates amd64)"
  fi
  docker info >/dev/null 2>&1 || skip "no reachable docker daemon"
}

probe() {
  run timeout 560 bash devenv/scripts/distro-sudoers-probe.sh "$1"
  [ "$status" -eq 0 ]
  [[ "$output" != *FAIL* ]]
  [[ "$output" == *"the verb reports a matching drop-in as current"* ]]
  [[ "$output" == *"a legacy unhashed drop-in is reported as not current"* ]]
}

@test "fedora: the real verb answers where an unprivileged stat cannot" {
  probe fedora:latest
}

@test "arch: the real verb answers where an unprivileged stat cannot" {
  probe archlinux:base-devel
}
