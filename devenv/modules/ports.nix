# Single source of truth for every host:port + derived route in the brokkr-local stack.
# devenv.nix and the hub/spoke modules read this by interpolation (no env round-trip); the lab
# control-center apps (which can't import Nix) read it via the named env vars in `labPortEnv`,
# spliced onto the lab process — with literal fallbacks in TS that mirror these values. Changing a
# port here ripples to the service definition, every readiness probe, every derived URL, and the
# lab UI. No port is declared twice anywhere else.
#
# The maps below are the *defaults*. modules/overrides.nix promotes them to `config.ports` /
# `config.hosts` options (per-key, defaulted from here), so the control center can override the
# datastore/service ports via stack.local.nix. Consumers don't read the raw maps — they bind
# `P = (import ./ports.nix).fromConfig config`, which returns the effective ports/hosts plus the
# urls/labPortEnv/mkPgUrl derived from them; every `P.ports.X` / `P.urls.X` call site is unchanged.
let
  ports = {
    lab = 3002; # control-center API (NestJS)
    labWeb = 5175; # control-center web (Vite)
    hubApi = {
      base = 3000;
      step = 2;
    }; # hub i -> 3000 + 2i
    hubAdmin = {
      base = 3001;
      step = 2;
    }; # hub i -> 3001 + 2i
    hubWeb = 5173; # primary hub only
    hubWebAdmin = 5174; # primary hub only
    spoke = {
      base = 8000;
      step = 1;
    }; # spoke i -> 8000 + i
    spokeGrpc = {
      base = 9082;
      step = 1;
    }; # spoke i -> 9082 + i
    nginx = 8888; # OS-layer cache
    mailpitSmtp = 1025; # local email catcher (processes.mailpit) — SMTP ingest
    mailpitWeb = 8025; # mailpit web UI / API (view captured email)
    redfish = 8443; # sushy-emulator (SIM_REDFISH_PORT)
    postgres = 5432;
    redis = 6379;
    thanosHttp = 10902;
    thanosGrpc = 10901;
    thanosRemoteWrite = 19291;
    thanosQueryHttp = 10903; # thanos query frontend — Prometheus HTTP query API (powers the CC datastore browser)
    thanosQueryGrpc = 10904; # thanos query internal gRPC (unused externally, but the component requires an address)
    # local observability sink (modules/telemetry.nix)
    otlpGrpc = 4317; # otel-collector OTLP gRPC ingest (standard OTLP port)
    otlpHttp = 4318; # otel-collector OTLP HTTP ingest (standard OTLP port; the hub exporter targets this)
    otelcolHealth = 4319; # otel-collector health_check extension (readiness probe; default 13133 clustered with the otlp ports)
    tempoHttp = 3200; # tempo query API + /ready (tempo convention; grafana datasource target)
    tempoGrpc = 4329; # tempo internal server gRPC (default 9095 sits inside the spokeGrpc 9082+ range)
    tempoOtlpGrpc = 4327; # tempo OTLP ingest, collector -> tempo (tempo's defaults 4317/4318 are owned by the collector)
    tempoOtlpHttp = 4328; # tempo OTLP HTTP sibling of 4327 (unused today; declared with its pair)
    grafana = 4300; # grafana UI (default 3000 collides with hub-api)
    lokiHttp = 3100; # loki query API + native OTLP logs ingest at /otlp (loki convention; grafana datasource target)
    lokiGrpc = 4330; # loki internal server gRPC (default 9095 sits inside the spokeGrpc 9082+ range, same as tempoGrpc)
  };

  hosts = {
    loopback = "127.0.0.1";
    hubPublic = "localhost"; # hub BASE_URL / ADMIN_BASE_URL host
    dataPlaneGateway = "192.168.200.1"; # VM-reachable gateway (spoke + OS-layer cache routes)
  };

  hostsFor =
    slot:
    hosts
    // {
      dataPlaneGateway = "192.168.${toString (200 + slot)}.1";
    };

  # routes derived from the effective map; host:port comes from the args. The postgres URL also
  # depends on identity (user/password/db), which is overridable via config.identity — so it's
  # composed at the use-site (devenv.nix / modules/hub.nix) with `mkPgUrl`, not baked here.
  mkPgUrlRaw =
    {
      user,
      password,
      db,
      host ? hosts.loopback,
      port ? ports.postgres,
    }:
    "postgresql://${user}:${password}@${host}:${toString port}/${db}";

  mkUrls =
    { ports, hosts }:
    {
      redis = "redis://${hosts.loopback}:${toString ports.redis}";
      hubBase = "http://${hosts.hubPublic}:${toString ports.hubApi.base}";
      hubAdmin = "http://${hosts.hubPublic}:${toString ports.hubAdmin.base}";
      osLayer = "http://${hosts.dataPlaneGateway}:${toString ports.nginx}/assets";
    };

  # named env vars spliced onto the lab process so the TS apps read the map (no Nix in TS): numbers
  # for the KINDS/port math, datastore ports + hosts so the URL knob defaults derive in TS.
  # originHost isn't part of the map (it lives on config.osLayerCache) but rides along because the
  # TS asset-origin knob default derives from it the same way the URLs do.
  mkLabPortEnv =
    {
      ports,
      hosts,
      originHost,
      slot,
    }:
    [
      "LAB_PORT=${toString ports.lab}"
      "LAB_WEB_PORT=${toString ports.labWeb}"
      "HUB_API_PORT_BASE=${toString ports.hubApi.base}"
      "HUB_API_PORT_STEP=${toString ports.hubApi.step}"
      "HUB_ADMIN_PORT_BASE=${toString ports.hubAdmin.base}"
      "HUB_ADMIN_PORT_STEP=${toString ports.hubAdmin.step}"
      "HUB_WEB_PORT=${toString ports.hubWeb}"
      "HUB_WEB_ADMIN_PORT=${toString ports.hubWebAdmin}"
      "SPOKE_PORT_BASE=${toString ports.spoke.base}"
      "SPOKE_PORT_STEP=${toString ports.spoke.step}"
      "SPOKE_GRPC_BASE=${toString ports.spokeGrpc.base}"
      "SPOKE_GRPC_STEP=${toString ports.spokeGrpc.step}"
      "NGINX_PORT=${toString ports.nginx}"
      "THANOS_QUERY_HTTP_PORT=${toString ports.thanosQueryHttp}"
      "PG_PORT=${toString ports.postgres}"
      "REDIS_PORT=${toString ports.redis}"
      "HUB_PUBLIC_HOST=${hosts.hubPublic}"
      "DATA_PLANE_GATEWAY=${hosts.dataPlaneGateway}"
      "LOOPBACK_HOST=${hosts.loopback}"
      "ASSET_ORIGIN=${originHost}"
      "STACK_SLOT=${toString slot}"
    ];
  # slot block allocator: slot 0 = legacy layout; slots >=1 live in 500-wide blocks at
  # 20000+500*S (below the macOS ephemeral floor 49152). Bands reserve 20 ports each for
  # replica/ordinal expansion. redfish is deliberately never offset (binds per-BMC-alias-IP;
  # per-slot BMC CIDRs separate it).
  slotBlockBase = slot: 20000 + 500 * slot;

  # slot 0 keeps the legacy 9300+i consoles (parity); slots >=1 use their block's B+60 band.
  # 9300+100*S would walk into slot 0's thanos block at slot 16 — never reintroduce that.
  consoleBaseFor = slot: if slot == 0 then 9300 else slotBlockBase slot + 60;

  forSlot =
    slot:
    if slot == 0 then
      ports
    else
      let
        B = slotBlockBase slot;
      in
      ports
      // {
        lab = B + 2;
        hubWeb = B + 3;
        hubWebAdmin = B + 4;
        labWeb = B + 5;
        nginx = B + 6;
        mailpitSmtp = B + 7;
        mailpitWeb = B + 8;
        thanosHttp = B + 9;
        thanosGrpc = B + 10;
        thanosRemoteWrite = B + 11;
        thanosQueryHttp = B + 12;
        thanosQueryGrpc = B + 13;
        postgres = B + 14;
        redis = B + 15;
        spoke = ports.spoke // {
          base = B + 20;
        };
        spokeGrpc = ports.spokeGrpc // {
          base = B + 40;
        };
        otlpGrpc = B + 80;
        otlpHttp = B + 81;
        otelcolHealth = B + 82;
        tempoHttp = B + 83;
        tempoGrpc = B + 84;
        tempoOtlpGrpc = B + 85;
        tempoOtlpHttp = B + 86;
        lokiHttp = B + 87;
        lokiGrpc = B + 88;
        grafana = B + 89;
        hubApi = ports.hubApi // {
          base = B + 100;
        };
        hubAdmin = ports.hubAdmin // {
          base = B + 120;
        };
      };
in
{
  # raw defaults — modules/overrides.nix seeds the config.ports / config.hosts option defaults.
  defaults = { inherit ports hosts; };
  mkPgUrl = mkPgUrlRaw;
  inherit
    mkUrls
    mkLabPortEnv
    forSlot
    slotBlockBase
    consoleBaseFor
    hostsFor
    ;

  # effective view from module config: the overridable ports plus everything derived from them.
  # Consumers bind `P = (import ./ports.nix).fromConfig config` and keep using P.ports.X, P.urls.X,
  # P.hosts.X, P.labPortEnv, P.mkPgUrl exactly as before — now honoring config.ports overrides.
  # Hosts aren't overridable (see modules/overrides.nix), so they pass through from the defaults.
  fromConfig =
    config:
    let
      allocated = name: config.processes.${name}.ports.main.value or config.ports.${name};
      effPorts = config.ports // {
        postgres = allocated "postgres";
        redis = allocated "redis";
      };
      effHosts = hostsFor config.stack.slot;
    in
    {
      ports = effPorts;
      hosts = effHosts;
      # bind address for the otherwise loopback-only services + the hub-web/commerce-web/lab web+api:
      # 0.0.0.0 when the LAN toggle is on, else 127.0.0.1. Advertised URLs / readiness probes keep
      # using hosts.loopback — only the listener bind follows this. (config.lan.expose is declared in
      # modules/overrides.nix.)
      bindHost = if config.lan.expose then "0.0.0.0" else effHosts.loopback;
      urls = mkUrls {
        ports = effPorts;
        hosts = effHosts;
      };
      labPortEnv = mkLabPortEnv {
        ports = effPorts;
        hosts = effHosts;
        inherit (config.osLayerCache) originHost;
        inherit (config.stack) slot;
      };
      mkPgUrl =
        args:
        mkPgUrlRaw (
          {
            host = effHosts.loopback;
            port = effPorts.postgres;
          }
          // args
        );
    };
}
