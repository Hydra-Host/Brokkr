{
  pkgs,
  lib,
  config,
  ...
}:

# Foundation devenv layer for the brokkr-app monorepo: the reproducible toolchain
# (sim Python via the patched Nix overlay + the qemu/libvirt virt stack) and the
# native datastores (postgres/redis/nginx). One source of truth for the patched
# package set, so the legacy brew + .venv + patch-reapply loop is gone.
#
# The hub + spoke live in their own modules (./devenv/modules/hub.nix, ./devenv/modules/spoke.nix), imported
# below — each declares its process, its per-process env, and its DAG init tasks. Their
# app env rides on process-compose's per-process `environment`, NOT the `env` block below,
# which stays foundation-only (sim engine + virt stack). The local-lab/local-lab-web
# control-center processes still live here.
let
  # one source of truth for the sim python env; reused for LOCAL_PYTHON_BIN so the
  # sim engine (sim/scripts/local/config.py) resolves sushy + the engine deps from the
  # same store path it runs from.
  pythonEnv = import ./devenv/pkgs/python-env.nix {
    python3Packages = pkgs.python312Packages;
  };

  # node + pnpm shared with devenv/flake.nix (the CI ciImage) so dev and CI can't drift.
  jsTools = import ./devenv/pkgs/js-tools.nix { inherit pkgs; };

  # Nix qemu ships its EDK2 firmware blobs in the store, not under /usr/share —
  # these arch-explicit names match what host_os.detect_edk2_* already probes.
  qemuShare = "${pkgs.qemu}/share/qemu";
  edk2Code =
    if pkgs.stdenv.isAarch64 then
      "${qemuShare}/edk2-aarch64-code.fd"
    else
      "${qemuShare}/edk2-x86_64-code.fd";
  edk2Vars =
    if pkgs.stdenv.isAarch64 then "${qemuShare}/edk2-arm-vars.fd" else "${qemuShare}/edk2-i386-vars.fd";
  qemuEmulator =
    if pkgs.stdenv.isAarch64 then
      "${pkgs.qemu}/bin/qemu-system-aarch64"
    else
      "${pkgs.qemu}/bin/qemu-system-x86_64";

  # macOS-only: rootless-qemu vmnet bridge helper. Lazy — only forced under the
  # isDarwin branches below, so Linux devenv never builds the Darwin derivation.
  socketVmnet = pkgs.callPackage ./devenv/pkgs/socket_vmnet.nix { };

  openipmi = pkgs.callPackage ./devenv/pkgs/openipmi.nix { };

  processCompose = pkgs.process-compose;

  # the single privileged helper the fleet shells out to as root (sudo-rs–native; scope enforced
  # in code). Pins ipmi_sim's store path so `ipmi-launch` execs the same immutable binary.
  simPriv = pkgs.callPackage ./devenv/pkgs/sim-priv.nix { inherit openipmi; };

  # canonical sim zone UUID. config.py reads it via BRIDGE_ZONE_ID; the spoke derives
  # BROKKR_ZONE_ID + REDIS_PREFIX from it (wired on the spoke process when it's added).
  zoneId = "00000000-0000-0000-0000-111111111111";

  # single source of truth for every host:port + derived route; the hub/spoke modules import the
  # same map. ports/URLs below interpolate off this — no literal is repeated. `fromConfig` returns
  # the effective ports/hosts (defaults from ports.nix, overridable via config.ports/config.hosts)
  # plus the urls/labPortEnv/mkPgUrl derived from them.
  P = (import ./devenv/modules/ports.nix).fromConfig config;

  # postgres connection URL composed from the port map (where) + config.identity.pg (who); the
  # control center overrides identity via stack.local.nix. initialDatabases below uses the same source.
  pgUrl = P.mkPgUrl { inherit (config.identity.pg) user password db; };

  # bake a leading ~ / $HOME in the polyrepo defaults into an absolute path at eval time, so the
  # derived HUB_REPO_PATH is usable by consumers that don't expand at use-site
  # (see modules/lib.nix:expandHome). HOME is read impurely (devenv evaluates --impure).
  expandHome = (import ./devenv/modules/lib.nix).expandHome lib (builtins.getEnv "HOME");

  repoRoot = config.devenv.root;

  # this slot's spoke storage root, from the same derivation modules/spoke.nix feeds
  # PERSISTENT_STORAGE_PATH — so stack-wipe-images can never wipe another slot's images.
  spokeStorage = ((import ./devenv/modules/spoke-paths.nix).forSlot config.stack.slot).storage;

  # the hermetic local stack (native datastores + control center + seed). False under the dev/stg
  # profiles (remoteInfra.enable), where only hub-api + hub-web run against remote infra.
  localStack = !config.remoteInfra.enable;
in
{
  # ./devenv/modules/overrides.nix declares the stackOverrides option; the control center writes a
  # gitignored ./stack.local.nix that sets it (imported only when present — devenv evaluates
  # gitignored files, same as the auto-imported devenv.local.nix). ./stack.slot.nix (also
  # gitignored) is the claim script's slot pin — written at lib.mkDefault priority only,
  # so a plain-priority stack.local.nix/devenv.local.nix slot always outranks it. ./env.local.nix is
  # the same shape for the environment pins (modules/env-pins.nix) and pins at mkOverride 60, which
  # is why it is imported after stack.local.nix and still wins.
  imports = [
    ./devenv/modules/hub.nix
    ./devenv/modules/spoke.nix
    ./devenv/modules/zone-crypto.nix
    ./devenv/modules/redis-acl.nix
    ./devenv/modules/overrides.nix
    ./devenv/modules/env-pins.nix
    ./devenv/modules/sudo.nix
    ./devenv/modules/fleet.nix
    ./devenv/modules/fleet-topology.nix
    ./devenv/modules/polyrepo.nix
    ./devenv/modules/profiles.nix
    ./devenv/modules/dx.nix
    ./devenv/modules/vrrp-sim.nix
    ./devenv/modules/telemetry.nix
    ./devenv/modules/agent-tooling.nix
  ]
  ++ lib.optionals (builtins.pathExists ./stack.local.nix) [ ./stack.local.nix ]
  ++ lib.optionals (builtins.pathExists ./env.local.nix) [ ./env.local.nix ]
  ++ lib.optionals (builtins.pathExists ./stack.slot.nix) [ ./stack.slot.nix ];

  # upstream tagged v2.2.2 with src/modules/latest-version still reading 2.2.1, so the built-in
  # update check nags for a release that does not exist. Track the tag the lock actually pins.
  devenv.latestVersion = "2.2.2";

  overlays = [
    (import ./devenv/pkgs/python-overlay.nix)
    (import ./devenv/pkgs/process-compose-overlay.nix)
    (import ./devenv/pkgs/statix-overlay.nix)
  ];

  languages.python = {
    enable = true;
    package = pythonEnv;
  };

  # node + pnpm for the pnpm workspace (apps/*) and the hub/spoke checkouts. pnpm.enable
  # only puts pnpm on PATH; pnpm.install stays off (default) — workspace installs are
  # explicit bring-up steps, not a shell-entry side effect.
  languages.javascript = {
    enable = true;
    package = jsTools.nodejs; # node — shared with the CI image via js-tools.nix
    # pnpm pinned to package.json's packageManager (pnpm@11.x); shared with the CI image.
    pnpm = {
      enable = true;
      package = jsTools.pnpm;
    };
  };

  # repo-wide formatting/lint authority. The shared treefmt-nix module is the single source of
  # truth (also evaluated by devenv/flake.nix for the CI wrapper). Wired into the pre-commit
  # gate by git-hooks.hooks.treefmt (devenv/modules/dx.nix).
  treefmt = {
    enable = true;
    config.imports = [ ./devenv/treefmt-module.nix ];
  };

  # self-healing `pnpm install`. The hub/spoke checkouts are external, developer-owned
  # repos whose node_modules can't be nix-managed without breaking the edit loop, so install
  # stays an imperative bring-up step — but packaged as a declarative, reproducible command
  # (helper unix tools pinned; node + pnpm come from languages.javascript on the ambient
  # devenv PATH that tasks + `devenv shell` both carry). Happy path is a plain incremental
  # install; ONLY on the node_modules-collision class (ERR_PNPM_ENOTEMPTY / EEXIST from
  # rename-over-non-empty-dir on a hoisted layout, or an incompatible modules dir pnpm wants
  # to recreate) does it purge THIS repo's node_modules and retry once — the global
  # content-addressed store is untouched, so the retry relinks fast. Runs in $PWD; callers
  # (hub:init/spoke:init/apps:init) cd into the target repo first.
  scripts.brokkr-pnpm-install = {
    description = "pnpm install with self-heal: on a node_modules collision, purge THIS repo's node_modules and retry once.";
    packages = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.gnugrep
    ];
    # body in devenv/scripts/brokkr-pnpm-install.sh so the bats suite can drive it directly.
    exec = ''exec bash "${repoRoot}/devenv/scripts/brokkr-pnpm-install.sh" "$@"'';
  };

  packages = [
    pkgs.git
    pkgs.ruff # rust binary in nixpkgs, excluded from python-env.nix
    pkgs.allure # allure report CLI (generate/serve) for the e2e suite
    pkgs.go-task # provides `task`
    pkgs.uv
    pkgs.buf
    pkgs.jq
    pkgs.ipmitool
    pkgs.nmap
    pkgs.gitleaks
    pkgs.git-filter-repo # the public-sync filter (tools/publish-monorepo.py, task
    #  publish:preview). CI installs its own; unpinned here it resolves from whatever
    #  user profile happens to carry it, so the preview works on one machine only.
    pkgs.secretspec # `secretspec` CLI on PATH (devenv uses it by store path; ad-hoc
    #  `secretspec check/run` needs it discoverable). Same pkgs as hub.nix.
    pkgs.tmux
    pkgs.qemu # HVF on Darwin, KVM on Linux; ships edk2 firmware blobs
    pkgs.libvirt # virsh + virtqemud (user-session)
    pkgs.dnsmasq # libvirt network helper
    pkgs.nginx # OS-layer cache (services.nginx); on PATH for `nginx -t`
    pkgs.thanos # receive placeholder (processes.thanos); CLI on PATH
    pkgs.telegraf # per-bridge telemetry agent (spoke.nix mkTelegraf); remote_writes to thanos
    pkgs.bats # devenv/tests/**.bats runner (task test:devenv / task test:devenv:all)
    processCompose
  ]
  ++ lib.optionals pkgs.stdenv.isLinux [
    pkgs.OVMF.fd
    pkgs.swtpm
    pkgs.cpio
    pkgs.docker-buildx # the fleet iPXE build needs the plugin; Docker Desktop ships its own on darwin
  ]
  ++ lib.optionals pkgs.stdenv.isDarwin [ socketVmnet ];

  # Foundation env: only what the sim Python engine + the virt stack read. The hub/spoke
  # app env (HH_ENV, billing/integration placeholders, …) is NOT here — it
  # rides on each process's per-process `environment` in ./devenv/modules/hub.nix / ./devenv/modules/spoke.nix.
  # Two precedence tiers: bare strings always win; lib.mkOptionDefault values stay
  # .env-overridable (devenv loads dotenv at mkDefault, which outranks mkOptionDefault — a
  # second mkDefault here would instead *collide* with dotenv: "conflicting definition values").
  env = {
    # LOCAL_*: the sim engine resolves ipmi_sim/sushy + qemu firmware/emulator off these
    # Nix store paths (a Nix-managed host has no /opt/homebrew or /usr/share copy). The
    # firmware/emulator paths are baked into the rendered libvirt XML too, so pinning the
    # store path keeps renders reproducible rather than PATH-dependent.
    LOCAL_PYTHON_BIN = "${pythonEnv}/bin";
    # mkOptionDefault, not a bare string: a Linux host whose libvirt cannot exec the Nix qemu
    # (AppArmor, a distro-pinned emulator) must be able to repoint these from .env.
    LOCAL_EDK2_CODE_PATH = lib.mkOptionDefault edk2Code;
    LOCAL_EDK2_VARS_TEMPLATE_PATH = lib.mkOptionDefault edk2Vars;
    LOCAL_QEMU_EMULATOR = lib.mkOptionDefault qemuEmulator;
    LOCAL_IPMI_SIM_BIN = "${openipmi}/bin/ipmi_sim";
    LOCAL_SDRCOMP_BIN = "${openipmi}/bin/sdrcomp";
    LOCAL_SIM_PRIV_BIN = "${simPriv}/bin/brokkr-sim-priv";

    # pin PGHOST to loopback (bare string outranks the postgres module's mkDefault). The module
    # otherwise derives PGHOST from listen_addresses, so the LAN toggle's 0.0.0.0 bind would make
    # in-shell psql / pg_isready / the seed scripts connect to 0.0.0.0 — fine on Linux, broken on
    # macOS. Local clients always talk loopback; only the listener widens. No-op when the toggle is
    # off (listen_addresses is already loopback).
    PGHOST = P.hosts.loopback;

    # datastores the sim engine reads (stores.py StoresSettings): Hub Postgres +
    # Bridge Redis. Match the native services below.
    HUB_DATABASE_URL = lib.mkOptionDefault pgUrl;
    BRIDGE_REDIS_URL = lib.mkOptionDefault P.urls.redis;

    # org UUID — single source (config.identity.orgId) the hub (BROKKR_ADMIN_ORG_ID) and the sim
    # (SimSettings.hydrahost_org_id, env SIM_HYDRAHOST_ORG_ID) both derive from, so they can't diverge.
    SIM_HYDRAHOST_ORG_ID = lib.mkOptionDefault config.identity.orgId;

    # sim OS-layers manifest index — derived from the single asset-origin knob
    # (config.osLayerCache.originHost) so the seed, spoke, and nginx never diverge.
    # SimSettings (env_prefix SIM_) reads it; overridable via .env.
    SIM_OS_LAYERS_MANIFEST_INDEX_URL = lib.mkOptionDefault "https://${config.osLayerCache.originHost}/os-layers/releases/latest";

    # canonical sim zone — config.py reads BRIDGE_ZONE_ID (BridgeSettings env_prefix=BRIDGE_).
    # single override knob; the spoke derives BROKKR_ZONE_ID + REDIS_PREFIX from it later.
    BRIDGE_ZONE_ID = lib.mkOptionDefault zoneId;

    # multi-stack slot (config.stack.slot) + the per-slot host state root. Slot 0 keeps the
    # legacy ~/.local/share/local so pre-existing state is reused; slots >=1 get their own tree.
    SIM_SLOT = lib.mkOptionDefault (toString config.stack.slot);
    LOCAL_STATE = lib.mkOptionDefault (
      if config.stack.slot == 0 then
        "${builtins.getEnv "HOME"}/.local/share/local"
      else
        "${builtins.getEnv "HOME"}/.local/share/local-s${toString config.stack.slot}"
    );

    # Token POINTERS for stdio children of the devenv shell. The brokkr-lab MCP server is the reason:
    # modules/agent-tooling.nix registers it with no `env` block (a pinned LAB_MCP_URL would defeat
    # the slot registry), and it is a child of the editor session, not of the lab process — so it
    # inherits nothing exported inside processes.lab.exec. Interpolated at eval time, like
    # LOCAL_FLEET_PATH in modules/fleet-topology.nix, so nothing depends on shell ordering.
    #
    # Paths, never values. LAB_HOST_TOKEN is the one credential that reaches host-exec, and putting
    # it in the shell environment would hand it to every process the developer runs — which is the
    # exact property that makes a second token worth having. The files are 0600 and are minted by the
    # `lab:token` task, so a checkout that has never brought the stack up has a well-formed pointer
    # at a file that does not exist yet; a reader must treat an unreadable file as no token.
    LAB_API_TOKEN_FILE = "${config.env.DEVENV_STATE}/lab/api-token";
    LAB_HOST_TOKEN_FILE = "${config.env.DEVENV_STATE}/lab/host-token";

    # brokkr-app monorepo checkout — hub processes, bridge processes, and the sim engine
    # all cd into this single path. SSOT: config.polyrepo.hub (./devenv/modules/polyrepo.nix).
    HUB_REPO_PATH = lib.mkOptionDefault (
      if config.polyrepo.hub.path == "" then repoRoot else expandHome config.polyrepo.hub.path
    );
  }
  // lib.optionalAttrs pkgs.stdenv.isDarwin {
    LOCAL_SOCKET_VMNET_BIN = "${socketVmnet}/bin/socket_vmnet";
  };

  # load repo .env (HUB_REPO_PATH, BRIDGE_REDIS_URL, ...) at mkDefault priority.
  dotenv.enable = true;

  # datastores run natively (no docker). Each exposes its CLI (psql/redis-cli)
  # into the shell. postgres matches the old postgres:16 image; the brokkr role is
  # SUPERUSER so Hub's Prisma migrate (extensions) succeeds, mirroring POSTGRES_USER=brokkr.
  services.postgres = {
    enable = localStack;
    package = pkgs.postgresql_16;
    listen_addresses = lib.concatStringsSep "," P.bindHostList;
    port = config.ports.postgres;
    initialDatabases = [
      {
        name = config.identity.pg.db;
        inherit (config.identity.pg) user;
        pass = config.identity.pg.password;
      }
    ];
    # SUPERUSER stays: Hub's Prisma migrate creates extensions, which a plain role cannot. Under
    # lan.datastoreAuth the non-loopback lines below demand the password before the role is reachable
    # at all, so the grant is no longer what decides LAN access.
    initialScript = "ALTER ROLE ${config.identity.pg.user} WITH SUPERUSER;";
    # devenv re-copies this on every start, so a Redeploy reverts a hand edit. Rendered by
    # modules/ports.nix so the credential branches are reachable from devenv/tests/nix.
    hbaConf = P.mkHbaConf {
      inherit (P) offLoopback;
      inherit (config.lan) datastoreAuth;
    };
  };

  services.redis = {
    enable = localStack;
    bind = lib.concatStringsSep " " P.bindHostList;
    port = config.ports.redis;
    # requirepass passwords `default` without narrowing it, reversing the scope note in
    # modules/redis-acl.nix. The probe is a bare `redis-cli ping`, so it reads REDISCLI_AUTH below.
    extraConfig = P.mkRedisExtraConf {
      inherit (P) offLoopback;
      inherit (config.lan) datastoreAuth;
      password = config.identity.redis.password;
    };
  };

  # postgres/redis are services.* (the module owns processes.<name>.exec); merge the control-center
  # catalog metadata onto them — namespace drives the stack grouping, description is the card label.
  processes.postgres.process-compose = lib.mkIf localStack {
    namespace = "datastore";
    description = "Postgres";
  };
  processes.redis.process-compose = lib.mkIf localStack {
    namespace = "datastore";
    description = "Redis";
    # The upstream readiness probe is a bare `redis-cli -p <port> ping` with no credential, so it
    # needs the password out of band once requirepass is on.
    environment = lib.optional (
      P.offLoopback && config.lan.datastoreAuth
    ) "REDISCLI_AUTH=${P.safeSecret "identity.redis.password" config.identity.redis.password}";
  };

  # Local-dev OS-layer cache — a stripped-down port of the prod bridge nginx (TLS,
  # reverse proxy, iPXE serve, gRPC all removed): ONLY the CDN asset cache. The device
  # fetches OS-layer blobs from {OS_LAYER_URL}/sha256:<hash> at provision time; pointing
  # the spoke's OS_LAYER_URL here caches them on disk so repeat provisions skip the
  # multi-GB CDN re-download. The devenv services.nginx module emits a rootless
  # config and manages pid/temp/prefix under $DEVENV_STATE/nginx, so only the http{} body
  # lives here. The cache dir path interpolates config.env.DEVENV_STATE at eval time.
  services.nginx = {
    enable = localStack;
    httpConfig = ''
      sendfile on;
      default_type application/octet-stream;

      proxy_cache_path ${config.env.DEVENV_STATE}/nginx/layer-cache
                       levels=1:2
                       keys_zone=assets:10m
                       max_size=${if config.stack.slot == 0 then "30g" else "5g"}
                       inactive=90d
                       use_temp_path=off;

      # The CDN origin's IPs rotate, so $cdn_origin in proxy_pass forces per-request DNS.
      resolver ${config.osLayerCache.resolvers} ipv6=off valid=300s;

      server {
        # Deliberately address-less, so this listener does NOT follow P.bindHost. A provisioning VM
        # pulls its OS-layer blobs from the data-plane gateway address (P.hosts.dataPlaneGateway),
        # which the sim's virtual network creates after nginx starts — naming it in a `listen`
        # directive makes nginx fail to start whenever the fleet network is down, and it is not in
        # bindHostList. The residual surface is an origin-pinned CDN blob cache that strips
        # Authorization and Cookie (see the proxy_set_header lines below), not an open proxy.
        listen ${toString P.ports.nginx};
        server_name _;
        # the module sets a http-level `access_log off`; re-enable here so the cache
        # MISS/HIT decision is observable in the process log.
        access_log /dev/stdout;

        location = /healthz {
          return 200 "ok\n";
        }

        # Plain HTTP is safe: blobs are sha256-addressed + immutable and the bridge
        # re-validates every byte against the expected hash before use, so a MITM can
        # corrupt but not forge. Serve only content-addressed paths.
        location /assets/ {
          set $cdn_origin "${config.osLayerCache.originHost}";
          rewrite ^/assets/(.*)$ /os-layers/blobs/$1 break;

          proxy_pass https://$cdn_origin;
          proxy_http_version 1.1;
          proxy_ssl_server_name on;
          proxy_ssl_name $cdn_origin;
          proxy_set_header Host $cdn_origin;
          proxy_set_header Authorization "";
          proxy_set_header Cookie "";

          proxy_cache assets;
          proxy_cache_key "$uri";
          proxy_cache_valid 200 1y;
          proxy_cache_valid 404 1m;
          proxy_cache_revalidate on;
          proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;
          # Single-flight cold fetches so N parallel provisions of the same blob
          # trigger one upstream pull, not N.
          proxy_cache_lock on;
          proxy_cache_lock_timeout 1800s;

          add_header X-Cache-Status $upstream_cache_status always;

          proxy_read_timeout 3600s;
          proxy_send_timeout 3600s;
          proxy_connect_timeout 30s;
        }
      }
    '';
  };

  # gate the DAG on the cache's /healthz (the module defines processes.nginx.exec; this
  # merges the readiness probe + restart policy).
  processes.nginx = lib.mkIf localStack {
    process-compose = {
      namespace = "datastore";
      description = "OS-layer cache (nginx)";
    };
    ready = {
      http.get = {
        host = P.hosts.loopback;
        port = P.ports.nginx;
        path = "/healthz";
      };
      initial_delay = 1;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 30;
    };
    restart.on = "on_failure";
  };

  # Thanos receive — devenv-native port of the old docker quay.io/thanos placeholder.
  # single-node receiver with a local 24h TSDB (no objstore, no hashring); idles accepting
  # Prometheus remote_write at :19291 until hub/spoke monitoring lands. loopback-only like
  # the other native datastores. process name `thanos` so the CC roster maps id -> pc
  # process 1:1; the /-/ready probe lets that card report `up` (not just `unhealthy`).
  processes.thanos = lib.mkIf localStack {
    process-compose = {
      namespace = "datastore";
      description = "Thanos";
    };
    # Thanos receive has no authentication mechanism of any kind, and its remote-write listener
    # accepts arbitrary metric injection — so lan.datastoreAuth pins it back to loopback rather than
    # publishing a surface no credential can cover. Every writer (the spokes' telegraf) runs on this
    # host, so loopback costs the local stack nothing.
    exec =
      let
        # thanos binds a cap'n proto server whether or not we name it, and its default is a fixed
        # 0.0.0.0:19391 — unslotted, so two stacks collide, and off-loopback under datastoreAuth.
        thanosBind = if config.lan.datastoreAuth then P.hosts.loopback else P.bindHost;
      in
      ''
        mkdir -p "$DEVENV_STATE/thanos"
        exec ${pkgs.thanos}/bin/thanos receive \
          --tsdb.path="$DEVENV_STATE/thanos" \
          --tsdb.retention=24h \
          --http-address=${lib.escapeShellArg (P.hostPort thanosBind P.ports.thanosHttp)} \
          --grpc-address=${lib.escapeShellArg (P.hostPort thanosBind P.ports.thanosGrpc)} \
          --remote-write.address=${lib.escapeShellArg (P.hostPort thanosBind P.ports.thanosRemoteWrite)} \
          --receive.capnproto-address=${lib.escapeShellArg (P.hostPort thanosBind P.ports.thanosCapnproto)} \
          --label='receive_replica="0"'
      '';
    ready = {
      http.get = {
        host = if config.lan.datastoreAuth then P.hosts.loopback else P.probeHost;
        port = P.ports.thanosHttp;
        path = "/-/ready";
      };
      initial_delay = 1;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 30;
    };
    restart.on = "on_failure";
  };

  # Thanos query — read-only query frontend fanning out to the receive's StoreAPI (thanosGrpc).
  # `thanos receive` only accepts remote_write over HTTP; it does NOT serve the Prometheus query
  # API, so the control-center datastore browser needs this component to run PromQL. loopback-only.
  processes.thanos-query = lib.mkIf localStack {
    process-compose = {
      namespace = "datastore";
      description = "Thanos query";
      depends_on.thanos.condition = "process_healthy";
    };
    exec = ''
      exec ${pkgs.thanos}/bin/thanos query \
        --http-address=${P.hosts.loopback}:${toString P.ports.thanosQueryHttp} \
        --grpc-address=${P.hosts.loopback}:${toString P.ports.thanosQueryGrpc} \
        --endpoint=${P.hosts.loopback}:${toString P.ports.thanosGrpc} \
        --query.replica-label='receive_replica'
    '';
    ready = {
      http.get = {
        host = P.hosts.loopback;
        port = P.ports.thanosQueryHttp;
        path = "/-/ready";
      };
      initial_delay = 1;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 30;
    };
    restart.on = "on_failure";
  };

  # Mailpit — local SMTP catcher so hub outbound email (password reset, invites, notices) is
  # captured and viewable instead of delivered. The hub points SMTP_HOST/PORT here (hub.nix derives
  # them from this port) and sets EMAIL_LOCAL_DELIVERY=true to bypass the IS_LOCAL send-skip; mail
  # never leaves the host (mailpit does not relay). Web UI at http://127.0.0.1:<mailpitWeb>.
  processes.mailpit = lib.mkIf localStack {
    process-compose = {
      # LAB_WEB_UI marks this as a browser UI for the control-center "Apps" sidebar; the link
      # port comes from the readiness probe (mailpitWeb), so no LAB_WEB_PORT override.
      environment = [
        "LAB_WEB_UI=Mailpit"
      ]
      ++ P.mkMailpitAuthEnv {
        inherit (P) offLoopback;
        inherit (config.lan) datastoreAuth;
        password = config.identity.mailpit.password;
      };
      namespace = "datastore";
      description = "Mailpit";
    };
    exec = ''
      exec ${pkgs.mailpit}/bin/mailpit \
        --smtp ${lib.escapeShellArg (P.hostPort P.hosts.loopback P.ports.mailpitSmtp)} \
        --listen ${lib.escapeShellArg (P.hostPort P.bindHost P.ports.mailpitWeb)}
    '';
    ready = {
      http.get = {
        host = P.probeHost;
        port = P.ports.mailpitWeb;
        # mailpit registers /readyz outside the middleware that holds its basic auth, so the probe
        # still passes once MP_UI_AUTH is set. A probe on "/" answers 401 and restart-loops mailpit.
        path = "/readyz";
      };
      initial_delay = 1;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 30;
    };
    restart.on = "on_failure";
  };

  # use the process-compose backend so the overview TUI can attach to the *detached*
  # stack (`devenv up -d`): `process-compose attach -U -u $DEVENV_RUNTIME/pc.sock` gives
  # live status/health + per-process logs + inline restart/stop. the native manager only
  # renders its TUI for a foreground `devenv up` and has no attach. server listens on the
  # UDS at $DEVENV_RUNTIME/pc.sock (no TCP port).
  process.manager.implementation = "process-compose";

  process.managers.process-compose.package = processCompose;

  # On-demand maintenance commands (exposed on the env PATH; runnable in-shell and from the
  # supervised processes, e.g. the control-center lab API). These are imperative wipes — NOT
  # `tasks` (the cached, status-gated bring-up DAG) — so they stay out of the `devenv up` graph.
  # stack-wipe-data is the single source of truth for which datastore dirs get wiped; stack-reset
  # composes it (+ stop + fleet nuke), stack-purge composes stack-reset (+ the spared deep dirs).
  scripts.stack-wipe-data = {
    description = "DESTRUCTIVE: rm the datastore data dirs (postgres/redis/thanos/tempo/grafana) under $DEVENV_STATE. No process control — caller stops those processes first.";
    exec = ''
      set -u
      : "''${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
      for d in postgres redis thanos tempo grafana; do rm -rf "$DEVENV_STATE/$d"; done
      rm -f "$DEVENV_STATE/fleet.yaml"
      echo "✓ stack-wipe-data — datastore data wiped (postgres/redis/thanos/tempo/grafana)."
    '';
  };

  scripts.stack-wipe-images = {
    description = "DESTRUCTIVE: rm the never-wiped ephemeral image/artifact roots — this slot's spoke storage (synced discovery images + built initrds, ${spokeStorage}), the sim boot artifacts ($LOCAL_STATE/boot), telegraf conf, and zone-crypto tokens. All regenerable (spoke re-syncs, fleet:init rebuilds, mint task re-mints). No process control — caller stops processes first.";
    exec = ''
      set -u
      : "''${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
      state="''${LOCAL_STATE:-$HOME/.local/share/local}"
      rm -rf "${spokeStorage}" "$state/boot" "$DEVENV_STATE/telegraf" "$DEVENV_STATE/zone-crypto"
      echo "✓ stack-wipe-images — discovery images + built initrds + boot artifacts + telegraf + zone-crypto tokens wiped."
    '';
  };

  # The gate a datastore wipe must pass, and the single source of truth for "is it safe to wipe" —
  # the counterpart to stack-wipe-data owning "what gets wiped". `stack-down` cannot report failure
  # (every statement in it is `|| true`), so `stack-down && stack-wipe-data` wipes unconditionally,
  # even under a postgres that ignored SIGTERM. Poll the daemon instead and fail on timeout.
  scripts.stack-await-down = {
    description = "Gate before any datastore wipe: wait up to 60×1s for the process-compose daemon to stop answering. Exit 0 once it is gone, non-zero on timeout — so `stack-await-down && stack-wipe-data` genuinely refuses to wipe a live datastore (`stack-down` alone always exits 0).";
    exec = ''
      set -u
      : "''${PC_SOCKET_PATH:?PC_SOCKET_PATH unset — run inside the devenv shell}"
      for _ in $(seq 1 60); do
        process-compose -U -u "$PC_SOCKET_PATH" process list -o json >/dev/null 2>&1 || exit 0
        sleep 1
      done
      echo "stack-await-down: process-compose still answering after 60s — the stack is NOT down." >&2
      exit 1
    '';
  };

  scripts.stack-reset = {
    description = "DESTRUCTIVE: stop the stack, then wipe datastore data + fleet overlays. Spares the nginx OS-layer cache + build artifacts. Rebuild with `task up`.";
    exec = ''
      set -u
      : "''${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
      # stop the supervised stack first so we never wipe a live datastore data dir (no-op if down).
      # `devenv processes down` (pidfile SIGTERM → SIGKILL escalation) EXITS the daemon; socket-direct
      # `process-compose down` would leave it alive (the daemon runs with --keep-project), so the guard
      # below would then exhaust its full 60s and abort the wipe. Mirrors `stack-down`. The old
      # socket-direct rationale (reaching a dev/stg-profile stack) is gone — remote-infra profiles were
      # removed; local is the only bring-up profile.
      devenv processes down 2>/dev/null || true
      if ! stack-await-down; then
        echo "stack-reset: process-compose still answering after 60s — refusing to wipe a live datastore. Run 'task down' and retry." >&2
        exit 1
      fi
      # fleet nuke BEFORE stack-wipe-data: nuke loads $DEVENV_STATE/fleet.yaml (LOCAL_FLEET_PATH)
      # to tear down libvirt domains, ipmi_sim, sushy, and lo aliases — wiping the file first would
      # make load_fleet() fail and || true would silently skip the teardown, leaking fleet state.
      ( export PYTHONPATH="${repoRoot}/apps/local-sim/scripts''${PYTHONPATH:+:$PYTHONPATH}"
        cd "${repoRoot}/apps/local-sim" && python -m local.fleet nuke ) || true
      # Sweep brokkr-owned stragglers: a leftover session virtqemud (fleet nuke's virsh auto-spawns a
      # transient `virtqemud --timeout=120` that would hold the pidfile lock into the next `task up`),
      # plus any orphaned dist/main / BMC daemons. Same shared reaper `task down` runs. --post-down:
      # the daemon exit was awaited above, so drop the ancestry exemption. Reap BEFORE stack-wipe-data
      # so an orphaned postgres/redis outliving `processes down` is killed before its data dir is rm'd.
      stack-reap --post-down || true
      stack-wipe-data
      echo "✓ stack-reset — datastore data + fleet overlays wiped (nginx cache + builds kept). Rebuild: task up"
    '';
  };

  scripts.stack-purge = {
    description = "DESTRUCTIVE: everything stack-reset does PLUS cached images/initrds + boot artifacts + telegraf + zone-crypto (stack-wipe-images), the nginx OS-layer cache, process-compose logs, and the devenv task-status db — a fully pristine devenv state (nginx cache re-downloads). Keeps host config (sudoers) + checkouts.";
    exec = ''
      set -u
      : "''${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
      # Honor stack-reset's live-datastore guard: if it aborts (pc still answering), do NOT proceed
      # to the deeper wipes/rm -rf — a purge on a live stack is exactly what the guard prevents.
      stack-reset || exit 1
      # BROKK_KEEP_OTHERS makes stack-down-others below a no-op — warn, because a sibling that shares
      # this slot (it has not claimed its own yet, so it renders slot 0's paths too) loses its caches.
      if [ -n "''${BROKK_KEEP_OTHERS:-}" ]; then
        echo "⚠️  BROKK_KEEP_OTHERS set — leaving sibling stacks running, but stack-wipe-images will STILL delete this slot's caches (${spokeStorage}, ''${LOCAL_STATE:-$HOME/.local/share/local}/boot) — which an unclaimed sibling also renders."
      fi
      # the image/boot roots are slot-scoped, but an unclaimed sibling evaluates this same slot —
      # stop any sibling stack first so we never delete its live caches out from under it.
      stack-down-others
      stack-wipe-images
      rm -rf "$DEVENV_STATE/nginx/layer-cache" "$DEVENV_STATE/process-compose"
      rm -f  "$DEVENV_STATE"/tasks.db*
      echo "✓ stack-purge — pristine devenv state (images + boot artifacts + nginx cache + pc logs + task db cleared). Rebuild: task up"
    '';
  };

  # Ends this checkout's slot: the same teardown as stack-reslot, but the slot goes back to the
  # host registry for another checkout instead of being re-claimed here.
  scripts.stack-release = {
    description = "DESTRUCTIVE: tear this checkout's stack down and return its slot to the host registry — down, fleet nuke with the slot's env, bootptab section off, datastore + slot-stamped state wiped, the slot's host-global roots removed (spoke storage, agent bundle, sim state), registry entry released. A later `task up` claims whatever slot is then free.";
    exec = ''exec bash "${repoRoot}/devenv/scripts/stack-release.sh" "$@"'';
  };

  # The migration stack-claim.sh's drift refusal points at: teardown under the OLD slot's env,
  # wipe slot-stamped state, release the registry entry — next `task up` re-claims + re-seeds.
  scripts.stack-reslot = {
    description = "DESTRUCTIVE: migrate this checkout to a newly configured stack slot — down, fleet nuke with the OLD slot's env, old bootptab section off, datastore + slot-stamped state wiped, the old slot's host-global roots removed (spoke storage, agent bundle, sim state), registry entry released. Rebuild (and claim the new slot) with `task up`.";
    exec = ''exec bash "${repoRoot}/devenv/scripts/stack-reslot.sh" "$@"'';
  };

  # Reap brokkr-owned devenv-stack process orphans (an orphaned hub/spoke dist/main, a leftover
  # session virtqemud) that survive `process-compose down`, so the next `task up` is clean. Thin
  # wrapper over devenv/lib/reap-stale.sh. The simulator FLEET plane
  # (ipmi_sim/sushy/domains) is the engine's job — torn down by `local.fleet down`/`nuke`, not here.
  scripts.stack-reap = {
    description = "Reap stale devenv-stack process orphans (orphaned hub/spoke dist/main, leftover session virtqemud) so the next `task up` is clean. --reap (default) / --check (report-only).";
    exec = ''
      export REAP_LSOF="${pkgs.lsof}/bin/lsof"
      exec bash "${repoRoot}/devenv/lib/reap-stale.sh" "$@"
    '';
  };

  # Sibling stacks are first-class citizens under multi-stack slots — `_up` only REPORTS them
  # (stack-report-others); stopping one is an explicit operator call (`task down:others` /
  # stack-purge) via stack-down-others. Both iterate the host slot registry (every stack that
  # claimed a slot), not anonymous runtime-dir globs. Logic lives in devenv/scripts/stack-others.sh.
  scripts.stack-report-others = {
    description = "Report every OTHER registered stack (slot, checkout, state, liveness, up/total processes) without touching it. No-op when the registry has no other entries.";
    exec = ''
      set -u
      : "''${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"
      exec bash "${repoRoot}/devenv/scripts/stack-others.sh" report
    '';
  };

  scripts.stack-down-others = {
    description = "Stop every OTHER registered stack (per the host slot registry) without bringing this one up, and tombstone their entries. Opt out with BROKK_KEEP_OTHERS=1.";
    exec = ''
      set -u
      if [ -n "''${BROKK_KEEP_OTHERS:-}" ]; then
        echo "→ BROKK_KEEP_OTHERS set — leaving other checkouts' stacks running."
        exit 0
      fi
      : "''${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"
      exec bash "${repoRoot}/devenv/scripts/stack-others.sh" down
    '';
  };

  scripts.stack-down-all = {
    description = "Stop EVERY registered stack on this host — siblings first (socket down + SIGTERM to their recorded pc-supervisor pid), this checkout's stack last. Tombstones each entry it downs.";
    exec = ''exec bash "${repoRoot}/devenv/scripts/stack-down-all.sh" "$@"'';
  };

  scripts.stack-purge-all = {
    description = "DESTRUCTIVE: stack-down-all + wipe each registered slot's host-global state (spoke storage, sim state, agent bundle) + clear the registry. Per-checkout .devenv/state stays with each checkout's own local:purge.";
    exec = ''exec bash "${repoRoot}/devenv/scripts/stack-purge-all.sh" "$@"'';
  };

  # `task down`'s implementation. Powers the fleet OFF (domains kept defined — `fleet up` brings them
  # back fast; destroy/undefine/wipe is stack-reset's job), stops every supervised process, then reaps
  # stragglers. Mirrors stack-reset's structure.
  scripts.stack-down = {
    description = "Stop the local-dev stack: power off the fleet VMs (kept defined), stop all supervised processes, then reap stragglers. Non-destructive — data + overlays + domains preserved (use task reset to wipe).";
    exec = ''
      set -u
      # Power the fleet off directly (deterministic) rather than relying solely on the supervisor's
      # SIGTERM handler, which can be starved mid-teardown and leak running domains. Idempotent;
      # domains stay defined + shut off. No-op if the fleet never came up (load_fleet fails → || true).
      ( export PYTHONPATH="${repoRoot}/apps/local-sim/scripts''${PYTHONPATH:+:$PYTHONPATH}"
        cd "${repoRoot}/apps/local-sim" && python -m local.fleet down ) || true
      # `devenv processes down` (pidfile SIGTERM → SIGKILL escalation), NOT socket-direct
      # `process-compose down`: the daemon runs with --keep-project, so the socket `down` stops
      # processes but leaves the server alive — the next `task up` then reattaches to a stale
      # session whose fleet/virtqemud sit in terminal states reconcile never revives. The old
      # socket-direct rationale (reaching a dev/stg-profile stack) is gone — remote-infra
      # profiles were removed; local is the only bring-up profile.
      devenv processes down || true
      stack-reap || true
    '';
  };

  # Self-heal the running stack — single source of truth shared by `task up` and the control
  # center's Reconcile op. Thin wrapper over the real logic in apps/local-sim/scripts/tasks (so it stays a
  # normal, testable shell file). Assumes process-compose is already up; (re)starts any
  # datastore/hub/spoke process that's down, in dependency order, leaving Disabled +
  # Running ones be. RECONCILE_INCLUDE_CC=1 (set by `task up`) also reconciles lab/lab-web.
  scripts.stack-reconcile = {
    description = "Self-heal the supervised stack: (re)start any down datastore/hub/spoke process in dependency order, leaving Disabled + Running ones be. Never touches the fleet or one-shot init tasks. RECONCILE_INCLUDE_CC=1 also reconciles the control center (lab/lab-web).";
    exec = ''
      exec bash "${repoRoot}/apps/local-sim/scripts/tasks/stack-reconcile.sh" "$@"
    '';
  };

  # `task up`'s bring-up half, on PATH so the control center can start the stack with no tty of its
  # own. The preflight gate is in (under BROKK_PREFLIGHT_GATE it only hard-fails on a missing sibling
  # checkout, and it reaps the orphaned dist/main that would otherwise fail `devenv up -d` on
  # EADDRINUSE); bootstrap.sh + sudo:setup are NOT — their prompts are the tty this exists to avoid.
  # stack-down-others stays out too: stopping a sibling checkout's stack is the caller's policy.
  scripts.stack-up = {
    description = "Bring the local-dev stack up detached: claim the stack slot, preflight gate, devenv up -d (skipped when already running), wait for the process-compose socket, then reconcile incl. the control center. No host bootstrap and no sudo — `task up` owns those.";
    exec = ''
      set -eu
      : "''${DEVENV_ROOT:?DEVENV_ROOT unset — run inside the devenv shell}"
      # same resolution order as stack-reconcile.sh / with-task-log.sh. Deriving
      # (not `:?`-guarding) is deliberate here: an unresolvable socket just means nothing is up yet,
      # which is a bring-up's normal cold start — stack-await-down guards instead, because there an
      # unset socket must never read as "the stack is down".
      PC_SOCK="''${PC_SOCKET_PATH:-''${DEVENV_RUNTIME:-}/pc.sock}"
      # before the claim so a refused bring-up takes no slot (safe: runs no `devenv eval`).
      # autoStart spliced in: a control-plane-only bring-up needs neither libvirt nor the iPXE build.
      BROKK_FLEET_AUTOSTART=${lib.boolToString config.fleet.autoStart} \
        bash "$DEVENV_ROOT/devenv/scripts/host-access-check.sh"
      # claim BEFORE the already-running check / devenv up -d: the first eval must already see
      # the claimed slot (fleet.yaml is cp -n-seeded from it and never re-seeds). lives here and
      # not in Taskfile _up because the control center invokes stack-up directly.
      bash "$DEVENV_ROOT/devenv/scripts/stack-claim.sh"
      # after the claim, so the port scan reads this stack's own slot ports — an unclaimed
      # checkout evaluates slot 0 and would flag a healthy sibling's listeners as squatters.
      ( cd "$DEVENV_ROOT" && devenv tasks run setup:preflight --show-output )
      if process-compose -U -u "$PC_SOCK" process list -o json >/dev/null 2>&1; then
        echo "→ stack already running — devenv up -d skipped (task down first to recreate)."
      else
        ( cd "$DEVENV_ROOT" && devenv up -d )
      fi
      # `devenv up -d` returns before process-compose is listening; wait for the socket so
      # stack-reconcile doesn't race it with a spurious "unreachable" on a cold bring-up.
      for _ in $(seq 1 60); do
        [ -S "$PC_SOCK" ] && process-compose -U -u "$PC_SOCK" process list -o json >/dev/null 2>&1 && break
        sleep 1
      done
      # record the pc-supervisor pid (NOT $$ — this shell exits right after) + stamp the slot
      # the eval rendered; the stamp is what stack-claim.sh's drift guard compares against.
      ( cd "$DEVENV_ROOT" \
        && bash devenv/lib/stack-registry.sh refresh-pid "$(cat "$DEVENV_ROOT/.devenv/processes.pid" 2>/dev/null || echo 0)" "$DEVENV_ROOT" \
        && devenv eval stack.slot 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["stack.slot"])' > "$DEVENV_STATE/stack-slot-applied" || true )
      # tolerated (as under `task up`): a reconcile reporting some process not yet ready is not a
      # failed bring-up.
      RECONCILE_INCLUDE_CC=1 stack-reconcile || true
    '';
  };

  # cross-cutting one-time bring-up steps wired into the DAG via process `after`. only
  # hostpaths:setup is status-guarded (sudo one-shot). the hub/spoke init+migrate tasks
  # live in their modules (./devenv/modules/hub.nix, ./devenv/modules/spoke.nix); the scripts here are referenced
  # by absolute ${repoRoot} path so they resolve regardless of the process cwd.
  tasks = {
    "hostpaths:setup" = {
      description = "create /opt/brokkr (user-writable); first run prompts for sudo, no-op after.";
      status = "test -d /opt/brokkr";
      # the helper clears a stale non-dir, mkdir -p's, and chowns to SUDO_UID:SUDO_GID — fixed
      # path, no caller-supplied args (replaces the old rm/mkdir/chown trio and `chown *` glob).
      exec = ''sudo "${simPriv}/bin/brokkr-sim-priv" hostpath-setup'';
    };

    "apps:init" = {
      description = "build the lab API once (NestJS --watch tree-kills the sudo grandchildren the control center spawns, so run the built dist/).";
      exec = ''
        . "${repoRoot}/devenv/lib/with-task-log.sh"
        begin_task_log "apps:init"
        cd "${repoRoot}"
        brokkr-pnpm-install
        pnpm --filter @repo/local-lab-contract build
        pnpm --filter local-lab build
      '';
    };

    # Two tokens, because they reach different ceilings. `api-token` is injected into the control-center
    # SPA (VITE_ ⇒ it is a literal string in the served bundle), so it must stop below host execution;
    # `host-token` is never handed to a browser and is the only one that reaches `host-exec`. A task,
    # not per-process shell: lab + lab-web both read api-token and must agree, and a task runs once
    # before either. Persistent — rotate by deleting a file and restarting both.
    "lab:token" = {
      description = "mint the lab API + host tokens ($DEVENV_STATE/lab/{api,host}-token, 0600) the control-center capability model resolves against.";
      # No `status` guard: a short-circuit on presence would leave a pre-existing file at whatever
      # mode it already had. The exec is idempotent instead, and re-tightens on every run.
      exec = ''
        set -eu
        : "''${DEVENV_STATE:?DEVENV_STATE unset — run inside the devenv shell}"
        (
          # inside the subshell, so the directory is created 0700 rather than at the caller's umask
          umask 077
          mkdir -p "$DEVENV_STATE/lab"
          chmod 700 "$DEVENV_STATE/lab"
          for name in api-token host-token; do
            path="$DEVENV_STATE/lab/$name"
            # od, not openssl/uuidgen: no dependency beyond coreutils, same on linux + darwin.
            [ -s "$path" ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$path"
            chmod 600 "$path"
          done
        )
      '';
    };

    # treefmt is a CHECK gate (the git-hooks.hooks.treefmt pre-commit hook + `task check:format`),
    # NOT an on-entry auto-formatter. devenv's treefmt integration wires `devenv:treefmt:run`
    # `before = [ "devenv:enterShell" ]`, which write-formats the whole tree on every shell entry —
    # surprising and destructive (it rewrites files out from under an editing session). Drop only
    # that enterShell trigger; the hook + check task stay intact.
    "devenv:treefmt:run".before = lib.mkForce [ ];

    # every tier, including the ones that need nix or mutate this checkout — `task test:devenv`
    # is the container-safe subset CI gates on.
    "devenv:test" = {
      description = "Run every devenv shell test (devenv/tests, recursively).";
      exec = "bats -r devenv/tests/";
    };

    # assert-only backstop: the real claim runs in stack-up (before eval); this catches a bare
    # `devenv up` bypass — no entry for this checkout, or the entry names a different slot.
    "stack:claim" = {
      description = "Assert this checkout's registry entry matches its configured slot (the claim itself happens in stack-up, before eval).";
      before = [ "devenv:processes:postgres" ];
      exec = ''
        if ! bash "${repoRoot}/devenv/lib/stack-registry.sh" assert-slot "${toString config.stack.slot}" "$DEVENV_ROOT"; then
          echo "registry mismatch — run 'task up' (claims/refreshes the slot) instead of devenv up" >&2
          exit 1
        fi
      '';
    };
  }
  # services.postgres applies initialDatabases' password only on a FRESH datadir, so a checkout that
  # already has one keeps whatever password it was created with — and every scram-sha-256 line in
  # hbaConf then refuses the LAN client that just started needing one. Reapply it on each start.
  # Only defined where the scram lines exist; loopback trust needs no password at all.
  // lib.optionalAttrs (localStack && P.offLoopback && config.lan.datastoreAuth) {
    "pg:password" = {
      description = "reapply identity.pg.password to the postgres role, which initialDatabases sets only on a fresh datadir.";
      after = [ "devenv:processes:postgres" ];
      before = [ "hub:migrate" ];
      # psql variable substitution, never concatenated SQL: :"role" renders a quoted identifier and
      # :'pw' a quoted literal, so neither knob can close the statement. The heredoc delimiter is
      # quoted, so bash expands nothing inside the body either, and every argument is shell-escaped.
      exec = ''
        set -eu
        exec ${config.services.postgres.package}/bin/psql \
          -h ${lib.escapeShellArg P.hosts.loopback} -p ${toString config.ports.postgres} \
          -d ${lib.escapeShellArg config.identity.pg.db} \
          -U ${lib.escapeShellArg config.identity.pg.user} \
          -v ON_ERROR_STOP=1 -q \
          --set=role=${lib.escapeShellArg config.identity.pg.user} \
          --set=pw=${lib.escapeShellArg config.identity.pg.password} <<'SQL'
        ALTER ROLE :"role" WITH PASSWORD :'pw';
        SQL
      '';
    };
  }
  # sql-seed:notify seeds local lifecycle triggers — part of the hermetic stack only. Under
  # remoteInfra it must not exist: the remote DB owns its own schema.
  // lib.optionalAttrs localStack {
    "sql-seed:notify" = {
      description = "apply apps/local-sim/sql-seed/*.sql lifecycle NOTIFY triggers (native psql; after schema migrate).";
      after = [ "hub:migrate" ];
      exec = ''
        . "${repoRoot}/devenv/lib/with-task-log.sh"
        begin_task_log "sql-seed:notify"
        bash ${repoRoot}/apps/local-sim/scripts/tasks/stack-sql-seed.sh
      '';
    };
  };

  # control center API (lab) — NestJS on :3002, run BUILT (node dist/main.js), never
  # `nest start --watch`: watch tree-kills the root-owned sudo grandchildren the
  # supervisor spawns (EPERM crash). LOCAL_BROKKR_ROOT points it at the sim engine;
  # HUB_REPO_PATH/DEVENV_RUNTIME already inherit from the devenv env.
  # No static `GET /` in dev (ServeStatic mounts only under NODE_ENV=production), so the
  # probe hits /api/host — always mounted, though an uncached hit now spawns a bounded 2s git subprocess.
  processes.lab = {
    # Minted in every mode, not only when a listener moves: `fronted` binds loopback yet needs both
    # tokens, and the pointers in the shell env have to resolve whatever the posture is.
    after = [
      "apps:init"
      "lab:token"
    ];
    process-compose = {
      # control center drives the local stack/fleet/datastores — pointless against remote infra.
      disabled = config.remoteInfra.enable;
      # the canonical port map (ports + datastore hosts) rides on the lab process env so the API +
      # the web (via its proxy target) read it instead of re-declaring ports; see modules/ports.nix.
      environment = P.labPortEnv;
      namespace = "control";
      description = "Control Center API";
    };
    exec = ''
      cd "${repoRoot}/apps/local-lab"
      export LOCAL_BROKKR_ROOT="${repoRoot}/apps/local-sim"
      # bind host follows lan.mode; off-loopback callers are gated by the capability model below.
      export LAB_BIND_HOST=${lib.escapeShellArg P.bindHost};
      # lab-web proxies /api over loopback, so a LAN client would look like a loopback peer; trust the
      # proxy's appended x-forwarded-for last hop so the guard sees the real client (needs xfwd on).
      export LAB_TRUST_PROXY=1;
      # The posture the capability model reads: `fronted` drops the address branch entirely, so every
      # caller presents a token. An unrecognised value is read as `fronted` (fail-closed).
      export LAB_MODE=${lib.escapeShellArg config.lan.mode};
      # Both tokens: `api-token` reaches `admin`, `host-token` reaches `host-exec`. The host token is
      # exported HERE ONLY — lab-web must never see it, or the SPA bundle would carry root shell.
      export LAB_API_TOKEN="$(cat "$DEVENV_STATE/lab/api-token")";
      export LAB_HOST_TOKEN="$(cat "$DEVENV_STATE/lab/host-token")";
      exec node dist/main.js
    '';
    ready = {
      http.get = {
        host = P.probeHost;
        # /api/host is capability-gated and returns the hostname, LAN address and build stamp; the
        # probe sends no token, so under `fronted` it must use the deliberately public health route.
        port = P.ports.lab;
        path = "/api/health";
      };
      initial_delay = 3;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 60;
    };
    restart.on = "on_failure";
  };

  # control center UI (lab-web) — Vite dev server on :5175. HOST follows lan.mode (P.bindHost): the
  # LAN address exposes it, 127.0.0.1 keeps it loopback-only. ALLOWED_HOSTS is the same list the hub
  # SPAs get, so a name that reaches one reaches the other.
  processes.lab-web = {
    after = [
      "apps:init"
      "lab:token"
    ];
    process-compose = {
      disabled = config.remoteInfra.enable;
      namespace = "control";
      description = "Control Center Web";
    };
    exec = ''
      cd "${repoRoot}"
      export HOST=${lib.escapeShellArg P.bindHost};
      export LAB_WEB_PORT=${toString P.ports.labWeb};
      export LAB_PORT=${toString P.ports.lab};
    ''
    + lib.optionalString (config.lan.mode != "loopback") ''
      export ALLOWED_HOSTS=${lib.escapeShellArg P.allowedHosts};
      # hand the SPA the API token so a browser authenticates with no manual paste (VITE_ ⇒ it is a
      # literal string in the served bundle, which is why the host token is never injected here).
      # Skipped under `loopback`, where the address alone still carries the caller.
      export VITE_LAB_API_TOKEN="$(cat "$DEVENV_STATE/lab/api-token")";
    ''
    + ''
      exec pnpm --filter local-lab-web dev
    '';
    ready = {
      http.get = {
        host = P.probeHost;
        port = P.ports.labWeb;
        path = "/";
      };
      initial_delay = 3;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 60;
    };
    restart.on = "on_failure";
  };

  # Claude code integration.
  claude.code.enable = true;
  # devenv's default `git-hooks-run` hook runs `prek run` (repo-wide, with a git
  # stash/restore cycle) after every Claude edit. Under concurrent agents — or any
  # staged-vs-unstaged split — that cycle restores stale file states over fresh
  # edits. Replace it with a per-file lint that touches only the edited file and
  # never invokes git.
  claude.code.hooks = {
    git-hooks-run.enable = false;
    lint-edited-file = {
      hookType = "PostToolUse";
      matcher = "^(Edit|MultiEdit|Write)$";
      command = ''jq -r '.tool_input.file_path // empty' | { read -r f; case "$f" in "$CLAUDE_PROJECT_DIR"/*.ts|"$CLAUDE_PROJECT_DIR"/*.tsx|"$CLAUDE_PROJECT_DIR"/*.js|"$CLAUDE_PROJECT_DIR"/*.jsx|"$CLAUDE_PROJECT_DIR"/*.mjs|"$CLAUDE_PROJECT_DIR"/*.cjs) cd "$CLAUDE_PROJECT_DIR" && pnpm exec prettier --write --ignore-unknown "$f" 2>/dev/null; pnpm exec eslint --fix "$f" 2>/dev/null || true;; esac; }'';
    };
  }
  # scripts/ is internal-only and absent from the public mirror.
  // lib.optionalAttrs (builtins.pathExists ./scripts/agent-hooks/max-comment-lines.mjs) {
    max-comment-lines = {
      hookType = "PreToolUse";
      matcher = "^(Edit|MultiEdit|Write)$";
      command = ''node "$CLAUDE_PROJECT_DIR/scripts/agent-hooks/max-comment-lines.mjs" --claude'';
    };
  };

  # apps/local-sim/scripts on PYTHONPATH → `from local.foo import ...` with no .venv / editable install.
  enterShell = ''
    export PYTHONPATH="${repoRoot}/apps/local-sim/scripts''${PYTHONPATH:+:$PYTHONPATH}"
  '';
}
