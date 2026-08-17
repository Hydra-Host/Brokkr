
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
  . devenv/lib/bats-helpers.bash
  . devenv/lib/checkout-stash.bash
  export XDG_STATE_HOME=$(mktemp -d)
  OTHER=$(mktemp -d)
  stash_file stack.slot.nix
  rm -f stack.slot.nix
}

teardown() {
  rm -rf "$XDG_STATE_HOME" "$OTHER"
  restore_checkout
}

@test "auto-claim persists a weak-priority stack.slot.nix when slot 0 is taken" {
  . devenv/lib/stack-registry.sh
  stack_registry_claim 0 "$OTHER" "$DEVENV_RUNTIME" >/dev/null
  run bash devenv/scripts/stack-claim.sh
  [ "$status" -eq 0 ]
  [ -f stack.slot.nix ]
  run grep 'lib.mkDefault 1' stack.slot.nix
  [ "$status" -eq 0 ]
  run devenv eval stack.slot
  [ "$status" -eq 0 ]
  [[ "$output" == *'"stack.slot": 1'* ]]
}

@test "slot 0 with a free registry writes no file" {
  run bash devenv/scripts/stack-claim.sh
  [ "$status" -eq 0 ]
  [ ! -f stack.slot.nix ]
  run devenv eval stack.slot
  [ "$status" -eq 0 ]
  [[ "$output" == *'"stack.slot": 0'* ]]
}

@test "slot drift against the applied stamp is refused with a reslot pointer" {
  mkdir -p "$DEVENV_STATE"
  stash_file "$DEVENV_STATE/stack-slot-applied"
  echo 0 >"$DEVENV_STATE/stack-slot-applied"
  stash_file devenv.local.nix
  echo '{ stack.slot = 2; }' >devenv.local.nix
  run bash devenv/scripts/stack-claim.sh
  [ "$status" -eq 1 ]
  [[ "$output" == *stack-reslot* ]]
}
