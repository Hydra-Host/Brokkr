
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  . devenv/lib/bats-helpers.bash
  . devenv/lib/checkout-stash.bash
  lock_checkout
}

teardown() {
  restore_checkout
}

@test "SIM_SLOT and LOCAL_STATE are exported" {
  run devenv eval env.SIM_SLOT
  [ "$status" -eq 0 ]
  [[ "$output" == *'"env.SIM_SLOT": "0"'* ]]
  run devenv eval env.LOCAL_STATE
  [ "$status" -eq 0 ]
  [[ "$output" == *'.local/share/local"'* ]]
}

@test "fleet env carries BRIDGE_ENDPOINT and HUB_ENDPOINT" {
  run devenv eval processes.fleet.process-compose.environment
  [ "$status" -eq 0 ]
  [[ "$output" == *BRIDGE_ENDPOINT* ]]
  [[ "$output" == *HUB_ENDPOINT* ]]
}

@test "hub-web env carries API_PROXY_TARGET" {
  run devenv eval processes.hub-web.process-compose.environment
  [ "$status" -eq 0 ]
  [[ "$output" == *API_PROXY_TARGET* ]]
}

@test "spoke storage and agent paths derive from the slot" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/spoke-paths.nix; in builtins.toJSON (p.forSlot 2)'
  [ "$status" -eq 0 ]
  [ "$output" = '{"agent":"/opt/brokkr/agent-s2","storage":"/tmp/brokkr-dev-s2"}' ]
}

@test "slot 2 derives env values across the stack" {
  stash_file devenv.local.nix
  echo '{ stack.slot = 2; }' >devenv.local.nix
  run devenv eval env.SIM_SLOT
  [ "$status" -eq 0 ]
  [[ "$output" == *'"env.SIM_SLOT": "2"'* ]]
  run devenv eval env.LOCAL_STATE
  [[ "$output" == *'.local/share/local-s2"'* ]]
  run devenv eval processes.hub-web.process-compose.environment
  [[ "$output" == *'API_PROXY_TARGET=http://localhost:21100'* ]]
  run devenv eval processes.hub-api.process-compose.environment
  [[ "$output" == *'BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:21003,http://localhost:21100'* ]]
  run devenv eval processes.fleet.process-compose.environment
  [[ "$output" == *'BRIDGE_ENDPOINT=http://127.0.0.1:21020'* ]]
  [[ "$output" == *'HUB_ENDPOINT=http://127.0.0.1:21100'* ]]
  [[ "$output" == *'BRIDGE_PERSISTENT_STORAGE=/tmp/brokkr-dev-s2'* ]]
  run devenv eval ports
  [[ "$output" == *'"base": 21100'* ]]
  [[ "$output" == *'"postgres": 21014'* ]]
}
