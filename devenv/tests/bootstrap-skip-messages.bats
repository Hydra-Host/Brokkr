setup() {
  cd "$BATS_TEST_DIRNAME/../.."
  MOCKBIN=$(mktemp -d)
  MOCKLOG=$(mktemp)
  export MOCKLOG
  for tool in nix direnv devenv; do
    printf '#!/bin/sh\nexit 0\n' >"$MOCKBIN/$tool"
  done
  cat >"$MOCKBIN/curl" <<'EOF'
#!/bin/sh
echo "curl $*" >> "$MOCKLOG"
exit 0
EOF
  chmod +x "$MOCKBIN"/*
  export PATH="$MOCKBIN:$PATH"
}

teardown() {
  rm -rf "$MOCKBIN" "$MOCKLOG"
}

@test "install_nix_and_direnv reports each tool it skipped" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    install_nix_and_direnv
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"nix already installed"* ]]
  [[ "$output" == *"direnv already installed"* ]]
  [[ "$output" == *"devenv already installed"* ]]
}

@test "install_nix_and_direnv installs nothing when the tools are present" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    install_nix_and_direnv
  '
  [ "$status" -eq 0 ]
  run cat "$MOCKLOG"
  [ "$output" = "" ]
}

stub_devenv_version() {
  printf '#!/bin/sh\n[ "$1" = "--version" ] && echo "devenv %s (aarch64-darwin)"\nexit 0\n' "$1" \
    >"$MOCKBIN/devenv"
  chmod +x "$MOCKBIN/devenv"
}

stub_nix_log() {
  printf '#!/bin/sh\necho "nix $*" >> "$MOCKLOG"\nexit 0\n' >"$MOCKBIN/nix"
  chmod +x "$MOCKBIN/nix"
}

@test "the bootstrap devenv floor equals devenv.latestVersion in devenv.nix" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    printf "%s" "$DEVENV_MIN_VERSION"
  '
  [ "$status" -eq 0 ]
  floor="$output"
  [ -n "$floor" ]
  declared=$(sed -n 's/^[[:space:]]*devenv\.latestVersion[[:space:]]*=[[:space:]]*"\([0-9][0-9.]*\)";[[:space:]]*$/\1/p' devenv.nix)
  [ -n "$declared" ]
  [ "$floor" = "$declared" ]
}

@test "devenv.yaml declares no hard require_version gate" {
  run grep -c '^require_version:' devenv.yaml
  [ "$output" = "0" ]
}

@test "devenv.latestVersion equals the pinned devenv module tag" {
  pinned=$(sed -n 's#^[[:space:]]*url:[[:space:]]*github:cachix/devenv/v\([0-9][0-9.]*\)?dir=src/modules[[:space:]]*$#\1#p' devenv.yaml)
  [ -n "$pinned" ]
  declared=$(sed -n 's/^[[:space:]]*devenv\.latestVersion[[:space:]]*=[[:space:]]*"\([0-9][0-9.]*\)";[[:space:]]*$/\1/p' devenv.nix)
  [ -n "$declared" ]
  [ "$pinned" = "$declared" ]
}

@test "_version_lt orders versions without sort -V" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    _version_lt 2.1.2 2.2.2 && echo lt
    _version_lt 2.2.2 2.2.2 || echo eq
    _version_lt 2.2.10 2.2.2 || echo gt
    _version_lt 2.2 2.2.2 && echo short
    _version_lt 10.0.0 9.0.0 || echo major
  '
  [ "$status" -eq 0 ]
  [ "$output" = "lt
eq
gt
short
major" ]
}

@test "the version report warns when devenv is below the floor" {
  stub_devenv_version 1.0.0
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    _check_devenv_version
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"devenv 1.0.0 is below the"* ]]
  [[ "$output" == *"devenv.latestVersion in devenv.nix"* ]]
  [[ "$output" == *"nix profile upgrade devenv"* ]]
  [[ "$output" == *"home-manager switch"* ]]
}

@test "the version report does not warn when devenv meets the floor" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    printf "%s" "$DEVENV_MIN_VERSION"
  '
  stub_devenv_version "$output"
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    _check_devenv_version
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"satisfies the >="* ]]
  [[ "$output" != *"is below the"* ]]
}

@test "the version report tolerates devenv --version output it cannot parse" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    _check_devenv_version
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"skipping the >="* ]]
  [[ "$output" != *"is below the"* ]]
}

@test "the bootstrap does not upgrade a devenv below the floor" {
  stub_devenv_version 1.0.0
  stub_nix_log
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    install_nix_and_direnv
  '
  [ "$status" -eq 0 ]
  run cat "$MOCKLOG"
  [ "$output" = "" ]
}

@test "the devenv pin ref names the version the repo declares" {
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    printf "%s %s" "$DEVENV_MIN_VERSION" "$DEVENV_PIN_REF"
  '
  [ "$status" -eq 0 ]
  set -- $output
  [ -n "$1" ]
  [ "$2" = "github:cachix/devenv/v$1" ]
}

@test "the devenv install names the pin, not the unlocked registry" {
  run grep -c 'nix profile install --accept-flake-config "\$DEVENV_PIN_REF"' \
    apps/local-sim/provisioning/bootstrap.sh
  [ "$output" = "1" ]
  run grep -c 'nix profile install nixpkgs#devenv' apps/local-sim/provisioning/bootstrap.sh
  [ "$output" = "0" ]
  run grep -c 'nix profile install nixpkgs#direnv' apps/local-sim/provisioning/bootstrap.sh
  [ "$output" = "1" ]
}

@test "the version report notes a devenv ahead of the pin without upgrading it" {
  stub_devenv_version 9.9.9
  stub_nix_log
  run env BROKK_BOOTSTRAP_LIB=1 bash -c '
    . apps/local-sim/provisioning/bootstrap.sh
    _check_devenv_version
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"devenv 9.9.9 is ahead of the"* ]]
  [[ "$output" == *"github:cachix/devenv/v"* ]]
  [[ "$output" != *"is below the"* ]]
  run cat "$MOCKLOG"
  [ "$output" = "" ]
}
