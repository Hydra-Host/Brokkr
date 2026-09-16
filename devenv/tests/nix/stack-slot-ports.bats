
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
            m.thanosHttp m.thanosGrpc m.thanosRemoteWrite m.thanosCapnproto m.thanosQueryHttp m.thanosQueryGrpc
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

@test "the knob catalog is non-empty and every knob carries a description" {
  command -v devenv >/dev/null || skip "devenv is not on PATH"
  export SECRETSPEC_REASON="devenv bats: read back the published knob catalog"
  run devenv --quiet eval knobCatalog
  [ "$status" -eq 0 ]
  run python3 -c '
import json, sys
catalog = json.loads(sys.stdin.read())["knobCatalog"]
assert catalog, "knobCatalog is empty"
undescribed = [e["path"] for e in catalog if not e["description"].strip()]
assert not undescribed, undescribed
unrenderable = [e["path"] for e in catalog if not e["label"].strip() or not e["kind"].strip()]
assert not unrenderable, unrenderable
print(len(catalog))
' <<<"$output"
  [ "$status" -eq 0 ]
  [ "$output" -gt 0 ]
}

@test "knob provenance attributes a knob to the file that set it" {
  command -v devenv >/dev/null || skip "devenv is not on PATH"
  export SECRETSPEC_REASON="devenv bats: read back knob provenance"
  run devenv --quiet eval knobProvenance
  [ "$status" -eq 0 ]
  run python3 -c '
import json, sys
prov = {e["path"]: e for e in json.loads(sys.stdin.read())["knobProvenance"]}
def owns(path, module):
    assert module in prov[path]["files"], (path, prov[path]["files"])
owns("ports.postgres", "devenv/modules/overrides.nix")
owns("stackDefaults.spoke.LOG_LEVEL", "devenv/modules/spoke.nix")
owns("stackDefaults.hub.AUTH_BYPASS_ENABLED", "devenv/modules/hub.nix")
assert "devenv/modules/hub.nix" in prov["stackDefaults.hub"]["perKey"]["LOG_LEVEL"]
print("ok")
' <<<"$output"
  [ "$status" -eq 0 ]
  [ "$output" = ok ]
}

@test "safeSecret refuses a credential holding whitespace" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.safeSecret "identity.redis.password" "two words"'
  [ "$status" -ne 0 ]
}

@test "safeSecret refuses a credential holding a newline" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.safeSecret "identity.redis.password" "hunter2\nrequirepass owned"'
  [ "$status" -ne 0 ]
}

@test "safeSecret refuses the userinfo delimiters that would re-split a dsn" {
  for bad in "a@b" "a/b" "a:b" "a#b" "a?b"; do
    run nix eval --impure --raw --expr \
      "let p = import ./devenv/modules/ports.nix; in p.safeSecret \"identity.pg.password\" \"$bad\""
    [ "$status" -ne 0 ]
  done
}

@test "safeSecret refuses an empty credential" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.safeSecret "identity.pg.password" ""'
  [ "$status" -ne 0 ]
}

@test "safeSecret passes the unreserved url set" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.safeSecret "identity.pg.password" "Az09._~-"'
  [ "$status" -eq 0 ]
  [ "$output" = "Az09._~-" ]
}

@test "hostPort brackets an ipv6 literal and leaves ipv4 alone" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in "${p.hostPort "::1" 6379}|${p.hostPort "127.0.0.1" 6379}"'
  [ "$status" -eq 0 ]
  [ "$output" = "[::1]:6379|127.0.0.1:6379" ]
}

@test "hbaConf keeps loopback on trust in every mode" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkHbaConf { offLoopback = false; datastoreAuth = true; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *"host  all all 127.0.0.1/32 trust"* ]]
  [[ "$output" == *"host  all all ::1/128 trust"* ]]
  [[ "$output" != *"0.0.0.0/0"* ]]
}

@test "hbaConf demands a credential on the non-loopback lines under direct plus datastoreAuth" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkHbaConf { offLoopback = true; datastoreAuth = true; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *"host  all all 0.0.0.0/0 scram-sha-256"* ]]
  [[ "$output" == *"host  all all ::/0 scram-sha-256"* ]]
  [[ "$output" != *"0.0.0.0/0 trust"* ]]
  [[ "$output" != *"::/0 trust"* ]]
}

@test "hbaConf opens the non-loopback lines only when datastoreAuth is explicitly off" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkHbaConf { offLoopback = true; datastoreAuth = false; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *"host  all all 0.0.0.0/0 trust"* ]]
  [[ "$output" != *"scram-sha-256"* ]]
}

@test "safeHost passes the empty string that marks an unset public host" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in "[${p.safeHost "lan.publicHost" ""}]"'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "safeHost refuses a host holding whitespace or a newline" {
  for bad in "a b" 'a\nlisten 0.0.0.0'; do
    run nix eval --impure --raw --expr \
      "let p = import ./devenv/modules/ports.nix; in p.safeHost \"lan.publicHost\" \"$bad\""
    [ "$status" -ne 0 ]
  done
}

@test "safeHost accepts a name, which is what lan.publicHost carries" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.safeHost "lan.publicHost" "dev-box.local"'
  [ "$status" -eq 0 ]
  [ "$output" = "dev-box.local" ]
}

@test "safeBindAddress accepts an empty value, an ipv4 literal and an ipv6 literal" {
  for good in "" "0.0.0.0" "127.0.0.1" "192.168.1.145" "::1" "fe80::1" "::ffff:192.168.1.1"; do
    run nix eval --impure --raw --expr \
      "let p = import ./devenv/modules/ports.nix; in \"[\${p.safeBindAddress \"lan.bindAddress\" \"$good\"}]\""
    [ "$status" -eq 0 ]
    [ "$output" = "[$good]" ]
  done
}

@test "safeBindAddress refuses a hostname and names lan.publicHost" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.safeBindAddress "lan.bindAddress" "braden-mbp.local"'
  [ "$status" -ne 0 ]
  [[ "$output" == *"lan.bindAddress"* ]]
  [[ "$output" == *"braden-mbp.local"* ]]
  [[ "$output" == *"lan.publicHost"* ]]
}

@test "safeBindAddress refuses every shape safeHost refuses, plus localhost and a zone id" {
  for bad in "localhost" "dev.example.com" "::1%eth0" "a b" '1.2.3.4;rm -rf /'; do
    run nix eval --impure --raw --expr \
      "let p = import ./devenv/modules/ports.nix; in p.safeBindAddress \"lan.bindAddress\" \"$bad\""
    [ "$status" -ne 0 ]
  done
}

@test "the bind list never repeats a host, and keeps loopback beside a lan address" {
  run nix eval --impure --raw --expr '
    let p = import ./devenv/modules/ports.nix;
        view = lan: let v = p.fromConfig { stack.slot = 0; inherit lan; }; in v.bindHostList;
    in builtins.toJSON {
      lan = view { mode = "direct"; bindAddress = "192.168.1.145"; publicHost = ""; };
      every = view { mode = "direct"; bindAddress = ""; publicHost = ""; };
      loop = view { mode = "loopback"; bindAddress = ""; publicHost = ""; };
      front = view { mode = "fronted"; bindAddress = ""; publicHost = "dev-box.local"; };
    }'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"lan":["127.0.0.1","192.168.1.145"]'* ]]
  [[ "$output" == *'"every":["0.0.0.0"]'* ]]
  [[ "$output" == *'"loop":["127.0.0.1"]'* ]]
  [[ "$output" == *'"front":["127.0.0.1"]'* ]]
}

@test "an all-interfaces bind is listed alone, in every spelling" {
  for every in "0.0.0.0" "::" "::0" "0:0:0:0:0:0:0:0"; do
    run nix eval --impure --raw --expr "
      let p = import ./devenv/modules/ports.nix;
          v = p.fromConfig { stack.slot = 0; lan = { mode = \"direct\"; bindAddress = \"$every\"; publicHost = \"\"; }; };
      in builtins.toJSON v.bindHostList"
    [ "$status" -eq 0 ]
    [ "$output" = "[\"$every\"]" ]
  done
}

@test "isAllInterfaces leaves a real bind address alone" {
  for one in "127.0.0.1" "192.168.1.145" "::1" "fe80::1"; do
    run nix eval --impure --raw --expr \
      "let p = import ./devenv/modules/ports.nix; in builtins.toJSON (p.isAllInterfaces \"$one\")"
    [ "$status" -eq 0 ]
    [ "$output" = "false" ]
  done
}

@test "lan.publicHost names the browser host without moving the bind" {
  run nix eval --impure --raw --expr '
    let p = import ./devenv/modules/ports.nix;
        view = lan: let v = p.fromConfig { stack.slot = 0; inherit lan; };
               in { inherit (v) bindHost publicHost allowedHosts; };
    in builtins.toJSON {
      named = view { mode = "direct"; bindAddress = "192.168.1.145"; publicHost = "dev-box.local"; };
      fallback = view { mode = "direct"; bindAddress = "192.168.1.145"; publicHost = ""; };
      front = view { mode = "fronted"; bindAddress = ""; publicHost = "dev-box.local"; };
      loop = view { mode = "loopback"; bindAddress = ""; publicHost = "dev-box.local"; };
    }'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"named":{"allowedHosts":"dev-box.local,localhost,127.0.0.1","bindHost":"192.168.1.145","publicHost":"dev-box.local"}'* ]]
  [[ "$output" == *'"fallback":{"allowedHosts":"192.168.1.145,localhost,127.0.0.1","bindHost":"192.168.1.145","publicHost":"192.168.1.145"}'* ]]
  [[ "$output" == *'"front":{"allowedHosts":"dev-box.local,localhost,127.0.0.1","bindHost":"127.0.0.1","publicHost":"dev-box.local"}'* ]]
  [[ "$output" == *'"loop":{"allowedHosts":"","bindHost":"127.0.0.1","publicHost":"localhost"}'* ]]
}

@test "redis conf stays empty while the bind is on loopback" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkRedisExtraConf { offLoopback = false; datastoreAuth = true; password = "pw123"; }'
  [ "$status" -eq 0 ]
  [ "$output" = "" ]
}

@test "redis conf drops protected-mode but sets no password when datastoreAuth is off" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkRedisExtraConf { offLoopback = true; datastoreAuth = false; password = "pw123"; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *"protected-mode no"* ]]
  [[ "$output" != *"requirepass"* ]]
}

@test "redis conf demands the password once datastoreAuth is on off loopback" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkRedisExtraConf { offLoopback = true; datastoreAuth = true; password = "pw123"; }'
  [ "$status" -eq 0 ]
  [[ "$output" == *"protected-mode no"* ]]
  [[ "$output" == *"requirepass pw123"* ]]
}

@test "redis conf refuses a password that would append a second directive" {
  run nix eval --impure --raw --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkRedisExtraConf { offLoopback = true; datastoreAuth = true; password = "pw\nprotected-mode yes"; }'
  [ "$status" -ne 0 ]
}

@test "mailpit auth is absent while the bind is on loopback" {
  run nix eval --impure --json --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkMailpitAuthEnv { offLoopback = false; datastoreAuth = true; password = "pw123"; }'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "mailpit auth is absent when datastoreAuth is off" {
  run nix eval --impure --json --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkMailpitAuthEnv { offLoopback = true; datastoreAuth = false; password = "pw123"; }'
  [ "$status" -eq 0 ]
  [ "$output" = "[]" ]
}

@test "mailpit auth carries the brokkr user once the bind leaves loopback under datastoreAuth" {
  run nix eval --impure --json --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkMailpitAuthEnv { offLoopback = true; datastoreAuth = true; password = "pw123"; }'
  [ "$status" -eq 0 ]
  [ "$output" = '["MP_UI_AUTH=brokkr:pw123"]' ]
}

@test "mailpit auth refuses a password holding the colon that separates the pair" {
  run nix eval --impure --json --expr \
    'let p = import ./devenv/modules/ports.nix; in p.mkMailpitAuthEnv { offLoopback = true; datastoreAuth = true; password = "pw:extra"; }'
  [ "$status" -ne 0 ]
}

@test "the postgres password task stays absent while the bind is on loopback" {
  command -v devenv >/dev/null || skip "devenv is not on PATH"
  export SECRETSPEC_REASON="devenv bats: confirm the credential task is gated off on loopback"
  run devenv --quiet eval tasks
  [ "$status" -eq 0 ]
  [[ "$output" != *"pg:password"* ]]
}

@test "the postgres password task source orders itself after postgres and before the hub migration" {
  block=$(sed -n '/"pg:password" = {/,/^    };/p' devenv.nix)
  [ -n "$block" ]
  [[ "$block" == *'after = [ "devenv:processes:postgres" ]'* ]]
  [[ "$block" == *'before = [ "hub:migrate" ]'* ]]
}

@test "the postgres password task source keeps the credential in a psql variable, never in the sql" {
  block=$(sed -n '/"pg:password" = {/,/^    };/p' devenv.nix)
  [ -n "$block" ]
  [[ "$block" == *'--set=pw=${lib.escapeShellArg config.identity.pg.password}'* ]]
  sql=$(printf '%s\n' "$block" | sed -n "/<<'SQL'/,/^        SQL\$/p" | tail -n +2)
  [ -n "$sql" ]
  [[ "$sql" == *":'pw'"* ]]
  [[ "$sql" != *'identity.pg.password'* ]]
}

@test "the mailpit probe stays off the routes its basic auth covers" {
  run env SECRETSPEC_REASON="pin the mailpit readiness probe path" devenv eval processes.mailpit.ready
  [ "$status" -eq 0 ]
  [[ "$output" == *'"path": "/readyz"'* ]]
  [[ "$output" != *'"path": "/"'* ]]
}

@test "the probe host follows the bind, so a named bind address is still reachable" {
  run nix eval --impure --raw --expr '
    let p = import ./devenv/modules/ports.nix;
        view = bindAddress: let v = p.fromConfig {
          stack.slot = 0; lan = { mode = "direct"; inherit bindAddress; publicHost = ""; };
        }; in { inherit (v) bindHost probeHost; };
    in builtins.toJSON {
      named = view "192.168.1.145";
      every = view "";
      v6every = view "::";
      loop = view "127.0.0.1";
    }'
  [ "$status" -eq 0 ]
  [[ "$output" == *'"named":{"bindHost":"192.168.1.145","probeHost":"192.168.1.145"}'* ]]
  [[ "$output" == *'"every":{"bindHost":"0.0.0.0","probeHost":"127.0.0.1"}'* ]]
  [[ "$output" == *'"v6every":{"bindHost":"::","probeHost":"127.0.0.1"}'* ]]
  [[ "$output" == *'"loop":{"bindHost":"127.0.0.1","probeHost":"127.0.0.1"}'* ]]
}

@test "a process that binds one address is probed on probeHost, not loopback" {
  run python3 -c '
import re, sys
want = {"devenv.nix": ["mailpit", "lab", "lab-web"],
        "devenv/modules/hub.nix": ["hub-web", "hub-web-admin"]}
bad = []
for path, procs in want.items():
    src = open(path).read().split("\n")
    for proc in procs:
        start = next(i for i, l in enumerate(src) if re.match(r"\s*processes\." + re.escape(proc) + r"\s*=", l))
        host = next((l.strip() for l in src[start:] if l.strip().startswith("host = ")), "")
        if "P.probeHost" not in host:
            bad.append(proc + " -> " + host)
print("BAD:" + "; ".join(bad) if bad else "OK")'
  [ "$status" -eq 0 ]
  [ "$output" = "OK" ]
}

@test "a process that binds every interface keeps its loopback probe" {
  for proc in hub-api hub-admin; do
    run sh -c "awk -v p=\"processes.$proc\" 'index(\$0,p){f=1} f&&/host = /{print;exit}' devenv/modules/hub.nix"
    [ "$status" -eq 0 ]
    [[ "$output" == *"P.hosts.loopback"* ]]
  done
}

@test "thanos names every address it binds, so no listener keeps an unslotted default" {
  run env SECRETSPEC_REASON="pin every thanos listener" devenv eval processes.thanos.exec
  [ "$status" -eq 0 ]
  for flag in http-address grpc-address remote-write.address receive.capnproto-address; do
    [[ "$output" == *"--$flag="* ]] || { echo "thanos does not name --$flag"; false; }
  done
  [[ "$output" != *"0.0.0.0:19391"* ]]
}
