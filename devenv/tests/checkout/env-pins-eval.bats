setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  . devenv/lib/bats-helpers.bash
  . devenv/lib/checkout-stash.bash
  ROOT="$(repo_root)"
  stash_file env.local.nix
  stash_file stack.local.nix
  rm -f env.local.nix stack.local.nix
  export SECRETSPEC_REASON="devenv bats: evaluate the environment pins"
}

teardown() {
  restore_checkout
}

need_devenv() {
  command -v devenv >/dev/null || skip "devenv is not on PATH"
}

write_pins() {
  printf '{ brokkrEnvPins = { %s }; }\n' "$1" >"$ROOT/env.local.nix"
}

write_stack_local() {
  printf '{ stackOverrides.spoke = { %s }; }\n' "$1" >"$ROOT/stack.local.nix"
}

@test "a pin on one spoke key leaves the other stack.local.nix keys in place" {
  need_devenv
  write_stack_local 'LOG_LEVEL = "error"; TELEGRAF_ENABLED = "false";'
  write_pins '"stackDefaults.spoke.LOG_LEVEL" = "warning";'
  run devenv eval stackOverrides.spoke
  [ "$status" -eq 0 ]
  run python3 -c '
import json, sys
ov = json.loads(sys.stdin.read())["stackOverrides.spoke"]
assert ov.get("LOG_LEVEL") == "warning", ov
assert ov.get("TELEGRAF_ENABLED") == "false", ov
print(len(ov))
' <<<"$output"
  [ "$status" -eq 0 ]
  [ "$output" = 2 ]
}

@test "a pin outranks stack.local.nix and removing it restores the file value" {
  need_devenv
  write_stack_local 'LOG_LEVEL = "error";'
  write_pins '"stackDefaults.spoke.LOG_LEVEL" = "warning";'
  run devenv eval stackOverrides.spoke.LOG_LEVEL
  [ "$status" -eq 0 ]
  [[ "$output" == *'"warning"'* ]]

  rm -f "$ROOT/env.local.nix"
  run devenv eval stackOverrides.spoke.LOG_LEVEL
  [ "$status" -eq 0 ]
  [[ "$output" == *'"error"'* ]]
}

@test "an unknown path fails the eval and names the path" {
  need_devenv
  write_pins '"ports.nope" = "1";'
  run devenv eval ports.postgres
  [ "$status" -ne 0 ]
  [[ "$output" == *"ports.nope"* ]]
  [[ "$output" == *"BROKKR_CFG_ports__nope"* ]]
}

@test "a read-only knob and a secret knob are both refused" {
  need_devenv
  write_pins '"stack.slot" = "3";'
  run devenv eval stack.slot
  [ "$status" -ne 0 ]
  [[ "$output" == *"stack.slot"* ]]

  write_pins '"identity.pg.password" = "hunter2";'
  run devenv eval identity.pg.password
  [ "$status" -ne 0 ]
  [[ "$output" == *"identity.pg.password"* ]]
}

@test "an auth bypass pin reaches both simulation env keys" {
  need_devenv
  write_pins '"stackDefaults.hub.AUTH_BYPASS_ENABLED" = "false";'
  run devenv eval processes.hub-api.process-compose.environment
  [ "$status" -eq 0 ]
  run python3 -c '
import json, sys
env = dict(
    e.split("=", 1)
    for e in json.loads(sys.stdin.read())["processes.hub-api.process-compose.environment"]
)
assert env.get("LOCAL_SIMULATION_ENABLED") == "false", env.get("LOCAL_SIMULATION_ENABLED")
assert env.get("VITE_LOCAL_SIMULATION_ENABLED") == "false", env.get("VITE_LOCAL_SIMULATION_ENABLED")
print("ok")
' <<<"$output"
  [ "$status" -eq 0 ]
  [ "$output" = ok ]
}

@test "a composite knob carrying the pg password is refused like the password itself" {
  need_devenv
  write_pins '"stackDefaults.hub.DATABASE_URL" = "postgresql://brokkr:hunter2@127.0.0.1:5432/brokkr";'
  run devenv eval stackOverrides.hub
  [ "$status" -ne 0 ]
  [[ "$output" == *"embeds a secret knob"* ]]
  [[ "$output" != *"infinite recursion"* ]]
}

@test "an uncatalogued key in an env container is refused, since no option declares it" {
  need_devenv
  write_pins '"stackDefaults.hub.PGBOUNCER_CONNECTION_STRING" = "probe";'
  run devenv eval stackOverrides.hub
  [ "$status" -ne 0 ]
  [[ "$output" == *"may not be pinned"* ]]
  [[ "$output" == *"not a catalogued knob"* ]]
}

@test "a catalogued key in the same container still pins" {
  need_devenv
  write_pins '"stackDefaults.hub.LOG_LEVEL" = "warn";'
  run devenv eval stackOverrides.hub
  [ "$status" -eq 0 ]
  [[ "$output" == *"warn"* ]]
}

@test "a zone-crypto key is refused, so a pin cannot write one to disk in cleartext" {
  need_devenv
  write_pins '"zoneCrypto.hubPrivateKey" = "probe";'
  run devenv eval zoneCrypto.hubPrivateKey
  [ "$status" -ne 0 ]
  [[ "$output" == *"may not be pinned"* ]]

  write_pins '"zoneCrypto.bridgeAtRestKey" = "probe";'
  run devenv eval zoneCrypto.bridgeAtRestKey
  [ "$status" -ne 0 ]
  [[ "$output" == *"may not be pinned"* ]]
}

@test "the published refusal list carries every branch the refusal has, not just the flags" {
  need_devenv
  run devenv eval envPinRefusals
  [ "$status" -eq 0 ]
  [[ "$output" == *'"identity.pg.password"'* ]]
  [[ "$output" == *'"it is a secret"'* ]]
  [[ "$output" == *'"stackDefaults.hub.DATABASE_URL"'* ]]
  [[ "$output" == *"embeds a secret knob's value"* ]]
  [[ "$output" == *'"zoneCrypto.hubPrivateKey"'* ]]
  [[ "$output" == *'"it is a read-only knob"'* ]]
}
