
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
}

@test "an enum option still yields its choices, or the catalog renders a select with nothing in it" {
  run nix eval --impure --raw --expr '
    let lib = (import <nixpkgs> { }).lib;
        choicesOf = t:
          if t.name != "enum" then [ ]
          else map builtins.toString (t.functor.payload.values
            or (builtins.throw "lib.types.enum no longer exposes functor.payload.values"));
    in builtins.toJSON {
      enum = choicesOf (lib.types.enum [ "vm" "baremetal" ]);
      notEnum = choicesOf lib.types.bool;
    }'
  [ "$status" -eq 0 ]
  [ "$output" = '{"enum":["vm","baremetal"],"notEnum":[]}' ]
}

@test "a bounded int still states its range where the catalog reads it, and the check agrees" {
  run nix eval --impure --raw --expr '
    let lib = (import <nixpkgs> { }).lib;
        readBounds = t:
          let m = builtins.match ".*between (-?[0-9]+) and (-?[0-9]+) \\(both inclusive\\).*" t.description;
          in if m == null then null
             else { min = lib.toInt (builtins.elemAt m 0); max = lib.toInt (builtins.elemAt m 1); };
        proves = t:
          let b = readBounds t;
          in b != null && t.check b.min && t.check b.max
             && !(t.check (b.min - 1)) && !(t.check (b.max + 1));
    in builtins.toJSON {
      between = readBounds (lib.types.ints.between 1 4);
      port = readBounds lib.types.port;
      unbounded = readBounds lib.types.ints.unsigned;
      betweenProves = proves (lib.types.ints.between 1 4);
      portProves = proves lib.types.port;
    }'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"between":{"max":4,"min":1}'* ]]
  [[ "$output" == *'"port":{"max":65535,"min":0}'* ]]
  [[ "$output" == *'"unbounded":null'* ]]
  [[ "$output" == *'"betweenProves":true'* ]]
  [[ "$output" == *'"portProves":true'* ]]
}
