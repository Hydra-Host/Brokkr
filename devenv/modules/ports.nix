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
    thanosCapnproto = 19391; # thanos receive's cap'n proto server — it binds one whether or not we name it
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

  # These also reach postgresql.conf, redis.conf, a DSN userinfo and process-compose env lists, where
  # no escaping is expressible. A throw, not an assertion: `devenv eval` checks no assertions.
  refuse =
    path: shape: value:
    if builtins.isString value && builtins.match shape value != null then
      value
    else
      throw "${path}: refusing ${builtins.toJSON value} — it must match /${shape}/. This value reaches configuration files and process environments, where quoting cannot contain it.";
  # Injection prevention, not RFC validation: a malformed-but-inert host is the module's problem to
  # report, an embedded newline or quote is not. Colons are for IPv6.
  hostShape = "[A-Za-z0-9._:-]+";
  # Credentials ride in a URL userinfo and in redis.conf, so hold them to the unreserved URL set.
  secretShape = "[A-Za-z0-9._~-]+";
  safeHost = path: v: if v == "" then v else refuse path hostShape v;
  safeSecret = path: refuse path secretShape;

  # A bind address reaches a socket, so a name here is not merely inert: it resolves to several
  # addresses and the loopback entry `bindHostList` adds alongside it then binds one of them twice.
  # Shape only — a strict parse lives in the contract's isIpv4/isIpv6, which gates the write.
  ipv4Shape = "[0-9]{1,3}(\\.[0-9]{1,3}){3}";
  ipv6Shape = "[0-9a-fA-F:]*:[0-9a-fA-F:.]*";
  # Every spelling that binds every interface. Listing loopback beside one of these binds the same
  # address twice, which is the EADDRINUSE the bind list guards against.
  allInterfaces = [
    "0.0.0.0"
    "::"
    "::0"
    "0:0:0:0:0:0:0:0"
  ];
  isAllInterfaces = a: builtins.elem a allInterfaces;
  safeBindAddress =
    path: v:
    if v == "" || builtins.match ipv4Shape v != null || builtins.match ipv6Shape v != null then
      v
    else
      throw "${path}: refusing ${builtins.toJSON v} — it must be an IPv4 or IPv6 literal, or empty for every interface. A hostname belongs in lan.publicHost, which names the host a browser reaches this stack at and never reaches a socket.";

  # Loopback keeps `trust` in every mode: the upstream readiness probe connects as the OS account with
  # no password, so a blanket credential rule breaks bring-up. Only the non-loopback lines follow the flag.
  mkHbaConf =
    { offLoopback, datastoreAuth }:
    ''
      local all all trust
      host  all all 127.0.0.1/32 trust
      host  all all ::1/128 trust
    ''
    + (
      if !offLoopback then
        ""
      else if datastoreAuth then
        ''
          host  all all 0.0.0.0/0 scram-sha-256
          host  all all ::/0 scram-sha-256
        ''
      else
        ''
          host  all all 0.0.0.0/0 trust
          host  all all ::/0 trust
        ''
    );

  # protected-mode is redis's own guard against an unauthenticated non-loopback client, so it comes
  # off only where the bind reaches the network. requirepass passwords `default` without narrowing it.
  mkRedisExtraConf =
    {
      offLoopback,
      datastoreAuth,
      password,
    }:
    if !offLoopback then
      ""
    else
      ''
        protected-mode no
      ''
      + (
        if datastoreAuth then
          ''
            requirepass ${safeSecret "identity.redis.password" password}
          ''
        else
          ""
      );

  # the catcher holds real password-reset mail and its unauthenticated api returns message bodies, so
  # the ui must not stay open off loopback. the env form takes a plain pair, the file form wants bcrypt.
  mkMailpitAuthEnv =
    {
      offLoopback,
      datastoreAuth,
      password,
    }:
    if offLoopback && datastoreAuth then
      [ "MP_UI_AUTH=brokkr:${safeSecret "identity.mailpit.password" password}" ]
    else
      [ ];

  # An IPv6 literal needs brackets before a port is appended, or the last colon group and the port are
  # indistinguishable. Only where both are present: `listen_addresses` and Redis `bind` carry no port.
  hostPort =
    host: port:
    if builtins.match ".*:.*" host != null then
      "[${host}]:${toString port}"
    else
      "${host}:${toString port}";

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
    "postgresql://${safeSecret "identity.pg.user" user}:${safeSecret "identity.pg.password" password}@${host}:${toString port}/${safeSecret "identity.pg.db" db}";

  # Three sets because a URL's audience decides its host: `browser` is what a person types, `local` is
  # this box, `dial` is server-to-server. No single `hubBase` — a wrong audience fails at RUN time.
  mkUrls =
    {
      ports,
      hosts,
      publicHost ? hosts.hubPublic,
      redisPassword ? "",
    }:
    let
      # Redis AUTH goes in the userinfo with an empty username (the `default` ACL user). No escaping
      # here: the password is a control-center knob, so keep it URL-safe.
      redisAuth = if redisPassword == "" then "" else ":${redisPassword}@";
      # http, because this repo terminates no TLS. Better Auth derives the cookie `secure` flag from
      # it, so an operator serving https pins the hub URLs through stackDefaults.hub instead.
      originsFor = host: {
        hubApi = "http://${hostPort host ports.hubApi.base}";
        hubAdmin = "http://${hostPort host ports.hubAdmin.base}";
        hubWeb = "http://${hostPort host ports.hubWeb}";
        hubWebAdmin = "http://${hostPort host ports.hubWebAdmin}";
      };
    in
    {
      redis = "redis://${redisAuth}${hostPort hosts.loopback ports.redis}";
      osLayer = "http://${hosts.dataPlaneGateway}:${toString ports.nginx}/assets";
      browser = originsFor publicHost;
      local = originsFor hosts.hubPublic;
      dial = originsFor hosts.loopback;
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
      publicHost ? hosts.hubPublic,
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
      # A SECOND entry, not a redefinition: the TS mirror reads this and falls back to HUB_PUBLIC_HOST, so
      # the two audiences stay distinguishable there. They differ only once lan.bindAddress is set.
      "HUB_BROWSER_HOST=${publicHost}"
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
        thanosCapnproto = B + 16;
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
    safeSecret
    safeHost
    safeBindAddress
    isAllInterfaces
    hostPort
    mkHbaConf
    mkRedisExtraConf
    mkMailpitAuthEnv
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
      # config.lan.* is declared in modules/overrides.nix, which also aliases the deprecated
      # lan.expose onto lan.mode — so nothing downstream of here reads the boolean.
      lanMode = config.lan.mode;
      # Only `direct` puts a listener on the network. `fronted` keeps every bind on loopback and
      # moves the trust decision into the lab API instead (LAB_MODE, devenv.nix).
      offLoopback = lanMode == "direct";
      bindAddress = safeBindAddress "lan.bindAddress" config.lan.bindAddress;
      publicHostName = safeHost "lan.publicHost" config.lan.publicHost;
      bindHost =
        if !offLoopback then
          effHosts.loopback
        else if bindAddress != "" then
          bindAddress
        else
          "0.0.0.0";
      # Loopback must stay reachable for the readiness probes, but an all-interfaces bind already covers
      # it, and listing both fails the bind with EADDRINUSE.
      bindHostList =
        if bindHost == effHosts.loopback || isAllInterfaces bindHost then
          [ bindHost ]
        else
          [
            effHosts.loopback
            bindHost
          ];
      # Where a readiness probe dials a process that bound the single bindHost. An all-interfaces bind
      # covers loopback, but a named one does not, and a probe on loopback then never connects.
      probeHost = if isAllInterfaces bindHost then effHosts.loopback else bindHost;
      # Host a browser reaches this stack at. It never reaches a socket, so unlike the bind address it
      # takes a name. The fallback to bindAddress keeps a checkout that names an IP on its old behaviour.
      publicHost =
        if lanMode == "loopback" then
          effHosts.hubPublic
        else if publicHostName != "" then
          publicHostName
        else if bindAddress != "" then
          bindAddress
        else
          effHosts.hubPublic;
      # Vite refuses a request whose Host header is a name rather than the address it bound, so name
      # the hosts this stack is legitimately reached by instead of disabling the check. One list, so
      # the hub SPAs and the control center cannot answer different names.
      allowedHosts =
        if lanMode == "loopback" then
          ""
        else
          builtins.concatStringsSep "," (
            builtins.foldl' (acc: h: if builtins.elem h acc then acc else acc ++ [ h ])
              [ ]
              [
                publicHost
                effHosts.hubPublic
                effHosts.loopback
              ]
          );
    in
    {
      ports = effPorts;
      hosts = effHosts;
      inherit
        lanMode
        offLoopback
        bindHost
        bindHostList
        probeHost
        publicHost
        allowedHosts
        ;
      # Re-exported through the effective view as well, because consumers bind `P = … fromConfig config`
      # and never see this file's top level.
      inherit
        safeSecret
        safeHost
        safeBindAddress
        hostPort
        mkHbaConf
        mkRedisExtraConf
        mkMailpitAuthEnv
        ;
      urls = mkUrls {
        ports = effPorts;
        hosts = effHosts;
        inherit publicHost;
        redisPassword =
          if offLoopback && config.lan.datastoreAuth then
            safeSecret "identity.redis.password" config.identity.redis.password
          else
            "";
      };
      labPortEnv = mkLabPortEnv {
        ports = effPorts;
        hosts = effHosts;
        inherit publicHost;
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
