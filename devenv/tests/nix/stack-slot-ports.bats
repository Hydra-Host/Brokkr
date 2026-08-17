
setup() {
  cd "$BATS_TEST_DIRNAME/../../.."
}

@test "slot 0 keeps the legacy port map" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in builtins.toJSON (p.forSlot 0)'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"base":3000'* ]]
  [[ "$output" == *'"postgres":5432'* ]]
  [[ "$output" == *'"redfish":8443'* ]]
  [[ "$output" == *'"lab":3002'* ]]
}

@test "slot 1 lands in its 20500 block with reserved bands" {
  run nix eval --impure --raw --expr '
    let p = import ./devenv/modules/ports.nix; s1 = p.forSlot 1;
    in builtins.toJSON { hubBase = s1.hubApi.base; adminBase = s1.hubAdmin.base;
                         pg = s1.postgres; redis = s1.redis; spoke = s1.spoke.base;
                         lab = s1.lab; nginx = s1.nginx; }'
  [ "$status" -eq 0 ]
  [ "$output" = '{"adminBase":20620,"hubBase":20600,"lab":20502,"nginx":20506,"pg":20514,"redis":20515,"spoke":20520}' ]
}

@test "ports are unique across slots with replica expansion and below the ephemeral floor" {
  run nix eval --impure --expr '
    let p = import ./devenv/modules/ports.nix;
        s0 = p.forSlot 0;
        scalars = m:
          [ m.nginx m.mailpitSmtp m.mailpitWeb m.postgres m.redis
            m.thanosHttp m.thanosGrpc m.thanosRemoteWrite m.thanosQueryHttp m.thanosQueryGrpc
            m.hubWeb m.hubWebAdmin m.lab m.labWeb
            m.otlpGrpc m.otlpHttp m.otelcolHealth m.tempoHttp m.tempoGrpc
            m.tempoOtlpGrpc m.tempoOtlpHttp m.lokiHttp m.lokiGrpc m.grafana ];
        expand = base: step: n: builtins.genList (i: base + step * i) n;
        flat = s: let m = p.forSlot s; in
          scalars m
          ++ expand m.hubApi.base m.hubApi.step 3
          ++ expand m.hubAdmin.base m.hubAdmin.step 3
          ++ expand m.spoke.base m.spoke.step 3
          ++ expand m.spokeGrpc.base m.spokeGrpc.step 3
          ++ expand (p.consoleBaseFor s) 1 4;
        slotted = builtins.concatLists (map flat (builtins.genList (s: s + 1) 46));
        all = scalars s0 ++ slotted;
        uniq = builtins.foldl'"'"' (acc: x: if builtins.elem x acc then acc else acc ++ [x]) [] all;
    in (builtins.length all == builtins.length uniq) && (builtins.all (x: x < 49152) all)'
  [ "$status" -eq 0 ]
  [ "$output" = true ]
}

@test "redfish is the one intentional constant" {
  run nix eval --impure --expr '
    let p = import ./devenv/modules/ports.nix;
    in builtins.all (s: (p.forSlot s).redfish == 8443) (builtins.genList (s: s) 47)'
  [ "$status" -eq 0 ]
  [ "$output" = true ]
}

@test "data plane gateway derives from the slot" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in (p.hostsFor 0).dataPlaneGateway'
  [ "$status" -eq 0 ]
  [ "$output" = '192.168.200.1' ]
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in (p.hostsFor 3).dataPlaneGateway'
  [ "$status" -eq 0 ]
  [ "$output" = '192.168.203.1' ]
}
