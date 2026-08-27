setup() {
  cd "$(dirname "$BATS_TEST_DIRNAME")/.."
  . devenv/lib/bats-helpers.bash
  . devenv/lib/env-pins-bats.bash
}

@test "the renderer writes nothing when the pins are switched off" {
  local dir
  dir=$(scratch_root)
  BROKKR_ENV_PINS=off BROKKR_CFG_ports__postgres=5555 \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$dir/env.local.nix" ]
  rm -rf "$dir"
}

@test "off disables an ALREADY-RENDERED pin, not just the next render" {
  local dir
  dir=$(scratch_root)
  BROKKR_CFG_ports__postgres=5555 run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  [ -e "$dir/env.local.nix" ]
  BROKKR_ENV_PINS=off run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$dir/env.local.nix" ]
  rm -rf "$dir"
}

@test "a repeat render leaves the file byte-identical and untouched" {
  local dir
  dir=$(scratch_root)
  BROKKR_CFG_ports__postgres=5555 BROKKR_PIN_SPOKE_LOG_LEVEL=warning \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  [ -e "$dir/env.local.nix" ]
  cp -p "$dir/env.local.nix" "$dir/first"

  BROKKR_CFG_ports__postgres=5555 BROKKR_PIN_SPOKE_LOG_LEVEL=warning \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  run python3 -c '
import os, sys
a, b = sys.argv[1], sys.argv[2]
assert open(a, "rb").read() == open(b, "rb").read(), "env.local.nix is not byte-identical"
assert os.stat(a).st_mtime_ns == os.stat(b).st_mtime_ns, "env.local.nix was rewritten"
print("ok")
' "$dir/first" "$dir/env.local.nix"
  [ "$status" -eq 0 ]
  [ "$output" = ok ]
  rm -rf "$dir"
}

@test "the renderer resolves both variable forms and drops the file when they go" {
  local dir
  dir=$(scratch_root)
  BROKKR_CFG_ports__postgres=5555 BROKKR_PIN_HUB_LOG_LEVEL=warn BROKKR_PIN_UNDECLARED=x \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  [[ "$output" == *"BROKKR_PIN_UNDECLARED"* ]]

  run cat "$dir/env.local.nix"
  [[ "$output" == *'"ports.postgres" = "5555";'* ]]
  [[ "$output" == *'"stackDefaults.hub.LOG_LEVEL" = "warn";'* ]]
  [[ "$output" == *'"stackDefaults.hub.LOG_LEVEL" = "BROKKR_PIN_HUB_LOG_LEVEL";'* ]]

  run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  [ ! -e "$dir/env.local.nix" ]
  rm -rf "$dir"
}

@test "one pin stays on one line, whatever the value contains" {
  local dir
  dir=$(scratch_root)
  BROKKR_CFG_osLayerCache__resolvers="$(printf 'l1\nl2')" \
    run "$dir/devenv/scripts/render-env-pins.sh"
  [ "$status" -eq 0 ]
  run grep -c 'osLayerCache.resolvers' "$dir/env.local.nix"
  [ "$output" = "2" ]
  rm -rf "$dir"
}
