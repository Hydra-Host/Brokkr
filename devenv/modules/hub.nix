{
  pkgs,
  lib,
  config,
  ...
}:

# Hub as a self-contained devenv unit: its init/migrate DAG tasks + the four supervised
# per-surface processes (api, admin, web, web-admin). The hub app env (formerly the sourced
# sim/scripts/hub-env.sh shim) is now declarative Nix data attached to each hub process via
# process-compose's per-process `environment` — it never reaches the interactive shell or
# the other processes, so the top-level devenv `env` stays foundation-only (sim engine +
# virt stack), as devenv.nix documents.
#
# App-config secrets (every var in secretspec.toml [profiles.default]) come from
# config.secretspec.secrets.* — under `local` they resolve to defaults mirroring the values
# here, so this is a no-op locally; dev/stg pull real values from the provider. Posture vars
# are NOT in the contract and stay literal Nix.
let
  inherit ((import ./lib.nix)) cdRepo envKnobMeta;
  P = (import ./ports.nix).fromConfig config; # effective port/route map (overridable via config.ports)
  # hermetic local stack vs. dev/stg remote infra (modules/profiles.nix sets remoteInfra.enable). Under
  # remote, hub-api drops the local migrate/seed/redis deps.
  localStack = !config.remoteInfra.enable;
  # postgres URL composed from the port map + config.identity.pg (control-center overridable).
  pgUrl = P.mkPgUrl { inherit (config.identity.pg) user password db; };
  # the admin apps are proprietary and absent from the public mirror; `pnpm --filter` on a missing
  # package exits 0, so an ungated process would sit unhealthy forever instead of restarting.
  adminApiPresent = builtins.pathExists ../../apps/admin-api;
  adminWebPresent = builtins.pathExists ../../apps/admin-web;
  # The secret contract's key set is the single source (secretspec.toml [profiles.default]); generate
  # the per-process reads from it instead of hand-listing each (which had to stay in lockstep with the
  # contract). secretspec resolves each name to its active-profile value (local default / dev|stg value).
  # The vars whose LOCAL value is Nix-derived — not a static default — fall back to that derived
  # value when the resolved secret is empty (the "" sentinel in [profiles.local]).
  contract = builtins.fromTOML (builtins.readFile ../../secretspec.toml);
  resolved = name: config.secretspec.secrets.${name} or "";
  nonEmptyOr =
    name: alt:
    let
      v = resolved name;
    in
    if v != "" then v else alt;
  # Datastore URLs under the hermetic local stack: the derived value is authoritative, NOT a
  # fallback. [profiles.local] declares these "" so nothing legitimate resolves them, but the `env`
  # provider reads the ambient environment — so a stray `export DATABASE_URL=<prod>` in the shell
  # that ran `task up` outranks local Postgres and silently points the whole hub at that database.
  # Remote keeps nonEmptyOr (dev/stg resolve real values). Control-center stackOverrides still win:
  # they merge over secretEnv in hubEnv below.
  localPinned = name: derived: if localStack then derived else nonEmptyOr name derived;
  # GUARD: every key in [profiles.default] is rendered into the hub process env — keep that table
  # SECRETS-ONLY. Non-secret posture vars belong in baseHubEnv (local) or profiles.nix (dev/stg).
  secretEnv = (lib.genAttrs (builtins.attrNames contract.profiles.default) resolved) // {
    DATABASE_URL = localPinned "DATABASE_URL" pgUrl;
    PGBOUNCER_CONNECTION_STRING = localPinned "PGBOUNCER_CONNECTION_STRING" pgUrl;
    REDIS_URL = localPinned "REDIS_URL" P.urls.redis;
    BROKKR_ADMIN_ORG_ID = nonEmptyOr "BROKKR_ADMIN_ORG_ID" config.identity.orgId;
    # Local mailpit catcher (processes.mailpit): derive from the port map so an operator-edited
    # ports.mailpitSmtp moves the hub's dialer with the listener. Local-stack-only — mailpit exists
    # only there, and "" is what leaves the nodemailer sender disabled when no SMTP secret is set.
    SMTP_HOST = nonEmptyOr "SMTP_HOST" (lib.optionalString localStack P.hosts.loopback);
    SMTP_PORT = nonEmptyOr "SMTP_PORT" (lib.optionalString localStack (toString P.ports.mailpitSmtp));
    # Local observability sink (modules/telemetry.nix): when enabled, point the hub's
    # OTLP exporter at the local collector — unless a real endpoint was resolved from
    # secretspec, which wins. Local-stack-only, matching the sink module's own gate.
    # Renders "" otherwise; @repo/telemetry treats empty OTEL_* as unset.
    OTEL_EXPORTER_OTLP_ENDPOINT = nonEmptyOr "OTEL_EXPORTER_OTLP_ENDPOINT" (
      lib.optionalString (
        config.telemetry.enable && localStack
      ) "http://${P.hosts.loopback}:${toString P.ports.otlpHttp}"
    );
  };

  # Better Auth takes a comma list of full origins. Every surface is named twice — once at the public
  # origin and once at localhost — so moving the public host never locks a developer out of their own
  # box, and `unique` collapses the pair back to one entry in the loopback default.
  trustedOrigins =
    surfaces:
    lib.concatStringsSep "," (
      lib.unique (map (s: P.urls.browser.${s}) surfaces ++ map (s: P.urls.local.${s}) surfaces)
    );

  # Non-contract literals: posture flags and derived URLs. These are
  # NOT app-config secrets (so not in secretspec.toml) — the generated secretEnv is merged on top.
  baseHubEnv = {
    # app + logging
    HH_ENV = "dev";
    IS_LOCAL = "true"; # Sentry off, brok-local gating
    # Local sim runs the public BOSS edition by DEFAULT (managed-edition is
    # installed in the internal repo but skipped here) so operator-only features
    # like Operator Hub work against the BOSS DesignationOperatorPolicy. Override
    # per-run to exercise managed behavior locally: `HH_FORCE_BOSS=false task up`
    # (read impurely at eval, like HOME). Never set in dev/stg/prod.
    HH_FORCE_BOSS =
      let
        forced = builtins.getEnv "HH_FORCE_BOSS";
      in
      if forced == "" then "true" else forced;
    LOG_LEVEL = "debug";
    # bind host for the web vite dev server (5173), following the LAN toggle (P.bindHost): 0.0.0.0
    # for LAN/Tailscale reach, else 127.0.0.1. per-process env, so it does NOT leak to the shell the
    # way a global env.HOST would (only this process — and the hub web vite config, which derives
    # allowedHosts off it — see it). NOTE: the hub API ignores HOST (`app.listen(port)` binds all
    # interfaces), so phone-home at the data-plane gateway keeps working regardless of this toggle.
    HOST = P.bindHost;

    # auth + URL roots (CORS + better-auth callbacks) — derived from the port map, not secrets.
    # These take the BROWSER origin (modules/ports.nix `urls.browser`), which follows lan.bindAddress
    # and carries a scheme, because better-auth derives the session cookie's `secure` flag from it.
    # Device callbacks must NOT use them (a provisioned VM can't reach localhost) — they use
    # PHONE_HOME_BASE_URL below, which the hub honors via device-tokens.service.ts.
    BASE_URL = P.urls.browser.hubApi;
    ADMIN_BASE_URL = P.urls.browser.hubAdmin;
    ADMIN_BETTER_AUTH_URL = P.urls.browser.hubAdmin;
    # Root for user-facing links, chiefly the emailed password-reset URL. It is the WEB origin, not
    # the API one: /auth/reset-password exists only in the SPA, and the API serves that SPA only
    # under NODE_ENV=production, which the local stack never sets.
    WEB_BASE_URL = P.urls.browser.hubWeb;
    # hub-admin → hub-api service-to-service base (operator-lifecycle proxy). Pinned to loopback: a
    # process on this box must not depend on the public host resolving, or on the front door being up.
    HUB_API_URL = P.urls.dial.hubApi;
    # slotted web/api origins so better-auth (auth-client.module.ts) trusts cross-origin calls from
    # this stack's own vite server — at slots >=1 both ports move off the legacy values. The localhost
    # pair rides along so a developer browsing this box still passes the origin check once the public
    # host moves off it.
    BETTER_AUTH_TRUSTED_ORIGINS = trustedOrigins [
      "hubWeb"
      "hubApi"
    ];
    # createAdminAuthClient falls back to a hardcoded localhost:5174/localhost:3001 pair when it is
    # passed no trustedOrigins, which no origin off this box can satisfy.
    ADMIN_BETTER_AUTH_TRUSTED_ORIGINS = trustedOrigins [
      "hubWebAdmin"
      "hubAdmin"
    ];
    # Only `fronted` has an edge proxy worth trusting outright: under `direct` the hub API binds every
    # interface, so a LAN client reaches it with no proxy and could forge the header req.ip comes from.
    TRUST_PROXY =
      if config.lan.mode == "fronted" then
        "true"
      else if config.lan.mode == "direct" then
        "loopback"
      else
        "";
    ALLOWED_HOSTS = P.allowedHosts;
    # Device-facing phone-home base. A provisioned VM can't reach BASE_URL (localhost), so device
    # callbacks resolve here — the data-plane gateway. Real envs leave this unset and fall back to BASE_URL.
    PHONE_HOME_BASE_URL = "http://${P.hosts.dataPlaneGateway}:${toString P.ports.hubApi.base}";

    # sim-only posture flags.
    ENABLE_BRIDGE_API_MTLS = "false";
    HEARTBEAT_MONITOR_ENABLED = "false";
    # Deliver outbound email to the mailpit catcher (SMTP_* resolve to it via the secretspec
    # local profile) instead of skipping it the way IS_LOCAL otherwise would. Not a secret, so
    # it lives here rather than secretspec.toml. View captured mail at the mailpit web UI.
    EMAIL_LOCAL_DELIVERY = "true";
    NODE_TLS_REJECT_UNAUTHORIZED = "0";
    NOMAD_ADDR = "";

    # local-dev admin bootstrap (read by apps/api/src/main.admin.ts when set).
    LOCAL_SIMULATION_ENABLED = "true";
    VITE_LOCAL_SIMULATION_ENABLED = "true";

    # Match the sink's 15s cadence (grafana datasource timeInterval): at the SDK's
    # 60s default, $__rate_interval windows catch <2 samples and rate panels blank.
    # Non-secret posture flag (not contract-backed), so it lives here, not in secretEnv.
    OTEL_METRIC_EXPORT_INTERVAL = lib.optionalString (config.telemetry.enable && localStack) "15000";
  }
  // secretEnv;

  # AUTH_BYPASS_ENABLED is the control-center knob, but the hub gates admin-auth bypass on
  # LOCAL_SIMULATION_ENABLED (+ VITE_ for the web) — map it; pass every other override through.
  remappedHubKnobs = [ "AUTH_BYPASS_ENABLED" ];
  mapHubOverrides =
    ov:
    (builtins.removeAttrs ov remappedHubKnobs)
    // (lib.optionalAttrs (ov ? AUTH_BYPASS_ENABLED) {
      LOCAL_SIMULATION_ENABLED = ov.AUTH_BYPASS_ENABLED;
      VITE_LOCAL_SIMULATION_ENABLED = ov.AUTH_BYPASS_ENABLED;
    });

  # Knob -> the env keys it lands on, read back OUT of mapHubOverrides (feed it the knob, see where
  # the value goes) so the published mapping can't drift from the remap it describes.
  hubKnobEnv = lib.genAttrs remappedHubKnobs (
    knob:
    lib.attrNames (mapHubOverrides {
      ${knob} = "";
    })
  );

  # Control-center knobs, described from the code that consumes each one. The value a knob reverts
  # to is NOT restated here — modules/overrides.nix reads it back out of stackDefaults.hub below,
  # through hubKnobEnv for the one knob whose name is not itself an env key.
  hubKnobs = {
    HUB_REPO_PATH = {
      label = "Hub repo path";
      group = "Location";
      kind = "text";
      description = "Absolute path to the hub checkout on this host. The control center launches the hub (api/web) from here — required; the hub cannot start without a valid path.";
    };
    AUTH_BYPASS_ENABLED = {
      label = "Auth bypass";
      group = "Security";
      kind = "bool";
      danger = true;
      description = "Relaxes auth SSO + Entra link + CSRF/origin + password length + seeds the local brokkr Owner. ON in sim; toggle OFF to exercise the production auth path locally. Gated by HH_ENV ∈ AUTH_BYPASS_ALLOWED_ENVS — never honored in prod.";
    };
    LOG_LEVEL = {
      label = "Log level";
      group = "Logging";
      kind = "select";
      choices = [
        "debug"
        "info"
        "warn"
        "error"
      ];
      description = "Nest log floor: the named level and every level above it in verbose < debug < log < warn < error < fatal is emitted. `info` and `warning` are aliases for log and warn; an unknown value warns and falls back to log.";
    };
    DATABASE_URL = {
      label = "Postgres URL";
      group = "Datastores";
      kind = "text";
      description = "Postgres connection string for the hub's Prisma client. Read with no fallback, so the hub cannot boot without it; the Prisma CLI reads the same var for migrations.";
    };
    REDIS_URL = {
      label = "Redis URL";
      group = "Datastores";
      kind = "text";
      description = "The single Redis endpoint every hub consumer dials: the BullMQ queues, the shared client (zone ACLs, device secrets, config atoms), the Nest microservice transport, the SSE pub/sub pair and the better-auth session cache.";
    };
    BASE_URL = {
      label = "Base URL";
      group = "URLs";
      kind = "text";
      description = "Public URL root of the hub: the allowed CORS origin, a better-auth trusted origin, and the link root for outbound email. Device phone-home uses it only as the fallback when PHONE_HOME_BASE_URL is unset.";
    };
  };

  # control-center stack-settings overrides win over the static defaults (a HUB_REPO_PATH
  # override also flows here → the per-process env → cdRepo launches from that checkout).
  # zone-crypto (S1): the hub private key is layered last and ONLY when configured, so an unset
  # key is truly absent from the env (dormant — /enroll returns 503), matching the rollout
  # runbook's "BROKKR_HUB_PRIVATE_KEY not set" path. Set zoneCrypto.hubPrivateKey in
  # devenv.local.nix to key the hub (deploy keyed → no restart needed to enroll zones).
  hubEnv =
    baseHubEnv
    # Per-zone Redis ACL management (modules/redis-acl.nix): opt-in flag, on by
    # default in the sim so zone create/delete provisions/revokes ACL users and
    # startup reconcile maintains the seeded zones' users. Layered before the
    # stack overrides so a control-center override can still flip it.
    // lib.optionalAttrs config.redisAcl.enable { REDIS_ACL_MANAGEMENT_ENABLED = "true"; }
    // (mapHubOverrides config.stackOverrides.hub)
    // lib.optionalAttrs (config.zoneCrypto.hubPrivateKey != "") {
      BROKKR_HUB_PRIVATE_KEY = config.zoneCrypto.hubPrivateKey;
    };

  # secret-handling mode — derived from what secretspec actually loaded (single source of truth):
  # a non-`env` provider (dotenv under dev/stg) ⇒ inject sensitive secrets at launch via `secretspec
  # run`; the hermetic `env` provider (local) ⇒ keep the eval-time render. Reading config.secretspec.provider
  # (not a separate flag) keeps this branch and the `secretspec run` args below from desyncing.
  ss = config.secretspec;
  runtimeSecrets = ss.enable && ss.provider != null && ss.provider != "env";

  # contract key set split publishable (VITE_*) vs sensitive. nonSecretEnv keeps posture, derived
  # URLs and publishable keys, dropping every sensitive secret (incl. the Nix-derived DATABASE_URL/
  # REDIS_URL/PGBOUNCER_CONNECTION_STRING/BROKKR_ADMIN_ORG_ID — real, sensitive values under dev/stg).
  sensitiveNames = builtins.filter (n: !(lib.hasPrefix "VITE_" n)) (
    builtins.attrNames contract.profiles.default
  );
  nonSecretEnv = builtins.removeAttrs hubEnv sensitiveNames;

  # hub-api and hub-web both render this; under local (runtimeSecrets = false) it equals the previous
  # `hubEnv` render exactly, so the hermetic path is byte-identical.
  renderEnv = lib.mapAttrsToList (n: v: "${n}=${v}") (
    if runtimeSecrets then nonSecretEnv else hubEnv
  );

  bm = pkgs.stdenv.isLinux && config.fleet.planes.baremetal;
  hubApiBmEnv = lib.optionalAttrs bm {
    PHONE_HOME_BASE_URL = "http://${config.fleet.baremetal.ifaceIp}:${toString P.ports.hubApi.base}";
  };
  renderApiEnv = lib.mapAttrsToList (n: v: "${n}=${v}") (
    (if runtimeSecrets then nonSecretEnv else hubEnv) // hubApiBmEnv
  );

  # hub-api exec: local runs pnpm directly; dev/stg wraps it with `secretspec run` to inject the
  # sensitive secrets at launch. The verb sets a DEVENV_ROOT-relative dotenv provider while the exec
  # runs after cdRepo into HUB_REPO_PATH, so resolve a relative dotenv path against $DEVENV_ROOT first.
  secretspecBin = "${pkgs.secretspec}/bin/secretspec";
  runApi =
    if runtimeSecrets then
      ''
        prov='${ss.provider}'
        case "$prov" in
          dotenv:/*) : ;;
          dotenv:*)  prov="dotenv:$DEVENV_ROOT/''${prov#dotenv:}" ;;
        esac
        exec ${secretspecBin} run --profile '${
          if ss.profile == null then "default" else ss.profile
        }' --provider "$prov" -- pnpm --filter api dev
      ''
    else
      "exec pnpm --filter api dev";

  # hub:init's workspace-package build. The fingerprint below reuses this verbatim (plus the cli the
  # task builds separately) so the guard can never describe a narrower set than the task writes.
  hubInitBuild = ''pnpm exec turbo run build --filter="./packages/*" --filter="./packages/plugins/*"'';
  hubInitStamp = "${config.env.DEVENV_STATE}/hub/init-build.fingerprint";
  # content fingerprint of that build closure, taken from turbo's own dry run: each task's `inputs`
  # (path → git blob hash, so it honours turbo.json's per-task `inputs` and sees untracked edits), its
  # external-dependency hash, and whether its outputs are actually on disk (a wiped dist must rebuild).
  # Deliberately NOT turbo's task `hash`: that folds in globalEnv VALUES, and this task re-runs inside
  # every dependent process's closure (`devenv-tasks run --mode all`), where REDIS_URL/NODE_ENV differ
  # per process — a hash-based fingerprint would differ per triggering process and never hold. The
  # cost is that an env-only change no longer rebuilds; every file/dependency change still does.
  hubInitFingerprint = ''
    ${hubInitBuild} --filter=@repo/cli --dry=json 2>/dev/null | node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c)).on("end", () => {
        const fs = require("fs"), path = require("path"), crypto = require("crypto");
        const j = JSON.parse(raw);
        if (!Array.isArray(j.tasks) || j.tasks.length === 0) process.exit(1);
        const g = j.globalCacheInputs || {};
        const lines = j.tasks.map((t) => {
          const inputs = Object.entries(t.inputs || {}).sort().map((e) => e.join(":")).join(",");
          const outputs = (t.outputs || []).filter((o) => !o.startsWith("!")).map((o) => {
            const dir = path.join(t.directory || ".", o.split("/")[0]);
            try { return fs.readdirSync(dir).length > 0 ? "1" : "0"; } catch { return "0"; }
          }).join("");
          return [t.taskId, t.hashOfExternalDependencies, outputs, inputs].join("|");
        });
        lines.push([g.hashOfExternalDependencies, g.hashOfInternalDependencies, JSON.stringify(g.files || {})].join("|"));
        process.stdout.write(crypto.createHash("sha256").update(lines.sort().join("\n")).digest("hex"));
      });
    ' '';
in
{
  # Pre-override hub env published for the control center (modules/overrides.nix). baseHubEnv, NOT
  # hubEnv: the point is the value a knob reverts TO. Reuses the process env's own secret gate, so
  # this never exposes a secret the eval-time render wouldn't already have written.
  stackDefaults = {
    hub = if runtimeSecrets then builtins.removeAttrs baseHubEnv sensitiveNames else baseHubEnv;
    inherit hubKnobEnv;
  };

  knobMeta = envKnobMeta lib "hub" hubKnobEnv hubKnobs;

  tasks = {
    "hub:init" = {
      description = "hub: pnpm install + workspace package build (prisma generate + tsc) + cli browser bundle.";
      # hostpaths:setup (/opt/brokkr, sudo one-shot) only stages spoke/fleet artifacts — skip it under
      # remote where neither runs, so a hub-only bring-up needs no sudo.
      after = lib.optionals localStack [ "hostpaths:setup" ];
      # Turbo REWRITES every output file even on a pure cache hit (a no-op re-run bumps
      # packages/*/dist mtimes), and process-compose re-runs this task's whole closure on every
      # control-center Apply / process restart. The spoke runs the bridge under `node --watch`, which
      # watches the packages/*/dist files it loaded — so an unconditional re-run SIGTERMs a live,
      # healthy bridge. Skip only while both the build inputs and the outputs on disk are unchanged
      # since the last successful run; anything else (missing stamp, turbo/node failure, empty output)
      # → not-satisfied → task runs (safe default).
      status = ''
        ${cdRepo "HUB_REPO_PATH"}
        stamp=${lib.escapeShellArg hubInitStamp}
        [ -s "$stamp" ] || exit 1
        # mirror brokkr-pnpm-install's own skip predicate: whenever IT would actually install, this
        # task must run. (A lockfile edit also moves the fingerprint, so this is belt-and-braces.)
        [ -e node_modules/.modules.yaml ] || exit 1
        [ node_modules/.modules.yaml -nt pnpm-lock.yaml ] || exit 1
        [ -x node_modules/.bin/turbo ] || exit 1
        fp="$(${hubInitFingerprint})" || exit 1
        [ -n "$fp" ] || exit 1
        [ "$fp" = "$(cat "$stamp")" ] || exit 1
        exit 0
      '';
      exec = ''
        set -euo pipefail
        . "${config.devenv.root}/devenv/lib/with-task-log.sh"
        begin_task_log "hub:init"
        ${cdRepo "HUB_REPO_PATH"}
        brokkr-pnpm-install
        ${hubInitBuild}
        pnpm --filter @repo/cli build
        # stamp last, and only on a clean fingerprint: a failed build leaves the previous value, which
        # cannot match the new inputs, so the next run retries. A fingerprint that won't compute is
        # non-fatal — it just means no skip next time.
        stamp=${lib.escapeShellArg hubInitStamp}
        mkdir -p "$(dirname "$stamp")"
        if fp="$(${hubInitFingerprint})" && [ -n "$fp" ]; then
          printf '%s\n' "$fp" > "$stamp"
        else
          echo "WARN: hub:init could not fingerprint the build closure; the next run will rebuild" >&2
        fi
      '';
    };

  }
  # local-only: migrate the LOCAL postgres. Under remote the deployed dev/stg env owns its schema,
  # and the task `after`s the local postgres process (gone under remote) — and would otherwise try to
  # connect to the now-absent local DB. Gate it out entirely.
  // lib.optionalAttrs localStack {
    "hub:migrate" = {
      description = "hub: prisma migrate deploy (idempotent; needs postgres healthy).";
      after = [
        "hub:init"
        "devenv:processes:postgres"
      ];
      exec = ''
        . "${config.devenv.root}/devenv/lib/with-task-log.sh"
        begin_task_log "hub:migrate"
        ${cdRepo "HUB_REPO_PATH"}
        DATABASE_URL="''${HUB_DATABASE_URL:-${pgUrl}}" \
          pnpm --filter @repo/database db:migrate:deploy
      '';
    };
  };

  # Each hub surface is its own supervised process — its own readiness probe, restart.on, and
  # log stream, so a crash of one is detected + restarted independently (the old api+admin+web+
  # web-admin fan-out probed only :3000, leaving the rest unsupervised). api + admin are the
  # scalable backends (HUB_PORT/ADMIN_PORT template off PC_REPLICA_NUM so `scale hub-api=N`/
  # `hub-admin=N` won't collide — per-replica probe ports are E3.3). web + web-admin are single
  # primary-only Vite dev servers. All four inherit the hub env.
  processes.hub-api = {
    # local: gate on the local migrate/seed DAG + the redis datastore. remote: the remote DB owns its
    # schema and there's no local redis to seed — depend only on the build (hub:init).
    after =
      if localStack then
        [
          "hub:migrate"
          "sql-seed:notify"
          "devenv:processes:redis"
        ]
      else
        [ "hub:init" ];
    process-compose = {
      # control-center "Apps" sidebar derives its links from these markers: LAB_WEB_UI is the
      # human label (its presence marks the process as serving a browser UI), LAB_WEB_PATH the
      # url path (default /), and LAB_WEB_PORT an override for when the readiness-probe port is
      # not the UI port. The marker rides the single per-surface process definition — a scaled
      # hub-api still yields one link, pinned to the base-instance probe port below.
      environment = renderApiEnv ++ [
        "LAB_WEB_UI=Hub Swagger"
        "LAB_WEB_PATH=/api/swagger"
      ];
      namespace = "hub";
      description = "Brokkr API";
    };
    exec = ''
      ${cdRepo "HUB_REPO_PATH"}
      i="''${PC_REPLICA_NUM:-0}"
      export HUB_PORT=$((${toString P.ports.hubApi.base} + ${toString P.ports.hubApi.step} * i))
      ${runApi}
    '';
    ready = {
      http.get = {
        host = P.hosts.loopback;
        port = P.ports.hubApi.base;
        path = "/healthcheck";
      };
      initial_delay = 3;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 60;
    };
    restart.on = "on_failure";
  };

  # The admin panel is now a standalone app (apps/admin-api) with its own dist, so the old
  # shared-dist race with hub-api's `nest --watch` (which forced the `node --watch
  # dist/main.admin.js` workaround) is gone — it runs its own `nest start --watch`. It still
  # gates on hub-api healthy: hub-api owns hub:migrate + sql-seed:notify, and healthy ⟺
  # migrations applied + schema seeded, which ported admin endpoints will rely on.
  processes.hub-admin = lib.mkIf adminApiPresent {
    after = [ "hub:init" ];
    process-compose = {
      environment = renderEnv;
      depends_on.hub-api.condition = "process_healthy";
      namespace = "hub";
      description = "Brokkr Admin API";
    };
    exec = ''
      ${cdRepo "HUB_REPO_PATH"}
      i="''${PC_REPLICA_NUM:-0}"
      export ADMIN_PORT=$((${toString P.ports.hubAdmin.base} + ${toString P.ports.hubAdmin.step} * i))
      # Staff org the admin guard scopes every identity to. Locally it derives from the same
      # identity.orgId as BROKKR_ADMIN_ORG_ID, so the sim brokkr org IS the admin org and the
      # bypass Owner is a member out of the box. Overridable via the process env (stack overrides).
      export HYDRAHOST_ORGANIZATION_ID="''${HYDRAHOST_ORGANIZATION_ID:-${config.identity.orgId}}"
      exec pnpm --filter admin-api dev
    '';
    ready = {
      http.get = {
        host = P.hosts.loopback;
        port = P.ports.hubAdmin.base;
        path = "/healthcheck";
      };
      initial_delay = 3;
      period = 2;
      probe_timeout = 5;
      failure_threshold = 60;
    };
    restart.on = "on_failure";
  };

  # web + web-admin: single primary-only Vite dev servers (proxy to api/admin; not scaled).
  processes.hub-web = {
    process-compose = {
      # API_PROXY_TARGET: vite.config.ts's /api proxy otherwise falls back to localhost:3000,
      # which is slot 0's hub — wrong for every slotted stack. A dial-out from this box, so it stays
      # on loopback whatever the public origin becomes.
      environment = renderEnv ++ [
        "LAB_WEB_UI=Hub"
        "API_PROXY_TARGET=${P.urls.dial.hubApi}"
      ];
      depends_on.hub-api.condition = "process_healthy";
      namespace = "hub";
      description = "Brokkr Web";
    };
    exec = ''
      ${cdRepo "HUB_REPO_PATH"}
      export PORT=${toString P.ports.hubWeb}
      exec pnpm --filter web dev
    '';
    ready = {
      http.get = {
        host = P.probeHost;
        port = P.ports.hubWeb;
        path = "/";
      };
      # probe_timeout is generous for Vite — GET / triggers first-request JIT compile
      # of the root route which can take 10-30s; the default 5s would kill it mid-compile.
      initial_delay = 3;
      period = 2;
      probe_timeout = 30;
      failure_threshold = 60;
    };
    restart.on = "on_failure";
  };

  processes.hub-web-admin = lib.mkIf adminWebPresent {
    process-compose = {
      environment = renderEnv ++ [ "LAB_WEB_UI=Admin" ];
      depends_on = lib.optionalAttrs adminApiPresent { hub-admin.condition = "process_healthy"; };
      namespace = "hub";
      description = "Brokkr Admin Web";
    };
    exec = ''
      ${cdRepo "HUB_REPO_PATH"}
      export PORT=${toString P.ports.hubWebAdmin}
      exec pnpm --filter admin-web dev
    '';
    ready = {
      http.get = {
        host = P.probeHost;
        port = P.ports.hubWebAdmin;
        path = "/";
      };
      # See hub-web above — bumped for Vite's first-request JIT compile.
      initial_delay = 3;
      period = 2;
      probe_timeout = 30;
      failure_threshold = 60;
    };
    restart.on = "on_failure";
  };
}
