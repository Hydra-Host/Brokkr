
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
}

@test "the bridge ordinal budget is the gap to the next declared port, not a written number" {
  run nix eval --impure --raw --expr '
    let p = import ./devenv/modules/ports.nix;
        budget = slot:
          let m = p.forSlot slot;
              scalars = builtins.filter builtins.isInt
                (builtins.attrValues (builtins.mapAttrs
                  (_: v: if builtins.isAttrs v then (v.base or null) else v) m));
              above = builtins.filter (v: v > m.spoke.base) scalars;
          in (builtins.foldl'"'"' (a: b: if b < a then b else a) (builtins.head above) above) - m.spoke.base;
    in builtins.toJSON { slot0 = budget 0; slot1 = budget 1; slot2 = budget 2; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"slot0":25'* ]]
  [[ "$output" == *'"slot1":20'* ]]
  [[ "$output" == *'"slot2":20'* ]]
}

@test "a disabled zone consumes no bridge ordinal, so the survivors start at zero" {
  run nix eval --impure --raw --expr '
    let lib = (import <nixpkgs> { }).lib;
        Z = import ./devenv/modules/zones.nix { inherit lib; };
        zones = [
          { name = "sim-zone"; index = 0; bridges = 1; enable = false; }
          { name = "edge"; index = 1; bridges = 2; enable = true; }
        ];
        kept = builtins.filter (z: z.enable) zones;
    in builtins.toJSON (map (z: { inherit (z) name baseOrdinal; }) (Z.withPortBlocks kept))'
  [ "$status" -eq 0 ]
  [ "$output" = '[{"baseOrdinal":0,"name":"edge"}]' ]
}
