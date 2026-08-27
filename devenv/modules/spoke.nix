{
  pkgs,
  lib,
  config,
  ...
}:

# Spoke as a self-contained devenv unit: its init DAG task + the supervised processes. The
# spoke's runtime env is declarative Nix data attached via process-compose's per-process
# `environment` — it replicates what the bridge repo's `setup.sh dev` used to set (plus the
# brok-local sim values), so the spoke no longer sources setup.sh or the bridge repo's .env
# (the bridge app reads only the process env). The hub already works this way.
#
# MULTI-ZONE × MULTI-BRIDGE: one process PER (zone, bridge), not per zone-with-replicas. Each
# bridge's PORT/gRPC/hostname/zone are baked at eval time from modules/zones.nix (the Nix mirror
# of sim/scripts/local/zones.py) — so every process has a correct *static* readiness probe
# (process-compose can't template a probe port per replica, which is why we don't use replicas).
# Bridges in the same zone share BROKKR_ZONE_ID + REDIS_PREFIX → the same {zone}:lifecycle BullMQ
# queue → leader election + HA claim. A single default zone (sim-zone, index 0, 1 bridge) emits
# exactly one process named `spoke` on :8000/:9082 — byte-identical to the pre-zones setup.
let
  inherit ((import ./lib.nix)) cdRepo envKnobMeta;
  P = (import ./ports.nix).fromConfig config; # effective port/route map (overridable via config.ports)
  Z = (import ./zones.nix) {
    inherit lib;
  }; # zoneUuid + port-block ordinal (mirrors zones.py)

  # SSH key the bridge bakes into discovery initrds (root SSH into brokkr-live VMs). devenv
  # evaluates impurely (as for HUB_REPO_PATH), so $HOME resolves at eval; override via a spoke
  # knob if your key name differs.
  sshKey = "${builtins.getEnv "HOME"}/.ssh/id_ed25519";

  bm = pkgs.stdenv.isLinux && config.fleet.mode == "baremetal";
  inherit (config.fleet.baremetal) ifaceIp;
  bmArches = lib.sort (a: b: a < b) (
    lib.unique (
      map (n: if n.arch != null then n.arch else config.fleet.baremetal.arch) (
        lib.attrValues config.fleet.baremetal.nodes
      )
    )
  );
  bmDiscoveryArchitectures =
    if bmArches == [ ] then config.fleet.baremetal.arch else lib.concatStringsSep "," bmArches;

  # Zone-agnostic spoke env — everything that's identical across every bridge in every zone.
  # Per-bridge identity (PORT/gRPC/hostname/url + BROKKR_ZONE_ID/REDIS_PREFIX) is layered on in
  # mkBridge below; it is intentionally NOT here.
  paths = (import ./spoke-paths.nix).forSlot config.stack.slot;
  baseSpokeEnv = {
    # --- setup.sh dev defaults, now declarative ---
    # the bridge keys every sim behavior (phone-home endpoint, sushy Redfish
    # http+port, agent.yaml grpc_address override, localenv banner) off BROKKR_ENV=local;
    # HH_ENV/ENVIRONMENT stay for older checkouts (BROKKR_ENV wins the resolution chain).
    BROKKR_ENV = "local";
    HH_ENV = "dev";
    ENVIRONMENT = "dev";
    ANALYTICS_ENABLED = "false";
    TFTP_ENABLED = "false";
    ASYNCSSH_LOG_LEVEL = "WARNING";
    # /tmp is fine for the sim (wiped on macOS reboot); spoke:init mkdir -p's it.
    PERSISTENT_STORAGE_PATH = paths.storage;
    # per-slot agent staging dir (spoke:init symlinks the bundle here); the bridge's
    # agent-unit render reads these with /opt/brokkr/agent defaults (buildAgentBundleConfig).
    AGENT_BUNDLE_PATH = "${paths.agent}/main.js";
    AGENT_UNIT_PATH = "${paths.agent}/brokkr-bridge-agent.service";
    SSH_KEY_PATH = sshKey;
    BRIDGE_SSH_PRIVKEY_PATH = sshKey;

    # --- datastores (local, native). Previously forced in the exec after setup.sh; now plain env. ---
    REDIS_URL = P.urls.redis;
    # Redis at-rest encryption key — the bridge fails closed without it in every env. Committed
    # NON-SECRET local-dev default; MUST stay stable across restarts (a changing key orphans every
    # seeded DeviceSecret). See modules/zone-crypto.nix bridgeAtRestKey for the full rationale.
    BRIDGE_AT_REST_KEY = config.zoneCrypto.bridgeAtRestKey;

    # --- sim behavior ---
    LOCAL_SIMULATION_ENABLED = "true";
    # Local dev runs no nginx TLS terminator, so agents dial plaintext gRPC. This is the dedicated
    # knob for that (independent of LOCAL_SIMULATION_ENABLED, which also flips auth-bypass/seeding).
    GRPC_INSECURE = "true";
    BRIDGE_ORCHESTRATOR_ENABLED = "true";
    BRIDGE_API_VERSION = "0.0.0-dev";
    BROKKR_LIVE_VERSION = "1.1.8";
    # derived from the single asset-origin knob (config.osLayerCache.originHost); no parallel literal.
    DISCOVERY_BASE_URL = "https://${config.osLayerCache.originHost}/brokkr-live-light";
    # device fetches OS-layer blobs from {OS_LAYER_URL}/sha256:<hash>; point at the local
    # nginx cache (:8888) so repeat provisions skip the CDN re-pull.
    OS_LAYER_URL = P.urls.osLayer;
    # sim VM arch always equals the host arch, so sync/serve only this host's images.
    DISCOVERY_ARCHITECTURES = if pkgs.stdenv.isAarch64 then "arm64" else "amd64";
    # always all-interfaces, independent of the LAN toggle: the simulated VMs + the device agents
    # reach the bridge (iPXE/TFTP/HTTP, gRPC) at the data-plane gateway IP, so it must bind it.
    GRPC_INTERNAL_HOST = "0.0.0.0";
    HOST = "0.0.0.0";
    HTTPS_DOWNLOAD_TIMEOUT = "3600";
    HTTPS_RETRY_ATTEMPTS = "3";
    HTTPS_RETRY_DELAY = "5";
    HTTPS_VERIFY_SSL = "true";
    AGENT_SSH_FORCE_REDEPLOY = "true";
    LOG_LEVEL = "debug";
    # human-readable console in the sim (prod uses json for the journald/Gravwell pipeline).
    LOG_FORMAT = "console";
    BRIDGE_SYNC_ENABLED = "true";

    # Mirrors of the bridge app's own defaults (monitoring.config.ts, bullmq.config.ts), pinned so
    # Nix declares every spoke knob the control center can override instead of leaving three unset
    # — a knob with no Nix-side value has no default the UI can read back or revert to.
    MONITORING_LOGS_ENABLED = "false";
    LIFECYCLE_WORKER_CONCURRENCY = "10";
    COLLECTION_WORKER_CONCURRENCY = "1";

    # Telegraf telemetry (TS port of the prod nomad telegraf task). The bridge's
    # TelegrafConfigWriter renders per-device inputs to TELEGRAF_OWNED_CONF_PATH;
    # the sibling `<bridge>-telegraf` process (mkTelegraf below) reads that dir via
    # --watch-config and remote_writes to the sim's Thanos receive (devenv.nix
    # processes.thanos). Per-bridge TELEGRAF_OWNED_CONF_PATH + BRIDGE_API_URL are
    # layered on in mkBridge. Flip TELEGRAF_ENABLED=false (here or via a stack
    # override) to drop both the writer and the telegraf process.
    TELEGRAF_ENABLED = "true";
    TELEGRAF_POLL_INTERVAL = "30s";
    TELEGRAF_HTTP_TIMEOUT = "10s";
  }
  # Point the network scanner's Redfish probe at the sim's sushy port (8443), not the default 443.
  # Absent in bm mode so NETWORK_REDFISH_PORT falls back to 443 (the real BMC Redfish port).
  // lib.optionalAttrs (!bm) {
    SIM_REDFISH_PORT = toString P.ports.redfish;
    NETWORK_REDFISH_PORT = toString P.ports.redfish;
  }
  // lib.optionalAttrs bm {
    DHCP_PROXY_PEER_AUTHORITATIVE = "true";
    TFTP_ENABLED = "true";
    BRIDGE_IPXE_BUILDS_STRICT = "true";
    OS_LAYER_URL = "http://${ifaceIp}:${toString P.ports.nginx}/assets";
    DISCOVERY_ARCHITECTURES = bmDiscoveryArchitectures;
    BRIDGE_NODE_BIN = "${config.env.DEVENV_STATE}/baremetal/node";
    BRIDGE_GRPC_DIALBACK_HOST = ifaceIp;
  };

  # Control-center knobs, described from the code that consumes each one. No default is restated:
  # modules/overrides.nix reads every one back out of stackDefaults.spoke below. The spoke has no
  # knob-name -> env-key remap, so no knob here carries an alias.
  spokeKnobs = {
    LOG_LEVEL = {
      label = "Log level";
      group = "Logging";
      kind = "select";
      # `warning`, not `warn`: core/logging/bridge-logger.ts honours only debug/warning/error and
      # silently reads everything else as info, so offering `warn` would hand back info-level logs.
      choices = [
        "debug"
        "info"
        "warning"
        "error"
      ];
      description = "Bridge minimum log level and the `debug` flag on its ApplicationConfig; only debug/warning/error are recognised, anything else reads as info. Also stamped into the rendered agent.yaml and the discovery initrd, so it sets the device agent's verbosity too.";
    };
    LOG_FORMAT = {
      label = "Log format";
      group = "Logging";
      kind = "select";
      choices = [
        "console"
        "json"
      ];
      description = "Picks the stdout formatter: `console` gives the colourised human line, anything else emits one-line JSON records carrying app_name/job_id/log_level for the journald pipeline. Console in the sim, json in prod.";
    };
    MONITORING_LOGS_ENABLED = {
      label = "Monitoring logs";
      group = "Logging";
      kind = "bool";
      description = "Keeps HTTP access-log lines for /api/monitoring/ requests instead of dropping them. OFF silences that whole prefix; ON is for debugging the monitoring and metrics endpoints. Successful 200s are filtered out either way.";
    };
    TELEGRAF_ENABLED = {
      label = "Telegraf telemetry";
      group = "Monitoring";
      kind = "bool";
      description = "Per-bridge telegraf agent: scrapes device metrics (ICMP/IPMI/Redfish + PDU SNMP) via the bridge and remote_writes to the local Thanos. OFF removes the telegraf process and leaves the bridge config-writer inert.";
    };
    LIFECYCLE_WORKER_CONCURRENCY = {
      label = "Lifecycle concurrency";
      group = "Workers";
      kind = "number";
      description = "BullMQ concurrency of the lifecycle worker that runs saga.run / diagnostics.run / testing.run. Raising it lets one bridge drive more device sagas at once (more concurrent provisions, more Redis and BMC load); 1 serialises them.";
    };
    COLLECTION_WORKER_CONCURRENCY = {
      label = "Collection concurrency";
      group = "Workers";
      kind = "number";
      description = "BullMQ concurrency of the collection worker that runs the inventory collections auto-enqueued when an agent registers. 1 inventories one device at a time; raise it to collect several devices concurrently.";
    };
    OS_LAYER_URL = {
      label = "OS layer URL";
      group = "Boot/cache";
      kind = "text";
      description = "Base URL of the OS-layer blob store the bridge hands to the device agent: every deploy layer resolves as {OS_LAYER_URL}/sha256:<hash>. Pointing it at the local nginx cache is what lets repeat provisions skip the CDN re-pull.";
    };
    DISCOVERY_BASE_URL = {
      label = "Discovery/ISO base URL";
      group = "Boot/cache";
      kind = "text";
      description = "Root of the brokkr-live artifact tree the bridge syncs from: it fetches {base}/{version}/{arch}/manifest.json and every file that manifest lists (vmlinuz, initrd.img, the discovery ISO) into the dir the iPXE chain serves.";
    };
    BROKKR_LIVE_VERSION = {
      label = "brokkr-live (ISO) version";
      group = "Boot/cache";
      kind = "text";
      description = "Selects which brokkr-live discovery build the bridge syncs, interpolated into the manifest URL and reported to the hub in the leader-election entry. A `latest-*` alias resolves through the manifest's own version pointer and re-checks every boot.";
    };
    BRIDGE_SYNC_ENABLED = {
      label = "Sync/update ISO on boot";
      group = "ISO download";
      kind = "bool";
      description = "Gates the bridge_sync startup task, which downloads or refreshes the discovery images (kernel, initrd, ISO) for every arch at boot. OFF only asserts the images already on disk — a faster boot that serves whatever is there.";
    };
    HTTPS_DOWNLOAD_TIMEOUT = {
      label = "Download timeout (s)";
      group = "ISO download";
      kind = "number";
      description = "Whole-transfer deadline in seconds for each discovery image the sync client downloads; exceeding it aborts that file and burns a retry attempt. Lower it to fail fast on a stalled mirror — values under 30s are rejected as too low for multi-GB ISOs.";
    };
    HTTPS_RETRY_ATTEMPTS = {
      label = "Retry attempts";
      group = "ISO download";
      kind = "number";
      description = "Tries the sync client makes per manifest fetch and per file download (1-10). A retry resumes from the partial .tmp via a Range request, so raising it mostly buys tolerance of a flaky asset host at the cost of a longer failure path.";
    };
    HTTPS_RETRY_DELAY = {
      label = "Retry delay (s)";
      group = "ISO download";
      kind = "number";
      description = "Fixed sleep in seconds between discovery-sync retry attempts, with no backoff. 0 retries immediately; raise it to back off a rate-limiting or recovering asset host.";
    };
    HTTPS_VERIFY_SSL = {
      label = "Verify SSL";
      group = "ISO download";
      kind = "bool";
      danger = true;
      description = "TLS verification for the discovery-sync HTTP client. OFF accepts a self-signed asset host but makes the manifest's own sha256sums attacker-controlled, and startup refuses it outside a simulated or local/dev environment. It does not affect Redfish/BMC TLS.";
    };
    # read-only until a reader exists: presenting an inert knob as editable is what made a save
    # answer ok and change nothing.
    AGENT_SSH_FORCE_REDEPLOY = {
      label = "Force agent redeploy";
      group = "Behavior";
      kind = "bool";
      editable = false;
      description = "Declared for the bridge but read nowhere in apps/bridge or apps/live-agent, so flipping it has no runtime effect today.";
    };
    ANALYTICS_ENABLED = {
      label = "Analytics";
      group = "Behavior";
      kind = "bool";
      editable = false;
      description = "Parsed into the bridge's ApplicationConfig, but nothing downstream reads that field — no analytics client is gated on it today, so flipping it changes only the config value.";
    };
  };

  # hub repo-path override flows to spoke too (monorepo: hub + bridge share the same checkout).
  hubRepoPath = lib.optionalAttrs (config.stackOverrides.hub ? HUB_REPO_PATH) {
    inherit (config.stackOverrides.hub) HUB_REPO_PATH;
  };

  # control-center stack-settings overrides win over the static spoke defaults (but NOT over the
  # per-bridge identity, which mkBridge layers last). Used as the base for every bridge + by spoke:init.
  spokeEnv = baseSpokeEnv // hubRepoPath // config.stackOverrides.spoke;

  # zone-crypto (S1) master switch: only wire the bridge enrollment env when the hub is keyed
  # (zoneCrypto.hubPrivateKey set). Unkeyed → no BROKKR_HUB_URL → bridges stay fully dormant
  # (pre-S1 plaintext), byte-identical to before this knob existed. See modules/zone-crypto.nix.
  hubKeyed = config.zoneCrypto.hubPrivateKey != "";

  # Per-zone Redis ACL (modules/redis-acl.nix): when enabled, each spoke connects as its zone's
  # `brokkr-spoke-<zoneId>` ACL user instead of the open default user, exercising the exact rule
  # self-hosters get. The password is a committed NON-SECRET deterministic constant (URL-safe
  # charset — no percent-encoding needed in REDIS_URL) that the redis-acl:seed task below applies
  # to Redis + the hub DB; it protects nothing (throwaway local sim data on loopback).
  aclEnabled = config.redisAcl.enable;
  simAclPasswordFor = zoneName: "sim-acl-${zoneName}-nonsecret";
  scopedRedisUrlFor =
    zoneId: zoneName:
    "redis://brokkr-spoke-${zoneId}:${simAclPasswordFor zoneName}@${P.hosts.loopback}:${toString P.ports.redis}";

  # Postgres URL for the sim init tasks (mint/seed). Composed from the same port map + identity the
  # hub uses, so the scripts hit the same local DB the hub seeds. Runtime-relative DEVENV_STATE.
  pgUrl = P.mkPgUrl { inherit (config.identity.pg) user password db; };

  # Per-zone runtime registration-token drop dir. The keyed-only mint task writes each zone's
  # freshly minted token to <tokenDir>/<zoneName>.token between hub-healthy and spoke-start; a
  # bridge whose Nix-knob token (zoneCrypto.tokens.<zone>) is empty reads it from there at launch.
  tokenDir = "${config.env.DEVENV_STATE}/zone-crypto/tokens";
  tokenFileFor = zoneName: "${tokenDir}/${zoneName}.token";

  # Env the sim-only init tasks (mint/seed-bmc) need so the sim-gated service paths unlock and the
  # scripts find the local DB + rendered fleet. NODE_ENV stays unset (the sim gate refuses
  # production); HH_ENV=dev is in the default AUTH_BYPASS_ALLOWED_ENVS, so isLocalSimulationEnabled
  # passes. Rendered once, exported in each task's exec.
  simTaskEnv = {
    DATABASE_URL = pgUrl;
    LOCAL_SIMULATION_ENABLED = "true";
    HH_ENV = "dev";
    inherit (config.env) LOCAL_FLEET_PATH DEVENV_STATE; # DEVENV_STATE: BM seal locates baremetal/bmc-creds.json
  };
  exportSimTaskEnv = lib.concatStringsSep "\n" (
    lib.mapAttrsToList (n: v: "export ${n}=${lib.escapeShellArg v}") simTaskEnv
  );

  # zones from the fleet topology, annotated with each zone's contiguous spoke-port base ordinal.
  # A disabled zone starts no bridge, provisions no ACL user and mints no token — everything
  # downstream of this list inherits the filter.
  annotatedZones = Z.withPortBlocks (
    lib.mapAttrsToList (name: z: {
      inherit name;
      inherit (z) index bridges;
    }) (lib.filterAttrs (_: z: z.enable) config.fleet.zones)
  );

  # The process name for bridge `b` of zone `z`. The primary (zone 0, bridge 0) keeps the bare name
  # `spoke` for back-compat; everything else is suffixed and stays globally unique.
  procNameOf =
    z: b:
    if z.index == 0 then
      (if b == 0 then "spoke" else "spoke-${toString b}")
    else
      "spoke-${z.name}${lib.optionalString (b > 0) "-${toString b}"}";

  # One tuple per (zone, HA bridge) — the single source for a bridge's process name, ports and zone
  # UUID. ordinal = zone's base + bridge index → a unique port across the whole fleet (mirrors
  # zones.py:spoke_port_blocks). mkBridge, mkTelegraf, allSpokeNames and the published labBridges
  # roster all consume this list, so the derivation exists exactly once.
  bridgeRoster = lib.concatMap (
    z:
    map (
      b:
      let
        ordinal = z.baseOrdinal + b;
      in
      {
        proc = procNameOf z b;
        zone = z.name;
        replica = b;
        port = P.ports.spoke.base + P.ports.spoke.step * ordinal;
        grpc = P.ports.spokeGrpc.base + P.ports.spokeGrpc.step * ordinal;
        # zone 0 honors the BRIDGE_ZONE_ID override knob (single-zone back-compat); other zones
        # derive their UUID from the index. This is the Redis prefix + Hub Zone UUID for the bridge.
        zoneId = if z.index == 0 then config.env.BRIDGE_ZONE_ID else Z.zoneUuid z.index;
      }
    ) (lib.range 0 (z.bridges - 1))
  ) annotatedZones;

  # Every spoke process name across the fleet (zones × their HA bridges).
  allSpokeNames = map (r: r.proc) bridgeRoster;

  # --- Telegraf (sim port of the prod nomad telegraf task) --------------------------------------
  # Effective toggle: baseSpokeEnv sets it true; a stack override can flip it. Gates BOTH the
  # bridge's writer (via the env above) and the telegraf process set below, so they never drift.
  telegrafEnabled = (spokeEnv.TELEGRAF_ENABLED or "true") == "true";

  # Each bridge writes its per-device inputs to <stateDir>/<bridgeProc>/telegraf.d/owned.conf; the
  # sibling telegraf process watches that dir. State lives under DEVENV_STATE (writable; wiped by
  # local:reset) — the prod /opt/brokkr/telegraf-conf host bind has no sim analogue.
  telegrafConfDirFor = bridgeProc: "${config.env.DEVENV_STATE}/telegraf/${bridgeProc}/telegraf.d";
  telegrafOwnedConfFor = bridgeProc: "${telegrafConfDirFor bridgeProc}/owned.conf";
  # No auth/TLS: the sim's Thanos receive is a loopback-only single-node receiver (devenv.nix).
  thanosRemoteWriteUrl = "http://${P.hosts.loopback}:${toString P.ports.thanosRemoteWrite}/api/v1/receive";
  # Shared SNMPv2c community the rendered owned.conf references as ${PDU_SNMP_COMMUNITY} for PDU
  # polling (matches the prod pdu-bootstrap default); unused when the sim fleet has no PDUs.
  pduSnmpCommunity = "hailhydra123";

  # Per-bridge telegraf base config: [[inputs.internal]] keeps telegraf up before any owned.conf
  # exists; outputs.http remote_writes everything to the sim's Thanos receive. global_tags mirror
  # the prod task (bridge_id + zone).
  mkTelegrafConf =
    bridgeProc: zoneId:
    pkgs.writeText "telegraf-${bridgeProc}.conf" ''
      [agent]
        interval = "30s"
        round_interval = true
        metric_batch_size = 1000
        metric_buffer_limit = 10000
        collection_jitter = "5s"
        flush_interval = "30s"
        flush_jitter = "5s"
        omit_hostname = false

      [global_tags]
        bridge_id = "${bridgeProc}"
        zone = "${zoneId}"

      [[inputs.internal]]

      [[outputs.http]]
        url = "${thanosRemoteWriteUrl}"
        method = "POST"
        data_format = "prometheusremotewrite"
        timeout = "15s"
        [outputs.http.headers]
          Content-Type = "application/x-protobuf"
          Content-Encoding = "snappy"
          X-Prometheus-Remote-Write-Version = "0.1.0"
    '';

  mkBridge =
    r:
    let
      inherit (r)
        proc
        zone
        port
        grpc
        zoneId
        ;
      bridgeStorage = "${spokeEnv.PERSISTENT_STORAGE_PATH}/${proc}";
      env =
        spokeEnv
        // {
          PORT = toString port;
          GRPC_INTERNAL_PORT = toString grpc;
          GRPC_EXTERNAL_PORT = toString grpc;
          BRIDGE_HOSTNAME = proc; # leader-election identity + the host agents dial back; globally unique
          BRIDGE_URL = "http://${if bm then ifaceIp else P.hosts.dataPlaneGateway}:${toString port}";
          BROKKR_ZONE_ID = zoneId;
          REDIS_PREFIX = zoneId;
          PERSISTENT_STORAGE_PATH = bridgeStorage;
          # Where this bridge's TelegrafConfigWriter renders owned.conf; its sibling
          # telegraf process watches the parent dir. BRIDGE_API_URL is the loopback
          # base the rendered inputs scrape (/api/monitoring/ping + /device/sensors).
          TELEGRAF_OWNED_CONF_PATH = telegrafOwnedConfFor proc;
          BRIDGE_API_URL = "http://${P.hosts.loopback}:${toString port}";
        }
        // lib.optionalAttrs aclEnabled {
          # Zone-scoped Redis credential (see redis-acl.nix). The redis-acl:seed task provisions
          # the ACL user before spoke start; ioredis retries cover any startup race.
          REDIS_URL = scopedRedisUrlFor zoneId zone;
        }
        // lib.optionalAttrs config.telemetry.enable {
          # Local observability sink (modules/telemetry.nix): the spoke consumes no
          # secretspec, so the OTLP endpoint is hand-wired here. Resource attrs
          # (bridge_id, zone) derive in-code from BRIDGE_HOSTNAME/BROKKR_ZONE_ID.
          OTEL_EXPORTER_OTLP_ENDPOINT = "http://${P.hosts.loopback}:${toString P.ports.otlpHttp}";
          # Match the sink's 15s cadence — see the hub's OTEL_METRIC_EXPORT_INTERVAL note.
          OTEL_METRIC_EXPORT_INTERVAL = "15000";
        }
        // lib.optionalAttrs hubKeyed {
          # zone-crypto (S1) enrollment, wired only when the hub is keyed (else absent → dormant).
          # BROKKR_HUB_URL is the bridge's master switch + the base for the hub /enroll call (public
          # API). The registration token is PER ZONE (Hub Zone.name): an explicit zoneCrypto.tokens.<z>
          # knob wins; otherwise the sim mint task drops it at tokenFileFor the zone and the exec
          # below exports it at launch (only the leader consults the token; followers load
          # zone_crypto from this zone's Redis). The marker defaults to /var/lib/... (unwritable on
          # macOS), so pin a per-bridge path under the sim's persistent-storage dir.
          BROKKR_HUB_URL = P.urls.hubBase;
          BROKKR_REGISTRATION_TOKEN = config.zoneCrypto.tokens.${zone} or "";
          BRIDGE_REGISTRATION_TOKEN_FILE = tokenFileFor zone;
          BRIDGE_ZONE_CRYPTO_MARKER_PATH = "${bridgeStorage}/zone-crypto.lock";
        };
    in
    {
      name = proc;
      value = {
        # When keyed, a bridge can't enroll without a token, so gate it on the mint task (which runs
        # after hub-api healthy). Unkeyed: no mint task, no dependency — byte-identical to before.
        after = [
          "spoke:init"
          "devenv:processes:redis"
        ]
        ++ lib.optionals pkgs.stdenv.isLinux [ "data-bridge:up" ]
        ++ lib.optionals hubKeyed [ "zone-crypto:mint-tokens" ]
        # The spoke's REDIS_URL carries the zone-scoped ACL credential, so the user must exist
        # before the bridge's first Redis command (or it would sit in auth-retry until seeded).
        ++ lib.optionals (aclEnabled && !config.remoteInfra.enable) [ "redis-acl:seed" ];
        process-compose = {
          environment = lib.mapAttrsToList (n: v: "${n}=${v}") env;
          namespace = "spoke";
          description = "Bridge";
        };
        # Token resolution: the Nix-knob token (already in BROKKR_REGISTRATION_TOKEN) wins; else, if
        # the mint task dropped a non-empty token file, export it. A bridge that already cached its
        # zone_crypto in Redis ignores the token entirely (cache-first bootstrap), so a stale file is
        # harmless.
        exec = ''
          ${cdRepo "HUB_REPO_PATH"}
          export ASSETS_DIR="$PWD/apps/bridge/assets"
          if [ -z "''${BROKKR_REGISTRATION_TOKEN:-}" ] && [ -s "''${BRIDGE_REGISTRATION_TOKEN_FILE:-}" ]; then
            export BROKKR_REGISTRATION_TOKEN="$(cat "$BRIDGE_REGISTRATION_TOKEN_FILE")"
          fi
          # VRRP sim e2e (modules/vrrp-sim.nix, opt-in): put the fake `ip`/`arping` first on PATH
          # so the reconciler binds VIPs against a state file, not a real interface. No-op when unset.
          if [ -n "''${VRRP_SIM_SHIM_DIR:-}" ]; then
            export PATH="$VRRP_SIM_SHIM_DIR:$PATH"
          fi
          BRIDGE_NODE_BIN="''${BRIDGE_NODE_BIN:-node}"
          if [ "$BRIDGE_NODE_BIN" != node ] && [ ! -x "$BRIDGE_NODE_BIN" ]; then
            echo "capped node binary missing at $BRIDGE_NODE_BIN — run the fleet-mode Apply from the control center (provisions the ambient-cap wrapper)" >&2
            exit 1
          fi
          # --watch: restart when spoke-watch rewrites dist. Caps survive reloads — the bm
          # BRIDGE_NODE_BIN is a setcap'd COPY of node, and watch re-execs that same inode.
          exec "$BRIDGE_NODE_BIN" ${lib.optionalString config.spoke.watch "--watch --watch-preserve-output "}apps/bridge/dist/main.js
        '';
        ready = {
          http.get = {
            host = P.hosts.loopback;
            inherit port;
            path = "/api/health";
          };
          initial_delay = 3;
          period = 2;
          probe_timeout = 5;
          failure_threshold = 60;
        };
        # 45s covers the legitimate worst case (telegraf join ≤10s + gRPC force-shutdown 5s +
        # topology-broadcaster join 5s) without hiding a hang the way a fleet-sized 120s would.
        process-compose = {
          shutdown = {
            signal = 15;
            timeout_seconds = 45;
          };
        };
        restart.on = "on_failure";
      };
    };

  # one telegraf process per bridge. prod runs one telegraf per host; the sim co-locates every
  # bridge on one host, so each gets its own watched conf dir + scrape target (BRIDGE_API_URL). The
  # base config keeps it healthy with zero devices, so it can start as soon as its bridge does and
  # buffer/retry remote_writes until thanos is up — no hard cross-module ordering on thanos.
  mkTelegraf =
    r:
    let
      bridgeProc = r.proc;
      confDir = telegrafConfDirFor bridgeProc;
      baseConf = mkTelegrafConf bridgeProc r.zoneId;
    in
    {
      name = "${bridgeProc}-telegraf";
      value = {
        after = [ "devenv:processes:${bridgeProc}" ];
        process-compose = {
          # PDU_SNMP_COMMUNITY backs the ${...} ref the rendered owned.conf emits for PDU SNMP.
          environment = [ "PDU_SNMP_COMMUNITY=${pduSnmpCommunity}" ];
          namespace = "spoke";
          description = "Telegraf";
        };
        # poll (re-stat every 250ms), NOT notify: poll is the only reload trigger that survives
        # prod's container split, where bridge-api and telegraf are separate Docker containers
        # sharing a bind-mounted dir — fsnotify/inotify across that boundary is unreliable (and
        # nonexistent on Docker Desktop). The sim matches prod's trigger for fidelity even though
        # here confDir is a plain shared dir (native co-located processes, no mount): both just
        # reference the same path (TELEGRAF_OWNED_CONF_PATH lives directly under it). The writer's
        # atomic rename means poll only ever sees a complete owned.conf, never a partial write.
        # --watch-interval 30s: the default poll is 250ms, far more often than needed — the writer
        # debounces 30s and only rewrites when the owned-device set changes, so 30s tracks it 1:1.
        exec = ''
          mkdir -p ${lib.escapeShellArg confDir}
          exec ${pkgs.telegraf}/bin/telegraf \
            --config ${baseConf} \
            --config-directory ${lib.escapeShellArg confDir} \
            --watch-config poll \
            --watch-interval 30s
        '';
        restart.on = "on_failure";
      };
    };
in
{
  # Pre-override spoke env published for the control center (modules/overrides.nix). baseSpokeEnv,
  # NOT spokeEnv: the point is the value a knob reverts TO, so neither the stack overrides nor the
  # hub's HUB_REPO_PATH passthrough may be folded in.
  stackDefaults.spoke = baseSpokeEnv;

  knobMeta = envKnobMeta lib "spoke" { } spokeKnobs;

  # Public view of the roster: same tuples, minus the zone UUID (already on the hub's Zone rows).
  # Empty under remoteInfra for the same reason `processes` is — no local bridge exists to name.
  labBridges = lib.optionals (!config.remoteInfra.enable) (
    map (r: {
      inherit (r)
        proc
        zone
        replica
        port
        grpc
        ;
    }) bridgeRoster
  );

  tasks = {
    "spoke:init" = {
      description = "spoke: build apps/bridge (NestJS) + the device agent via turbo, stage the agent bundle to the per-slot agent dir, create the persistent-storage dir.";
      after = [ "hub:init" ];
      exec = ''
        . "${config.devenv.root}/devenv/lib/with-task-log.sh"
        begin_task_log "spoke:init"
        ${cdRepo "HUB_REPO_PATH"}
        mkdir -p "${spokeEnv.PERSISTENT_STORAGE_PATH}/initrd-builds"
        ${lib.concatMapStringsSep "\n" (name: ''
          mkdir -p "${spokeEnv.PERSISTENT_STORAGE_PATH}/${name}"
          ln -sfn "${spokeEnv.PERSISTENT_STORAGE_PATH}/initrd-builds" "${spokeEnv.PERSISTENT_STORAGE_PATH}/${name}/initrd-builds"
        '') allSpokeNames}
        ${
          if config.spoke.watch then
            ''
              # spoke-watch owns apps/bridge/dist under watch — it recompiles on every source change, so
              # rebuilding here is redundant AND harmful: turbo rewrites its outputs even on a cache hit,
              # and this task re-runs on every Apply / spoke restart, which `node --watch` answers by
              # SIGTERMing a live, healthy bridge. Build only to seed a cold tree (nothing is running yet
              # to restart); the watcher's initial full pass converges anything the seed left stale.
              [ -s apps/bridge/dist/main.js ] || pnpm exec turbo run build --filter=bridge
              # the agent bundle has no watcher, so it must stay fresh every run — but --only keeps turbo
              # off its dependency closure (packages/*/dist, hub:init's output, which the bridge loads).
              # live-agent's build script runs `pnpm gen` itself, so --only drops no codegen.
              pnpm exec turbo run build --filter=bridge-agent --only
            ''
          else
            # no watcher and no `node --watch`: a dist rewrite reloads nothing, so build both outright.
            "pnpm exec turbo run build --filter=bridge --filter=bridge-agent"
        }
        # Build the native afpacket addon (BSD BPF/AF_PACKET) the DHCP server loads; `nest build` skips
        # it, so macOS DHCP silently falls back to the unusable dgram :67 path. pnpm exec keeps it hermetic.
        if [ ! -f apps/bridge/native/afpacket/build/Release/afpacket.node ]; then
          ( cd apps/bridge/native/afpacket && pnpm exec node-gyp rebuild ) \
            || echo "WARN: afpacket addon build failed — macOS network.dhcp mode needs it (bridge DHCP receive)"
        fi
        mkdir -p "${paths.agent}"
        ln -sf "$PWD/apps/live-agent/dist/main.js" "${paths.agent}/main.js"
        ln -sf "$PWD/apps/live-agent/systemd/brokkr-bridge-agent.service" "${paths.agent}/brokkr-bridge-agent.service"
      '';
    };
  }
  # Per-zone Redis ACL provisioning for the SQL-seeded sim zones (modules/redis-acl.nix). Sim
  # zones bypass createZone (sql-seed/45-zone.py inserts rows directly), so nothing provisions
  # their ACL users — this task applies each zone's user with the committed deterministic sim
  # password (hash → ZoneRedisCredential, ACL SETUSER → Redis) so the spokes' scoped REDIS_URL
  # works. Idempotent: SETUSER reset + hash upsert converge on the same state every run, and the
  # hub's startup reconcile maintains the same users thereafter.
  // lib.optionalAttrs (aclEnabled && !config.remoteInfra.enable) {
    "redis-acl:seed" = {
      description = "sim redis-acl: provision each seeded zone's brokkr-spoke-<zoneId> ACL user (deterministic non-secret sim password) so spokes can connect with zone-scoped credentials. Idempotent.";
      after = [
        "hub:init"
        "sim:seed"
        "devenv:processes:redis"
      ];
      exec = ''
        set -euo pipefail
        . "${config.devenv.root}/devenv/lib/with-task-log.sh"
        begin_task_log "redis-acl:seed"
        ${cdRepo "HUB_REPO_PATH"}
        ${exportSimTaskEnv}
        export REDIS_URL=${lib.escapeShellArg P.urls.redis}
        ${lib.concatStringsSep "\n" (
          map (z: ''
            echo "→ provisioning Redis ACL user for zone ${z.name}"
            pnpm --silent --filter api seed:sim-redis-acl -- --zone-name ${lib.escapeShellArg z.name} --password ${lib.escapeShellArg (simAclPasswordFor z.name)}
          '') annotatedZones
        )}
      '';
    };
  }
  # zone-crypto sim self-enrollment DAG — only when the hub is keyed (the local-dev default; see
  # modules/zone-crypto.nix). Under remoteInfra (gone today) or an explicitly dormant hub, neither
  # task exists and the bridges keep the pre-S1 plaintext path.
  // lib.optionalAttrs (hubKeyed && !config.remoteInfra.enable) {
    # Mint one registration token per zone, AFTER hub-api healthy and BEFORE spoke start (a bridge
    # needs a token to enroll). Runs the hub-side script under the sim env so its
    # LOCAL_SIMULATION_ENABLED gate unlocks. Idempotency is two-layered: `status` skips the task
    # entirely once a zone is enrolled or already holds a live token (so spoke restarts don't
    # re-mint), and `--reuse-file` makes any run that does execute re-emit the existing live token
    # instead of expiring + reminting (the backstop for a run that races past status).
    "zone-crypto:mint-tokens" = {
      description = "sim self-enroll: mint a per-zone registration token (sim-gated, non-interactive) so each bridge enrolls against the LOCAL hub. Re-run-safe: reuses a still-live token (--reuse-file) so the closure's repeat runs don't churn.";
      after = [
        "hub:init"
        "sim:seed"
        "devenv:processes:hub-api"
      ];
      # Skip re-running on spoke restarts WITHOUT ever leaving the bridge unable to re-enroll.
      # process-compose starts each process via `devenv-tasks run --mode all <task>`, which re-runs
      # the whole closure — and the spoke has max_restarts=5, so a flappy fresh boot would re-mint
      # (expiring the prior token) several times. status makes this a no-op ONLY while every zone's
      # token file still holds a LIVE unused token — which both dedupes the restart churn AND keeps
      # a usable token on disk. Deliberately NOT short-circuited on "zone already enrolled": the
      # bridge consumes its token at enroll and MUST re-enroll (with a fresh token) after a Redis
      # cache-miss, so once the on-disk token is consumed/expired this must fail and let exec mint a
      # fresh one. Any concurrent run that slips past status is made harmless by --reuse-file in
      # exec. status errors → not-satisfied → task runs (safe default). node does the hashing.
      status = ''
        ${exportSimTaskEnv}
        ${lib.concatStringsSep "\n" (
          map (z: ''
            f=${lib.escapeShellArg (tokenFileFor z.name)}
            [ -s "$f" ] || exit 1
            tok="$(cat "$f")"
            [ -n "$tok" ] || exit 1
            h="$(node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$tok")"
            # zone name reaches the SQL via a shell var (shell-escaped, single quotes pre-doubled)
            # so a quote/metachar in the name can't break out of the literal.
            zn=${lib.escapeShellArg (lib.replaceStrings [ "'" ] [ "''" ] z.name)}
            live="$(psql "$DATABASE_URL" -tAc "SELECT count(*) FROM \"ZoneRegistrationToken\" t JOIN \"Zone\" z ON z.id = t.\"zoneId\" WHERE z.name = '$zn' AND z.\"deletedAt\" IS NULL AND t.\"tokenHash\" = '$h' AND t.\"consumedAt\" IS NULL AND t.\"expiresAt\" > now()" 2>/dev/null || echo 0)"
            [ "$live" = "1" ] || exit 1
          '') annotatedZones
        )}
        exit 0
      '';
      exec = ''
        set -euo pipefail
        . "${config.devenv.root}/devenv/lib/with-task-log.sh"
        begin_task_log "zone-crypto:mint-tokens"
        ${cdRepo "HUB_REPO_PATH"}
        ${exportSimTaskEnv}
        mkdir -p ${lib.escapeShellArg tokenDir}
        ${lib.concatStringsSep "\n" (
          map (z: ''
            echo "→ minting registration token for zone ${z.name}"
            # --reuse-file makes re-runs idempotent: this task runs once per dependent in its
            # devenv-tasks closure (~5x on a fresh `task up`), and each mint expires the prior unused
            # token. Passing the token file lets the script re-emit the SAME token when it is still a
            # live unused row — so repeated runs converge on one stable token instead of churning and
            # expiring the one the bridge froze at launch (the intermittent enroll-410 race).
            #
            # `pnpm --silent` still echoes the "> api@0.0.0 mint:sim-token / > tsx …" run preamble to
            # stdout; strip those `>` lines and blanks so ONLY the minted token reaches the file (the
            # script emits the token as the last stdout line; its own logs go to stderr). A base64url
            # token never starts with `>`. `|| true` keeps `set -e`/pipefail from tripping when grep
            # filters everything out (the already-enrolled path emits no token).
            tok="$(pnpm --silent --filter api mint:sim-token -- --zone-name ${lib.escapeShellArg z.name} --reuse-file ${lib.escapeShellArg (tokenFileFor z.name)} 2>/dev/null \
              | grep -vE '^>|^[[:space:]]*$' | tail -n1 || true)"
            # Empty stdout = already enrolled (no token needed) OR a soft failure; write what we got
            # (the bridge exec only exports a NON-empty file, so an empty drop is a no-op).
            printf '%s' "$tok" > ${lib.escapeShellArg (tokenFileFor z.name)}
          '') annotatedZones
        )}
      '';
    };

    # Seal each sim Server's BMC creds into the DB, AFTER the spokes are up so their async
    # enrollment can complete — the script itself polls each zone's ZoneEnrollment before sealing.
    # Reuses the hub-side X25519 seal-on-write; idempotent (skipIfLivePresent re-seals only a
    # re-keyed zone). Depends on every spoke process being healthy.
    "zone-crypto:seed-bmc" = {
      description = "sim self-enroll: re-seal BMC creds into the DB each up — vm mode seals sim Servers (seed:sim-bmc), baremetal mode seals the commissioned box (seed:baremetal-bmc, skipped if no bmc-creds.json). Polls ZoneEnrollment first. Idempotent.";
      # sim:seed (fleet.nix) creates the Server Device rows this seals against; spokes must be up so
      # their async enrollment can complete (the script also polls ZoneEnrollment before sealing).
      after = [
        "hub:init"
        "sim:seed"
      ]
      ++ map (name: "devenv:processes:${name}") allSpokeNames;
      exec = ''
        set -euo pipefail
        . "${config.devenv.root}/devenv/lib/with-task-log.sh"
        begin_task_log "zone-crypto:seed-bmc"
        ${cdRepo "HUB_REPO_PATH"}
        ${exportSimTaskEnv}
        # Both seals self-skip on the wrong mode (parseFleetMode on LOCAL_FLEET_PATH), so this body
        # needs no mode branch — an eval-time one churns the tasks.json path every command embeds.
        pnpm --filter api seed:sim-bmc
        # Only guard the bm seal reads no file for: it throws on a missing bmc-creds.json, which is
        # right for the lab Apply / sim:bm:reconcile paths that write creds first.
        creds="$DEVENV_STATE/baremetal/bmc-creds.json"
        if [ -f "$creds" ]; then
          pnpm --filter api seed:baremetal-bmc
        else
          echo "[seed-bmc] no $creds — skipping bare-metal BMC seal (box not yet commissioned)"
        fi
      '';
    };
  };

  # one process per (zone, bridge): the NestJS bridge (apps/bridge/dist/main.js), plus one shared
  # spoke-watch compiler. Under remoteInfra (dev/stg) no local spoke runs — the deployed dev/stg
  # bridge owns the zone, and a local bridge would compete for the zone's BullMQ leader election
  # and could dispatch ops to real hardware.
  processes = lib.optionalAttrs (!config.remoteInfra.enable) (
    lib.listToAttrs (
      map mkBridge bridgeRoster ++ lib.optionals telegrafEnabled (map mkTelegraf bridgeRoster)
    )
    // lib.optionalAttrs config.spoke.watch {
      # ONE watch compiler for all bridges (they share apps/bridge/dist; per-bridge nest --watch
      # would race N compilers on one outDir). build:watch skips the outDir clean so the initial
      # pass never rips dist out from under the already-running bridges.
      spoke-watch = {
        after = [ "spoke:init" ];
        process-compose = {
          namespace = "spoke";
          description = "Bridge build watcher";
        };
        exec = ''
          ${cdRepo "HUB_REPO_PATH"}
          exec pnpm --filter bridge build:watch
        '';
        restart.on = "on_failure";
      };
    }
  );
}
