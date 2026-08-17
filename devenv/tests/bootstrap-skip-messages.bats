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
