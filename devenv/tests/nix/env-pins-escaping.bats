setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  . devenv/lib/bats-helpers.bash
  . devenv/lib/env-pins-bats.bash
}

@test "a carriage return in a pin value survives the render instead of becoming a newline" {
  local dir
  dir=$(scratch_root)
  BROKKR_CFG_osLayerCache__resolvers="$(printf 'a\rb')" \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  run nix eval --impure --raw --expr \
    "builtins.toJSON (import $dir/env.local.nix).brokkrEnvPins"
  [ "$status" -eq 0 ]
  [[ "$output" == *'a\rb'* ]]
  [[ "$output" != *'a\nb'* ]]
  rm -rf "$dir"
}

@test "a newline and a tab in a pin value round-trip as themselves" {
  local dir
  dir=$(scratch_root)
  BROKKR_CFG_osLayerCache__resolvers="$(printf 'l1\nl2\tx')" \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  run nix eval --impure --raw --expr \
    "builtins.toJSON (import $dir/env.local.nix).brokkrEnvPins"
  [ "$status" -eq 0 ]
  [[ "$output" == *'l1\nl2\tx'* ]]
  rm -rf "$dir"
}
