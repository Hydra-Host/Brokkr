{
  config,
  lib,
  options,
  ...
}:

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

  # Presentation metadata cannot ride on mkOption — it rejects unknown arguments — so `knob` takes
  # ONE attrset, forwards the option arguments to mkOption and keeps the rest in a side table that
  # `knobsIn` re-keys by option path. `kind`, `choices`, `default` and the tooltip are deliberately
  # NOT metadata: knobCatalog derives them from the option's own type/default/description, so a knob
  # can never advertise a widget or a revert-to value the module system disagrees with.
  metaKeys = lib.genAttrs [
    "label"
    "group"
    "editable"
    "danger"
    "secret"
    "alias"
    "overrideFrom"
  ] (_: null);
  knob = attrs: {
    _knob = true;
    meta = builtins.intersectAttrs metaKeys attrs;
    option = lib.mkOption (builtins.removeAttrs attrs (lib.attrNames metaKeys));
  };
  isKnob = v: builtins.isAttrs v && v ? _knob;
  port =
    default: meta:
    knob (
      {
        type = lib.types.port;
        inherit default;
      }
      // meta
    );
  baseStep = d: meta: {
    base = port d.base meta;
    step = lib.mkOption {
      type = lib.types.int;
      default = d.step;
    };
  };

  toOptions =
    tree:
    lib.mapAttrs (
      _: v:
      if isKnob v then
        v.option
      else if lib.isOption v then
        v
      else
        toOptions v
    ) tree;
  knobsIn =
    prefix: tree:
    lib.foldl' (
      acc: name:
      let
        v = tree.${name};
        p = if prefix == "" then name else "${prefix}.${name}";
      in
      if isKnob v then
        acc // { ${p} = v.meta; }
      else if lib.isOption v then
        acc
      else
        acc // knobsIn p v
    ) { } (lib.attrNames tree);

  # The editable/read-only split is data, not prose: options.ports below is the merge of these two
  # groups and options.portGroups publishes their key sets, so the control center reads the
  # partition instead of re-deriving it. Merging keeps config.ports one flat map for consumers.
  editablePorts = {
    nginx = port slotPorts.nginx {
      label = "OS-layer cache (nginx)";
      group = "Boot/cache";
      description = "Listener for the local OS-layer cache; the device pulls layer blobs from it instead of re-hitting the CDN.";
    };
    mailpitSmtp = port slotPorts.mailpitSmtp {
      label = "Mailpit SMTP";
      group = "Email";
      description = "SMTP ingest of the local email catcher — the hub's SMTP_PORT derives from it, so moving it moves the hub's dialer with the listener.";
    };
    mailpitWeb = port slotPorts.mailpitWeb {
      label = "Mailpit web UI";
      group = "Email";
      description = "Web UI / API where captured local email is read.";
    };
    redfish = port slotPorts.redfish {
      label = "Redfish (sushy)";
      group = "Fleet";
      description = "sushy-emulator listener (SIM_REDFISH_PORT). Read by the sim BMC daemons at startup, so a change applies on the next fleet rebuild, not a live restart.";
    };
    postgres = port slotPorts.postgres {
      label = "Postgres";
      group = "Datastores";
      description = "Postgres listener. A change needs only a restart — the datadir persists.";
    };
    redis = port slotPorts.redis {
      label = "Redis";
      group = "Datastores";
      description = "Redis listener — the hub's BullMQ queues, config atoms and pub/sub, and every bridge, dial it.";
    };
    thanosHttp = port slotPorts.thanosHttp {
      label = "Thanos HTTP";
      group = "Observability";
      description = "Thanos receive HTTP API.";
    };
    thanosGrpc = port slotPorts.thanosGrpc {
      label = "Thanos gRPC";
      group = "Observability";
      description = "Thanos receive store API — what the query frontend fans out to.";
    };
    thanosRemoteWrite = port slotPorts.thanosRemoteWrite {
      label = "Thanos remote-write";
      group = "Observability";
      description = "Remote-write ingest each bridge's telegraf ships device metrics to.";
    };
  };

  # the control center's own ports, the hub/spoke replica port math, and the loopback-only
  # observability sink (modules/telemetry.nix) — declared here so config.ports is the whole map.
  # `editable = false` keeps these out of the writable map but still in the catalog; a port declaring
  # no metadata now fails the eval rather than silently vanishing from it.
  readOnlyPorts = {
    thanosQueryHttp = port slotPorts.thanosQueryHttp {
      label = "Thanos query HTTP";
      group = "Observability";
      editable = false;
      description = "Thanos query frontend, serving the Prometheus HTTP API the dashboards read.";
    };
    thanosQueryGrpc = port slotPorts.thanosQueryGrpc {
      label = "Thanos query gRPC";
      group = "Observability";
      editable = false;
      description = "Thanos query internal gRPC, how the frontend fans out to the store APIs.";
    };
    lab = port slotPorts.lab {
      label = "Control center API";
      group = "Control center";
      editable = false;
      description = "Listener this control center itself serves; moving it moves the API you are reading this from.";
    };
    labWeb = port slotPorts.labWeb {
      label = "Control center web";
      group = "Control center";
      editable = false;
      description = "Vite dev server for the control center SPA, which proxies /api to the control center API.";
    };
    hubWeb = port slotPorts.hubWeb {
      label = "Hub web SPA";
      group = "Hub";
      editable = false;
      description = "Vite dev server for the hub SPA. Only the primary hub serves one.";
    };
    hubWebAdmin = port slotPorts.hubWebAdmin {
      label = "Admin web SPA";
      group = "Hub";
      editable = false;
      description = "Vite dev server for the admin panel SPA.";
    };
    hubApi = baseStep slotPorts.hubApi {
      label = "Hub API";
      group = "Hub";
      editable = false;
      description = "Base of the hub API listener band. Hub i binds base plus step times i, so a second hub never collides.";
    };
    hubAdmin = baseStep slotPorts.hubAdmin {
      label = "Admin API";
      group = "Hub";
      editable = false;
      description = "Base of the admin API listener band, stepped per hub replica like the hub API.";
    };
    spoke = baseStep slotPorts.spoke {
      label = "Bridge HTTP";
      group = "Bridge";
      editable = false;
      description = "Base of the bridge HTTP band. Bridge ordinal n binds base plus step times n, and zones take contiguous ordinal blocks in index order.";
    };
    spokeGrpc = baseStep slotPorts.spokeGrpc {
      label = "Bridge gRPC";
      group = "Bridge";
      editable = false;
      description = "Base of the bridge gRPC band, stepped by the same ordinal as the bridge HTTP port.";
    };
    otlpGrpc = port slotPorts.otlpGrpc {
      label = "OTLP gRPC (collector)";
      group = "Observability";
      editable = false;
      description = "otel-collector OTLP gRPC ingest.";
    };
    otlpHttp = port slotPorts.otlpHttp {
      label = "OTLP HTTP (collector)";
      group = "Observability";
      editable = false;
      description = "otel-collector OTLP HTTP ingest, and the endpoint the hub exporter targets.";
    };
    otelcolHealth = port slotPorts.otelcolHealth {
      label = "Collector health";
      group = "Observability";
      editable = false;
      description = "otel-collector readiness endpoint.";
    };
    tempoHttp = port slotPorts.tempoHttp {
      label = "Tempo query";
      group = "Observability";
      editable = false;
      description = "Tempo query API, which Grafana reads as a datasource.";
    };
    tempoGrpc = port slotPorts.tempoGrpc {
      label = "Tempo gRPC";
      group = "Observability";
      editable = false;
      description = "Tempo internal server gRPC.";
    };
    tempoOtlpGrpc = port slotPorts.tempoOtlpGrpc {
      label = "Tempo OTLP gRPC";
      group = "Observability";
      editable = false;
      description = "OTLP gRPC ingest the collector forwards traces to.";
    };
    tempoOtlpHttp = port slotPorts.tempoOtlpHttp {
      label = "Tempo OTLP HTTP";
      group = "Observability";
      editable = false;
      description = "OTLP HTTP ingest the collector forwards traces to.";
    };
    grafana = port slotPorts.grafana {
      label = "Grafana UI";
      group = "Observability";
      editable = false;
      description = "Grafana UI.";
    };
    lokiHttp = port slotPorts.lokiHttp {
      label = "Loki HTTP";
      group = "Observability";
      editable = false;
      description = "Loki query API and its native OTLP logs ingest.";
    };
    lokiGrpc = port slotPorts.lokiGrpc {
      label = "Loki gRPC";
      group = "Observability";
      editable = false;
      description = "Loki internal server gRPC.";
    };
  };

  scalar = lib.types.nullOr (
    lib.types.oneOf [
      lib.types.bool
      lib.types.int
      lib.types.str
    ]
  );

  # Read back out of the same table render-env-pins.sh resolves a shorthand with, so the catalog
  # cannot advertise a variable the renderer rejects. VAR=dotted.path — it parses with no JSON tool.
  pinEnvByPath =
    let
      lines = lib.filter (l: l != "" && !(lib.hasPrefix "#" l)) (
        map (lib.removeSuffix "\r") (lib.splitString "\n" (builtins.readFile ../env-pin-aliases.txt))
      );
      entry =
        l:
        let
          var = lib.head (lib.splitString "=" l);
        in
        lib.nameValuePair (lib.removePrefix "${var}=" l) var;
    in
    lib.listToAttrs (map entry lines);

  knobMetaType = lib.types.submodule {
    options = {
      label = lib.mkOption {
        type = lib.types.str;
        description = "Human-readable knob name.";
      };
      group = lib.mkOption {
        type = lib.types.str;
        description = "Section the control center files this knob under.";
      };
      editable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Whether an overlay may pin this knob. False = catalogued for display only.";
      };
      danger = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether flipping this knob weakens a production-shaped behavior and needs a confirm.";
      };
      secret = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Whether the value is a credential and must be masked. Declared here so no consumer has to guess from the knob's name.";
      };
      alias = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Further keys this knob's value lands on — read back OUT of the remap that produces them, never restated.";
      };
      overrideFrom = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Attrs-option path a user override for this knob lands in (env knobs only; option knobs merge in place).";
      };
      description = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Tooltip for a knob with no option of its own. A knob that IS an option must leave this null — its own description wins.";
      };
      kind = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Widget for a knob with no option of its own. Derived from the type otherwise.";
      };
      choices = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Allowed values for a `select` knob with no option of its own. Derived from an enum type otherwise.";
      };
    };
  };

  catalogEntryType = lib.types.submodule {
    options = {
      path = lib.mkOption {
        type = lib.types.str;
        description = "Dotted config path the knob's value is read from.";
      };
      label = lib.mkOption {
        type = lib.types.str;
        description = "Human-readable knob name.";
      };
      group = lib.mkOption {
        type = lib.types.str;
        description = "Section the control center files this knob under.";
      };
      description = lib.mkOption {
        type = lib.types.str;
        description = "What the knob does and what changes when it moves.";
      };
      kind = lib.mkOption {
        type = lib.types.str;
        description = "Widget: bool / text / number / port / select, else the raw type name.";
      };
      bounds = lib.mkOption {
        type = lib.types.nullOr (
          lib.types.submodule {
            options = {
              min = lib.mkOption { type = lib.types.int; };
              max = lib.mkOption { type = lib.types.int; };
            };
          }
        );
        default = null;
        description = "Inclusive range a bounded numeric knob accepts, read from its type and proven against that type's own check. Null when the type declares no range.";
      };
      choices = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ ];
        description = "Allowed values, non-empty only for `select`.";
      };
      default = lib.mkOption {
        type = scalar;
        description = "Pre-override value — what a revert lands on. Null when the Nix layer declares no value for the knob.";
      };
      editable = lib.mkOption {
        type = lib.types.bool;
        description = "Whether an overlay may pin this knob.";
      };
      danger = lib.mkOption {
        type = lib.types.bool;
        description = "Whether flipping it weakens a production-shaped behavior.";
      };
      secret = lib.mkOption {
        type = lib.types.bool;
        description = "Whether the value is a credential and must be masked.";
      };
      alias = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Further keys this knob's value lands on.";
      };
      overrideFrom = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Attrs-option path a user override for this knob lands in; null when the knob merges in place.";
      };
      pinEnv = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "Shorthand environment variable that pins this knob (devenv/env-pin-aliases.txt), null when it has none. The canonical BROKKR_CFG_<path, dots as __> form always works.";
      };
    };
  };

  # Every per-path publication below is a LIST keyed by `path`, not an attrset: `devenv eval` cannot
  # serialize an attrset whose keys contain dots, and a knob path is dotted by construction.
  provenanceType = lib.types.submodule {
    options = {
      path = lib.mkOption {
        type = lib.types.str;
        description = "Dotted config path this attribution is for.";
      };
      files = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        description = "Repo-relative files responsible for the current value: the definitions when the knob is set, else the declaration carrying its default.";
      };
      perKey = lib.mkOption {
        type = lib.types.attrsOf (lib.types.listOf lib.types.str);
        default = { };
        description = "Per-attribute definition files. Present only for an attrsOf option, where one file rarely owns the whole map.";
      };
    };
  };

  valueType = lib.types.submodule {
    options = {
      path = lib.mkOption {
        type = lib.types.str;
        description = "Dotted config path this value is for.";
      };
      value = lib.mkOption {
        type = scalar;
        description = "Effective value: the override where one is set, else the pre-override default.";
      };
    };
  };

  # Everything the catalog reports beyond presentation comes from the module system.
  kindByType = {
    bool = "bool";
    str = "text";
    path = "text";
    int = "number";
    intBetween = "number";
    unsignedInt16 = "port";
    enum = "select";
  };
  kindOf = t: kindByType.${t.name} or t.name;
  # functor.payload is a nixpkgs internal. A silent [] would render a select with no options and say
  # nothing, so a shape change fails the eval instead.
  choicesOf =
    t:
    if t.name != "enum" then
      [ ]
    else
      map toString (
        t.functor.payload.values
          or (throw "choicesOf: lib.types.enum no longer exposes functor.payload.values; update modules/overrides.nix")
      );
  # A bounded int keeps lo/hi only inside its check closure, so read them from the description and
  # then PROVE them against that closure — a nixpkgs rewording fails the eval instead of publishing
  # a wrong range that a writer would then enforce.
  boundsOf =
    t:
    let
      desc = if builtins.isString (t.description or null) then t.description else "";
      m = builtins.match ".*between (-?[0-9]+) and (-?[0-9]+) \\(both inclusive\\).*" desc;
    in
    if m == null then
      null
    else
      let
        min = lib.toInt (builtins.elemAt m 0);
        max = lib.toInt (builtins.elemAt m 1);
      in
      assert lib.assertMsg (t.check min && t.check max && !(t.check (min - 1)) && !(t.check (max + 1)))
        "boundsOf: read ${toString min}..${toString max} out of '${desc}', but the type's own check disagrees; update modules/overrides.nix";
      {
        inherit min max;
      };

  descOf =
    d:
    if d == null then
      null
    else if builtins.isString d then
      d
    else
      d.text or null;

  optAt = parts: if lib.hasAttrByPath parts options then lib.getAttrFromPath parts options else null;
  isOptAt =
    parts:
    let
      o = optAt parts;
    in
    o != null && lib.isOption o;
  relFile = f: lib.removePrefix "${toString config.devenv.root}/" (toString f);

  # Bridge ordinals run from ports.spoke.base up to the next declared port above it, so the budget
  # follows an operator who moves that neighbour rather than a number written down here.
  bridgeOrdinalBudget =
    let
      inherit (config.ports.spoke) base;
      scalars = lib.filter (v: builtins.isInt v) (
        lib.mapAttrsToList (_: v: if builtins.isAttrs v then (v.base or null) else v) config.ports
      );
      above = lib.filter (v: v > base) scalars;
    in
    if above == [ ] then 0 else (lib.foldl' lib.min (builtins.head above) above) - base;

  # Which files declare each zone, for the same reason as the nodes below: renaming or deleting a zone
  # the base declares needs the enable tombstone, and only the definition sites can say which those are.
  zoneFiles = lib.foldl' (
    acc: d: acc // lib.genAttrs (lib.attrNames d.value) (z: (acc.${z} or [ ]) ++ [ (relFile d.file) ])
  ) { } options.fleet.zones.definitionsWithLocations;

  # `fleet.zones` is an attrsOf submodule, so a per-node path resolves in no option and provFor
  # cannot reach it. Walk the definitions directly instead.
  fleetNodeFiles = lib.foldl' (
    acc: d:
    lib.foldl' (
      a: zname:
      let
        prev = a.${zname} or { };
        nodes = lib.attrNames (d.value.${zname}.nodes or { });
      in
      a // { ${zname} = prev // lib.genAttrs nodes (n: (prev.${n} or [ ]) ++ [ (relFile d.file) ]); }
    ) acc (lib.attrNames d.value)
  ) { } options.fleet.zones.definitionsWithLocations;

  # An env knob (a key inside stackDefaults.<group>) has no option of its own: its value lives in the
  # containing attrsOf under its own name, or — where the module remaps it on the way to the process
  # env — under one of the keys it aliases to.
  lookupKeys =
    base: keys:
    lib.findFirst (v: v != null) null (map (k: lib.attrByPath (base ++ [ k ]) null config) keys);
  keysOf = parts: meta: [ (lib.last parts) ] ++ meta.alias;

  entryFor =
    path: meta:
    let
      parts = lib.splitString "." path;
      isOpt = isOptAt parts;
      o = optAt parts;
      require =
        what: v:
        if v == null || v == "" then throw "knobCatalog: knob '${path}' declares no ${what}" else v;
    in
    {
      inherit path;
      inherit (meta)
        label
        group
        editable
        danger
        secret
        alias
        overrideFrom
        ;
      pinEnv = pinEnvByPath.${path} or null;
      description = require "description" (
        if isOpt then descOf (o.description or null) else meta.description
      );
      kind = require "kind" (if isOpt then kindOf o.type else meta.kind);
      choices = if isOpt then choicesOf o.type else meta.choices;
      bounds = if isOpt then boundsOf o.type else null;
      default = if isOpt then o.default or null else lookupKeys (lib.init parts) (keysOf parts meta);
    };

  valueFor =
    path: meta:
    let
      parts = lib.splitString "." path;
      keys = keysOf parts meta;
      override =
        if meta.overrideFrom == null then null else lookupKeys (lib.splitString "." meta.overrideFrom) keys;
    in
    {
      inherit path;
      value =
        if isOptAt parts then
          lib.attrByPath parts null config
        else if override != null then
          override
        else
          lookupKeys (lib.init parts) keys;
    };

  perKeyFiles =
    o:
    lib.foldl' (
      acc: d: acc // lib.genAttrs (lib.attrNames d.value) (k: (acc.${k} or [ ]) ++ [ (relFile d.file) ])
    ) { } o.definitionsWithLocations;

  provFor =
    path:
    let
      parts = lib.splitString "." path;
      o = optAt parts;
      container = optAt (lib.init parts);
      meta = config.knobMeta.${path} or null;
      keys = if meta == null then [ (lib.last parts) ] else keysOf parts meta;
      defines = d: builtins.isAttrs d.value && lib.any (k: d.value ? ${k}) keys;
    in
    {
      inherit path;
    }
    // (
      if isOptAt parts then
        {
          files = map relFile (if o.files == [ ] then o.declarations else o.files);
        }
        // lib.optionalAttrs (o.type.name == "attrsOf") { perKey = perKeyFiles o; }
      else if container != null && lib.isOption container then
        {
          files = lib.unique (
            map (d: relFile d.file) (lib.filter defines container.definitionsWithLocations)
          );
        }
      else
        { files = [ ]; }
    );

  catalogPaths = lib.attrNames config.knobMeta;
  strayPinEnv = lib.subtractLists catalogPaths (lib.attrNames pinEnvByPath);
  # Every catalog leaf, plus the attrs options an env knob lives in and is overridden through — the
  # per-key view of who set what belongs beside the per-knob one.
  provenancePaths = lib.unique (
    catalogPaths
    ++ lib.concatMap (
      p:
      let
        parts = lib.splitString "." p;
        meta = config.knobMeta.${p};
      in
      lib.optional (!isOptAt parts) (lib.concatStringsSep "." (lib.init parts))
      ++ lib.optional (meta.overrideFrom != null) meta.overrideFrom
    ) catalogPaths
  );

  declared = {
    stack = {
      slot = knob {
        type = lib.types.ints.between 0 46;
        default = 0;
        label = "Stack slot";
        group = "Stack";
        # A slot move re-derives every port, subnet and state path, so it is claimed by
        # devenv/scripts/stack-claim.sh against the runtime registry, not pinned from the UI.
        editable = false;
        description = ''
          Multi-stack instance slot. 0 = legacy single-stack layout (byte-identical
          to pre-slot behavior). Slots >=1 derive disjoint ports (20000+500*S blocks),
          subnets (192.168.(200+S)/(105+S)), MACs, node names, and state paths so
          multiple worktrees can run concurrent stacks.
        '';
      };
      fleetNodeCount = knob {
        type = lib.types.ints.between 1 4;
        default = if config.stack.slot == 0 then 4 else 1;
        label = "Generated fleet nodes";
        group = "Scale";
        description = "How many nodes the generator produces for a slot at or above 1, where the node set is derived rather than the literal committed four. Slot 0 keeps its four literal nodes whatever this says, so changing it there does nothing.";
      };
    };

    stackOverrides = {
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
    stackCounts = {
      hub = knob {
        type = lib.types.int;
        default = 1;
        label = "Hub replicas";
        group = "Scale";
        description = "Hub replica count.";
      };
      spoke = knob {
        type = lib.types.int;
        default = 1;
        label = "Spoke replicas";
        group = "Scale";
        description = "Spoke replica count.";
      };
    };

    # Whether `devenv up` auto-starts the simulated fleet. Declared here with the other
    # local-config / control-center knobs; consumed by modules/fleet.nix (the `fleet` process
    # is `disabled` when false). Set in devenv.local.nix for a control-plane-only bring-up.
    fleet.autoStart = knob {
      type = lib.types.bool;
      default = true;
      label = "Auto-start fleet";
      group = "Fleet";
      description = "Whether `devenv up` auto-starts the simulated fleet (build artifacts, power on the VMs). False brings up only the control plane; start the fleet on demand from the control center or with `process-compose -U -u $PC_SOCKET_PATH process start fleet`.";
    };

    # Local observability sink (modules/telemetry.nix): otel-collector + tempo + grafana as
    # `observability`-namespace processes, plus the hub's OTLP exporter env (modules/hub.nix).
    # Off by default — the hermetic stack pays nothing. Written by the control center into
    # stack.local.nix (like lan.expose), or set by hand in devenv.local.nix. When false the
    # processes stay defined-but-disabled (startable on demand from the control center or
    # `process-compose … process start`), but the hub exporter env only points at the collector while
    # the option is true — it renders at eval time, so flipping it needs a hub-api restart.
    telemetry.enable = knob {
      type = lib.types.bool;
      default = false;
      label = "Telemetry sink";
      group = "Observability";
      description = "Bring up the local telemetry sink (OTel collector -> Tempo traces + span-metrics -> Thanos, Grafana UI at the `grafana` port) and point the hub's OTLP exporter at it.";
    };

    # LAN exposure toggle. When true, the otherwise loopback-only datastores/services (postgres,
    # redis, thanos, mailpit, lab, lab-web, hub web) bind 0.0.0.0 for LAN/Tailscale reach instead of
    # 127.0.0.1 — consumed by modules/ports.nix `bindHost` + devenv.nix (pg_hba / redis protected-mode).
    # Set via the control center (written into stack.local.nix) or in devenv.local.nix.
    lan.expose = knob {
      type = lib.types.bool;
      default = false;
      label = "Expose on LAN";
      group = "Networking";
      danger = true;
      description = "Whether the loopback-only datastores/services bind 0.0.0.0 (LAN/Tailscale reach) instead of 127.0.0.1. Written by the control center into stack.local.nix.";
    };

    # Gate that, when true, would run the local hub compute against REMOTE infra (skipping the local
    # datastores/spoke/fleet/control-center + local migrate/seed). The dev/stg profiles that set it
    # true were removed (local-against-shared-infra caused contention + auth-bypass-seed risk), so it
    # now stays at its always-false default — only the hermetic local stack runs. The option is kept
    # because hub.nix / spoke.nix / fleet.nix / devenv.nix still branch on it.
    remoteInfra.enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Gate to run local hub compute against REMOTE infra (skip local datastores, spoke, fleet, control center, local migrate/seed). Always false now — the dev/stg profiles that set it true were removed; kept because other modules branch on it.";
    };

    # Gate the spoke's dev hot-reload: `node --watch` + the sibling `spoke-watch` (`nest build --watch`)
    # compiler. When false, the spoke runs the already-built dist ONCE (spoke:init builds it) with no
    # watcher. Set false for automated / CI / CONCURRENT sim: the decoupled build:watch -> dist-rewrite
    # -> `node --watch` restart races fleet:apply and flakes bring-up. (The hub avoids this by running
    # an integrated `nest start --watch` — see hub.nix.)
    spoke.watch = knob {
      type = lib.types.bool;
      default = true;
      label = "Spoke hot reload";
      group = "Behavior";
      description = "Run the spoke under dev hot-reload (node --watch plus the spoke-watch nest-build watcher). Set it false for automated, CI or concurrent sim: the decoupled build-watch, dist-rewrite and restart sequence races fleet:apply and flakes bring-up.";
    };

    # Service identity (the single source for who, not where — modules/ports.nix owns host:port).
    # devenv.nix + modules/hub.nix derive the postgres URL, services.postgres.initialDatabases, and the
    # org id from these; the control center writes them into stack.local.nix like the stackOverrides above.
    # NOTE: changing pg.{user,password,db} only takes effect on a fresh Postgres datadir (initialDatabases
    # runs once); an org-id change needs a reseed to propagate to the seeded org.
    identity = {
      pg = {
        user = knob {
          type = lib.types.str;
          default = "brokkr";
          label = "Postgres user";
          group = "Identity";
          description = "Postgres role the hub + sim connect as (also the created role). Takes effect only on a fresh datadir.";
        };
        password = knob {
          type = lib.types.str;
          default = "password";
          label = "Postgres password";
          group = "Identity";
          secret = true;
          description = "Postgres password (local dev). Takes effect only on a fresh datadir.";
        };
        db = knob {
          type = lib.types.str;
          default = "brokkr";
          label = "Postgres database";
          group = "Identity";
          description = "Postgres database name. Takes effect only on a fresh datadir.";
        };
      };
      orgId = knob {
        type = lib.types.str;
        default = "00000000-0000-0000-0000-000000000000";
        label = "Operator org id";
        group = "Identity";
        description = "Instance-operator org UUID — hub BROKKR_ADMIN_ORG_ID + sim SIM_HYDRAHOST_ORG_ID derive from this single value. A change needs a reseed to reach the seeded org.";
      };
    };

    # OS-layer cache (nginx) upstream — the CDN origin the local cache proxies + its DNS resolvers.
    # originHost is the single source of truth for the asset origin across the Nix layer: spoke.nix's
    # DISCOVERY_BASE_URL derives from it, mirroring the TS knob (ASSET_ORIGIN) and local-sim's
    # SIM_OS_LAYERS_MANIFEST_INDEX_URL. Defaults to the asset host; override per env via this knob.
    osLayerCache = {
      originHost = knob {
        type = lib.types.str;
        default = "brokkr.assets.hydra.host";
        label = "Asset origin host";
        group = "Boot/cache";
        description = "CDN asset origin host the OS-layer cache proxies to. Also the origin the spoke's DISCOVERY_BASE_URL derives from, so repointing it moves both the layer cache and discovery-image sync.";
      };
      resolvers = knob {
        type = lib.types.str;
        default = "1.1.1.1 8.8.8.8";
        label = "Cache DNS resolvers";
        group = "Boot/cache";
        description = "DNS resolvers nginx uses to re-resolve the rotating CDN origin IPs.";
      };
    };

    # The canonical port/host map promoted to options (defaults from modules/ports.nix). devenv.nix +
    # the hub/spoke modules read the effective values via `(import ./ports.nix).fromConfig config`, so
    # an override here ripples to the service bind, every readiness probe, the derived URLs, and the
    # labPortEnv the TS apps read. The control center surfaces ONLY the editable group as editable;
    # everything else stays read-only in the UI.
    ports = editablePorts // readOnlyPorts;

    portGroups = {
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
    portDefaults = lib.mkOption {
      type = lib.types.attrsOf lib.types.port;
      default = lib.mapAttrs (_: p: p.option.default) editablePorts;
      description = "Pre-override value of every portGroups.editable key (modules/ports.nix defaults). The control center diffs config.ports against this to decide which ports its overlay must pin.";
    };

    stackDefaults = {
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

    labBridges = lib.mkOption {
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

    # The knob surface itself, published for the control center and the CLI. knobMeta is the input
    # every module contributes to; the three below are the join of it with the module system.
    knobMeta = lib.mkOption {
      type = lib.types.attrsOf knobMetaType;
      default = { };
      description = "Presentation metadata per dotted knob path, contributed by the module that declares the knob. Never the type, the default or the tooltip — knobCatalog derives those from the option itself.";
    };

    knobCatalog = lib.mkOption {
      type = lib.types.listOf catalogEntryType;
      default = [ ];
      description = "Every knob the control center may render, sorted by path: presentation metadata joined with the option's own type, default and description.";
    };

    knobProvenance = lib.mkOption {
      type = lib.types.listOf provenanceType;
      default = [ ];
      description = "Per knob path, the files the module system attributes its value to — the real definition sites, never a scan of file text.";
    };

    labZoneFiles = lib.mkOption {
      type = lib.types.attrsOf (lib.types.listOf lib.types.str);
      default = { };
      description = "Repo-relative files declaring each zone. A zone no file but the control center's own overlay declares can have its key dropped; any other needs the enable tombstone.";
    };

    labZoneCapacity = lib.mkOption {
      type = lib.types.int;
      default = 0;
      description = "How many bridge ordinals fit before the spoke band walks into its neighbour. A zone set whose total `bridges` exceeds it collides silently, so the control center refuses the save instead.";
    };

    labFleetNodeFiles = lib.mkOption {
      type = lib.types.attrsOf (lib.types.attrsOf (lib.types.listOf lib.types.str));
      default = { };
      description = "Repo-relative files declaring each fleet node, keyed zone then node. A node no file but the control center's own overlay declares is one whose tombstone is safe to drop — dropping any other node's tombstone brings the node back.";
    };

    configModel = lib.mkOption {
      type = lib.types.submodule {
        options = {
          catalog = lib.mkOption {
            type = lib.types.listOf catalogEntryType;
            default = [ ];
            description = "config.knobCatalog.";
          };
          values = lib.mkOption {
            type = lib.types.listOf valueType;
            default = [ ];
            description = "Effective value per knob path — the override where one is set, else the pre-override default.";
          };
          provenance = lib.mkOption {
            type = lib.types.listOf provenanceType;
            default = [ ];
            description = "config.knobProvenance.";
          };
        };
      };
      default = { };
      description = "Catalog, effective values and provenance in one attr, so a renderer answers the whole question in a single `devenv eval`.";
    };
  };
in
{
  options = toOptions declared;

  config = {
    knobMeta = knobsIn "" declared;
    knobCatalog =
      assert lib.assertMsg (strayPinEnv == [ ])
        "devenv/env-pin-aliases.txt names paths that are not knobs: ${lib.concatStringsSep ", " strayPinEnv}";
      lib.mapAttrsToList entryFor config.knobMeta;
    knobProvenance = map provFor provenancePaths;
    labFleetNodeFiles = fleetNodeFiles;
    labZoneCapacity = bridgeOrdinalBudget;
    labZoneFiles = zoneFiles;
    configModel = {
      catalog = config.knobCatalog;
      values = lib.mapAttrsToList valueFor config.knobMeta;
      provenance = config.knobProvenance;
    };
  };
}
