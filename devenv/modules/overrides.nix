{ config, lib, ... }:

# Declarative hook for control-center stack-settings overrides. The control center writes a
# single gitignored stack.local.nix at the repo root (setting stackOverrides.{hub,spoke}); the
# committed devenv.nix conditionally imports it. The hub/spoke modules merge these onto their
# per-process env, so a UI knob override is just Nix data — no external JSON, no sourced shim.
let
  # per-slot port map (modules/ports.nix `forSlot`) — the canonical defaults for the port
  # options below. Promoting them to options (rather than a plain import) is what lets the
  # control center override the datastore/service ports via stack.local.nix; ports.nix
  # `fromConfig` reads these back.
  P0 = import ./ports.nix;
  slotPorts = P0.forSlot config.stack.slot;
  port =
    default:
    lib.mkOption {
      type = lib.types.port;
      inherit default;
    };
  baseStep = d: {
    base = port d.base;
    step = lib.mkOption {
      type = lib.types.int;
      default = d.step;
    };
  };

  # The editable/read-only split is data, not prose: options.ports below is the merge of these two
  # groups and options.portGroups publishes their key sets, so the control center reads the
  # partition instead of re-deriving it. Merging keeps config.ports one flat map for consumers.
  editablePorts = {
    nginx = port slotPorts.nginx; # OS-layer cache
    mailpitSmtp = port slotPorts.mailpitSmtp; # local email catcher (processes.mailpit) — SMTP
    mailpitWeb = port slotPorts.mailpitWeb; # mailpit web UI
    redfish = port slotPorts.redfish; # sushy-emulator (SIM_REDFISH_PORT)
    postgres = port slotPorts.postgres;
    redis = port slotPorts.redis;
    thanosHttp = port slotPorts.thanosHttp;
    thanosGrpc = port slotPorts.thanosGrpc;
    thanosRemoteWrite = port slotPorts.thanosRemoteWrite;
  };

  # the control center's own ports, the hub/spoke replica port math, and the loopback-only
  # observability sink (modules/telemetry.nix) — declared here so config.ports is the whole map.
  readOnlyPorts = {
    thanosQueryHttp = port slotPorts.thanosQueryHttp; # thanos query frontend (Prometheus HTTP API)
    thanosQueryGrpc = port slotPorts.thanosQueryGrpc; # thanos query internal gRPC
    lab = port slotPorts.lab;
    labWeb = port slotPorts.labWeb;
    hubWeb = port slotPorts.hubWeb;
    hubWebAdmin = port slotPorts.hubWebAdmin;
    hubApi = baseStep slotPorts.hubApi;
    hubAdmin = baseStep slotPorts.hubAdmin;
    spoke = baseStep slotPorts.spoke;
    spokeGrpc = baseStep slotPorts.spokeGrpc;
    otlpGrpc = port slotPorts.otlpGrpc; # otel-collector OTLP gRPC ingest
    otlpHttp = port slotPorts.otlpHttp; # otel-collector OTLP HTTP ingest (hub exporter target)
    otelcolHealth = port slotPorts.otelcolHealth; # otel-collector readiness endpoint
    tempoHttp = port slotPorts.tempoHttp; # tempo query API (grafana datasource)
    tempoGrpc = port slotPorts.tempoGrpc; # tempo internal server gRPC
    tempoOtlpGrpc = port slotPorts.tempoOtlpGrpc; # collector -> tempo OTLP
    tempoOtlpHttp = port slotPorts.tempoOtlpHttp;
    grafana = port slotPorts.grafana; # grafana UI
    lokiHttp = port slotPorts.lokiHttp; # loki query API + native OTLP logs ingest
    lokiGrpc = port slotPorts.lokiGrpc; # loki internal server gRPC
  };
in
{
  options.stack = {
    slot = lib.mkOption {
      type = lib.types.ints.between 0 46;
      default = 0;
      description = ''
        Multi-stack instance slot. 0 = legacy single-stack layout (byte-identical
        to pre-slot behavior). Slots >=1 derive disjoint ports (20000+500*S blocks),
        subnets (192.168.(200+S)/(105+S)), MACs, node names, and state paths so
        multiple worktrees can run concurrent stacks.
      '';
    };
    fleetNodeCount = lib.mkOption {
      type = lib.types.ints.between 1 4;
      default = if config.stack.slot == 0 then 4 else 1;
      description = "Nodes in the sim fleet. Slots >=1 default to a single node; CI sets 4.";
    };
  };

  options.stackOverrides = {
    hub = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Hub env overrides from the control center (knob env name → value). AUTH_BYPASS_ENABLED is mapped to LOCAL_SIMULATION_ENABLED in modules/hub.nix.";
    };
    spoke = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Spoke env overrides from the control center (knob env name → value). Merged onto the static spoke env in modules/spoke.nix.";
    };
  };

  # Instance counts persisted alongside the env overrides so the overlay is the single source
  # the control center reads back (via `devenv eval`). Applied to the running stack via
  # process-compose scale; not consumed by the modules here.
  options.stackCounts = {
    hub = lib.mkOption {
      type = lib.types.int;
      default = 1;
      description = "Hub replica count.";
    };
    spoke = lib.mkOption {
      type = lib.types.int;
      default = 1;
      description = "Spoke replica count.";
    };
  };

  # Whether `devenv up` auto-starts the simulated fleet. Declared here with the other
  # local-config / control-center knobs; consumed by modules/fleet.nix (the `fleet` process
  # is `disabled` when false). Set in devenv.local.nix for a control-plane-only bring-up.
  options.fleet.autoStart = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "Whether `devenv up` auto-starts the simulated fleet (build artifacts, power on the VMs). False brings up only the control plane; start the fleet on demand from the control center or with `devenv processes start fleet`.";
  };

  # Local observability sink (modules/telemetry.nix): otel-collector + tempo + grafana as
  # `observability`-namespace processes, plus the hub's OTLP exporter env (modules/hub.nix).
  # Off by default — the hermetic stack pays nothing. Written by the control center into
  # stack.local.nix (like lan.expose), or set by hand in devenv.local.nix. When false the
  # processes stay defined-but-disabled (startable on demand from the control center or
  # `devenv processes start`), but the hub exporter env only points at the collector while
  # the option is true — it renders at eval time, so flipping it needs a hub-api restart.
  options.telemetry.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Bring up the local telemetry sink (OTel collector -> Tempo traces + span-metrics -> Thanos, Grafana UI at the `grafana` port) and point the hub's OTLP exporter at it.";
  };

  # LAN exposure toggle. When true, the otherwise loopback-only datastores/services (postgres,
  # redis, thanos, mailpit, lab, lab-web, hub web) bind 0.0.0.0 for LAN/Tailscale reach instead of
  # 127.0.0.1 — consumed by modules/ports.nix `bindHost` + devenv.nix (pg_hba / redis protected-mode).
  # Set via the control center (written into stack.local.nix) or in devenv.local.nix.
  options.lan.expose = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Whether the loopback-only datastores/services bind 0.0.0.0 (LAN/Tailscale reach) instead of 127.0.0.1. Written by the control center into stack.local.nix.";
  };

  # Gate that, when true, would run the local hub compute against REMOTE infra (skipping the local
  # datastores/spoke/fleet/control-center + local migrate/seed). The dev/stg profiles that set it
  # true were removed (local-against-shared-infra caused contention + auth-bypass-seed risk), so it
  # now stays at its always-false default — only the hermetic local stack runs. The option is kept
  # because hub.nix / spoke.nix / fleet.nix / devenv.nix still branch on it.
  options.remoteInfra.enable = lib.mkOption {
    type = lib.types.bool;
    default = false;
    description = "Gate to run local hub compute against REMOTE infra (skip local datastores, spoke, fleet, control center, local migrate/seed). Always false now — the dev/stg profiles that set it true were removed; kept because other modules branch on it.";
  };

  # Gate the spoke's dev hot-reload: `node --watch` + the sibling `spoke-watch` (`nest build --watch`)
  # compiler. When false, the spoke runs the already-built dist ONCE (spoke:init builds it) with no
  # watcher. Set false for automated / CI / CONCURRENT sim: the decoupled build:watch -> dist-rewrite
  # -> `node --watch` restart races fleet:apply and flakes bring-up. (The hub avoids this by running
  # an integrated `nest start --watch` — see hub.nix.)
  options.spoke.watch = lib.mkOption {
    type = lib.types.bool;
    default = true;
    description = "Run the spoke under dev hot-reload (node --watch + the spoke-watch nest-build watcher). Set false for automated/CI/concurrent sim to build once and run the static dist, avoiding the shared-dist restart race with fleet:apply.";
  };

  # Service identity (the single source for who, not where — modules/ports.nix owns host:port).
  # devenv.nix + modules/hub.nix derive the postgres URL, services.postgres.initialDatabases, and the
  # org id from these; the control center writes them into stack.local.nix like the stackOverrides above.
  # NOTE: changing pg.{user,password,db} only takes effect on a fresh Postgres datadir (initialDatabases
  # runs once); an org-id change needs a reseed to propagate to the seeded org.
  options.identity = {
    pg = {
      user = lib.mkOption {
        type = lib.types.str;
        default = "brokkr";
        description = "Postgres role the hub + sim connect as (also the created role).";
      };
      password = lib.mkOption {
        type = lib.types.str;
        default = "password";
        description = "Postgres password (local dev).";
      };
      db = lib.mkOption {
        type = lib.types.str;
        default = "brokkr";
        description = "Postgres database name.";
      };
    };
    orgId = lib.mkOption {
      type = lib.types.str;
      default = "00000000-0000-0000-0000-000000000000";
      description = "Instance-operator org UUID — hub BROKKR_ADMIN_ORG_ID + sim SIM_HYDRAHOST_ORG_ID derive from this single value.";
    };
  };

  # OS-layer cache (nginx) upstream — the CDN origin the local cache proxies + its DNS resolvers.
  # originHost is the single source of truth for the asset origin across the Nix layer: spoke.nix's
  # DISCOVERY_BASE_URL derives from it, mirroring the TS knob (ASSET_ORIGIN) and local-sim's
  # SIM_OS_LAYERS_MANIFEST_INDEX_URL. Defaults to the asset host; override per env via this knob.
  options.osLayerCache = {
    originHost = lib.mkOption {
      type = lib.types.str;
      default = "brokkr.assets.hydra.host";
      description = "CDN asset origin host the OS-layer cache proxies to (default; override per env).";
    };
    resolvers = lib.mkOption {
      type = lib.types.str;
      default = "1.1.1.1 8.8.8.8";
      description = "DNS resolvers nginx uses to re-resolve the rotating CDN origin IPs.";
    };
  };

  # The canonical port/host map promoted to options (defaults from modules/ports.nix). devenv.nix +
  # the hub/spoke modules read the effective values via `(import ./ports.nix).fromConfig config`, so
  # an override here ripples to the service bind, every readiness probe, the derived URLs, and the
  # labPortEnv the TS apps read. The control center surfaces ONLY the editable group as editable;
  # everything else stays read-only in the UI.
  options.ports = editablePorts // readOnlyPorts;

  options.portGroups = {
    editable = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = lib.attrNames editablePorts;
      description = "config.ports keys the control center may override (single-value datastore/service ports).";
    };
    readOnly = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = lib.attrNames readOnlyPorts;
      description = "config.ports keys the control center shows but must not override (its own ports, the hub/spoke replica port math, the observability sink).";
    };
  };

  # Hosts stay non-overridable (not editable in the control panel, and `hosts` is already a
  # top-level devenv option via the hostctl integration). They keep deriving from the static
  # defaults in modules/ports.nix — see `fromConfig` there.

  # Read-only outputs the control center reads back via `devenv eval` — set by the modules that own
  # the data, never by an overlay. They exist so the TS side stops hand-copying values Nix already
  # derives; each carries the PRE-override view, since exposing a post-merge value would show a
  # user's own override as the default and make it unrevertable.

  # config.ports is post-merge, so it cannot answer "is this value an override?" — an overridden port
  # and an untouched one read identically. Read the defaults back OUT of editablePorts so the pair
  # cannot drift, the same way portGroups.editable takes its key set from that binding.
  options.portDefaults = lib.mkOption {
    type = lib.types.attrsOf lib.types.port;
    default = lib.mapAttrs (_: opt: opt.default) editablePorts;
    description = "Pre-override value of every portGroups.editable key (modules/ports.nix defaults). The control center diffs config.ports against this to decide which ports its overlay must pin.";
  };

  options.stackDefaults = {
    hub = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Hub env before stackOverrides.hub is merged (modules/hub.nix baseHubEnv). Sensitive contract secrets are dropped whenever the hub injects them at launch instead of rendering them at eval — the same gate its process env uses.";
    };
    spoke = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Spoke env before stackOverrides.spoke is merged (modules/spoke.nix baseSpokeEnv). Per-bridge identity (PORT/gRPC/hostname/zone) is deliberately absent — see labBridges.";
    };
    hubKnobEnv = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
      description = "Hub knobs whose control-center name is not an env key, mapped to the env keys modules/hub.nix writes for them. A knob absent here is 1:1 with its key in stackDefaults.hub.";
    };
  };

  options.labBridges = lib.mkOption {
    type = lib.types.listOf (
      lib.types.submodule {
        options = {
          proc = lib.mkOption {
            type = lib.types.str;
            description = "process-compose process name.";
          };
          zone = lib.mkOption {
            type = lib.types.str;
            description = "Fleet zone (modules/fleet-topology.nix) this bridge belongs to.";
          };
          replica = lib.mkOption {
            type = lib.types.int;
            description = "0-based HA bridge index within the zone.";
          };
          port = lib.mkOption {
            type = lib.types.port;
            description = "Bridge HTTP port.";
          };
          grpc = lib.mkOption {
            type = lib.types.port;
            description = "Bridge gRPC port.";
          };
        };
      }
    );
    default = [ ];
    description = "Every bridge process across every zone, from the same tuple modules/spoke.nix builds each spoke process from — so nothing has to re-implement the zone × HA-bridge name/port math.";
  };
}
