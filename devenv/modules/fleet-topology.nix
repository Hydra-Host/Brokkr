{
  config,
  pkgs,
  lib,
  ...
}:

# Declarative fleet topology — schema, committed base, and rendering in one module. The
# tracked default lives in the `config.fleet` block below; per-host deltas in
# devenv.local.nix deep-merge over it (the base is one per-leaf `mkDefault` definition, so
# any leaf an overlay sets at normal priority wins while the rest is inherited). Nix renders
# the effective config to a /nix/store fleet.yml and points LOCAL_FLEET_PATH at it — an
# immutable store path, so there's no readFile eval-cache staleness. Field names mirror
# sim/scripts/local/schema.py 1:1 (snake_case, no translation).
#
# Topology is zone-nested: `fleet.zones.<name> = { index; bridges; nodes.<node>; }`. The
# renderer FLATTENS it to the schema's wire shape — a flat `nodes:` list (each stamped with
# its `zone`) plus a top-level `zones:` block — because the engine assigns each node's
# data/BMC IP + Device UUID by FLAT LIST POSITION (derived.node_ip/bmc_ip), independent of
# zone. Global order = zones by `index`, then nodes by `index`. A single default zone
# (index 0, name "sim-zone", one bridge) renders WITHOUT the zones block / per-node zone —
# byte-identical to the pre-zones single-spoke output, and schema.py's no-`zones` path treats
# it as the legacy zone 0.
#
# Pydantic (schema.py:Fleet) stays the validation authority: it re-validates the rendered
# YAML on load (unique names/MACs, IP-collision + CIDR checks, zone refs, NIC/disk/PCI
# formats). The typing here is the override seam + ergonomics, not enforcement.
let
  cfg = config.fleet;

  inherit (config.stack) slot;
  nodeCount = config.stack.fleetNodeCount;
  P0 = import ./ports.nix;
  # lib.toHexString is UPPERCASE; python f"{slot:02x}" (CI + engine) is lowercase — must byte-match
  hex2 = lib.toLower (lib.fixedWidthString 2 "0" (lib.toHexString slot));
  slotSuffix = if slot == 0 then "" else "-s${toString slot}";
  # console base comes from ports.nix (its header: no port is declared twice anywhere else)
  mkNode =
    i:
    let
      n = toString i;
    in
    {
      ipmi_mac = "52:54:00:bc:${hex2}:0${n}";
      data_mac = "52:54:00:da:${hex2}:0${n}";
    }
    // lib.optionalAttrs (slot > 0) { console_port = P0.consoleBaseFor slot + (i - 1); };

  # Per-leaf mkDefault — applied to each scalar leaf, not once around the whole tree: the
  # module system resolves priority per definition, so a single outer mkDefault would be
  # discarded wholesale the moment an overlay touched any sub-key (dropping every sibling).
  # Per-leaf defaults let base leaves and overlay leaves merge — an overlay wins only the
  # exact fields it sets (e.g. `fleet.zones.sim-zone.nodes.cpu-1.memory_mb = 16384;`).
  mkDefaults = lib.mapAttrsRecursive (_path: v: lib.mkDefault v);

  # one freeform attrset per node + the two Nix-only control fields (enable/index),
  # stripped before render.
  nodeType = lib.types.submodule (
    { name, ... }:
    {
      freeformType = lib.types.attrsOf lib.types.anything;
      options = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Render this node. Set false in an overlay to drop a base node without mkForce.";
        };
        index = lib.mkOption {
          type = lib.types.int;
          default =
            let
              m = builtins.match ".*-([0-9]+)" name;
            in
            if m == null then 0 else lib.toInt (lib.head m);
          description = "Ordering key within its zone → flattened list position → index-derived data/BMC IP (default: trailing -N of the node name).";
        };
      };
    }
  );

  bmNodeType = lib.types.submodule (
    { name, ... }:
    {
      options = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = true;
          description = "Render this machine. Set false in an overlay to drop a base machine without mkForce.";
        };
        index = lib.mkOption {
          type = lib.types.int;
          default =
            let
              m = builtins.match ".*-([0-9]+)" name;
            in
            if m == null then 0 else lib.toInt (lib.head m);
          description = "Ordering key for the emitted baremetal.nodes list (determinism only — bm identity is MAC-keyed, default: trailing -N of the name).";
        };
        pxe_mac = lib.mkOption {
          type = lib.types.str;
          description = "The NIC the machine PXE-boots from — its Hub Device identity (bm_device_uuid keys off it).";
        };
        bmc_ip = lib.mkOption {
          type = lib.types.str;
          description = "The BMC's IPv4 address on the LAN (Redfish/IPMI target).";
        };
        bmc_mac = lib.mkOption {
          type = lib.types.str;
          description = "The BMC NIC MAC — REQUIRED (no synthetic fallback); needed by the DHCP proxy allowlist + credential resolver.";
        };
        arch = lib.mkOption {
          type = lib.types.nullOr (
            lib.types.enum [
              "amd64"
              "arm64"
            ]
          );
          default = null;
          description = "Per-machine arch override; null → inherit fleet.baremetal.arch.";
        };
        zone = lib.mkOption {
          type = lib.types.str;
          default = "sim-zone";
          description = "Hub Zone.name this machine belongs to (default: the base single zone).";
        };
        system_id = lib.mkOption {
          type = lib.types.nullOr lib.types.str;
          default = null;
          description = "Redfish System Id override; null → the first member of /redfish/v1/Systems.";
        };
        network_type = lib.mkOption {
          type = lib.types.nullOr (
            lib.types.enum [
              "nat"
              "public"
            ]
          );
          default = null;
          description = "Hub Device.networkType the seed stamps on this machine; null → the seed's default.";
        };
      };
    }
  );

  # one zone = one spoke-group of HA bridges. Zone NAME is the attr key (== Hub Zone.name).
  zoneType = lib.types.submodule {
    options = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Render this zone. Set false in an overlay to drop a base zone without mkForce, which would discard every sibling. A rename is the tombstone plus the new key.";
      };
      index = lib.mkOption {
        type = lib.types.int;
        default = 0;
        description = "0-based zone index → Zone UUID (local.zones.zone_uuid; 0 == legacy UUID) + spoke port block. Set explicitly per zone; must be unique (schema.py enforces).";
      };
      bridges = lib.mkOption {
        type = lib.types.int;
        default = 1;
        description = "HA spoke replicas in this zone — they share its Redis prefix + lifecycle queue and elect a leader; whichever is free claims a job.";
      };
      nodes = lib.mkOption {
        type = lib.types.attrsOf nodeType;
        default = { };
        description = "Per-node specs keyed by node name; freeform fields (ipmi_mac, data_mac, cpus, …) pass straight through to fleet.yml.";
      };
    };
  };

  # zones as a list, sorted by zone.index (so the flattened node list and the zones block
  # share one deterministic order). Sorting recovers numeric order from the unordered attrset.
  zonePairs = lib.sort (a: b: a.value.index < b.value.index) (
    lib.mapAttrsToList (name: z: {
      inherit name;
      value = z;
    }) (lib.filterAttrs (_: z: z.enable) cfg.zones)
  );

  # one zone's enabled nodes → list sorted by node index, each stamped with its zone name.
  mkZoneNodes =
    zname: z:
    let
      enabled = lib.filterAttrs (_: n: n.enable) z.nodes;
      tagged = lib.mapAttrsToList (name: n: {
        inherit name;
        inherit (n) index;
        spec = removeAttrs n [
          "enable"
          "index"
        ];
      }) enabled;
      sorted = lib.sort (a: b: a.index < b.index) tagged;
    in
    map (
      e:
      {
        inherit (e) name;
        zone = zname;
      }
      // e.spec
    ) sorted;

  # flat global node list: zones by index, then nodes by index. Its POSITION drives each
  # node's IP/UUID (derived.py), so removing/disabling a non-terminal node still shifts every
  # downstream node's identity — pin explicit ip/bmc_ip to hold those fixed across removals.
  nodeList = lib.concatMap (zp: mkZoneNodes zp.name zp.value) zonePairs;

  zonesMeta = map (zp: {
    inherit (zp.value) index bridges;
    inherit (zp) name;
  }) zonePairs;

  # A lone default zone (index 0, one bridge, the canonical name) renders exactly like the
  # pre-zones output: no zones block, no per-node zone. schema.py's no-`zones` path then
  # treats it as the legacy zone 0 — back-compat without special-casing the engine.
  isDefaultSingle =
    (builtins.length zonePairs == 1)
    && (
      let
        z = builtins.head zonePairs;
      in
      z.value.index == 0 && z.value.bridges == 1 && z.name == "sim-zone"
    );

  bmNodeList =
    let
      enabled = lib.filterAttrs (_: n: n.enable) cfg.baremetal.nodes;
      tagged = lib.mapAttrsToList (name: n: {
        inherit name;
        inherit (n) index;
        spec = removeAttrs n [
          "enable"
          "index"
        ];
      }) enabled;
      sorted = lib.sort (a: b: a.index < b.index) tagged;
    in
    map (
      e:
      {
        inherit (e) name;
      }
      // e.spec
    ) sorted;

  bmBlock =
    assert lib.assertMsg (cfg.baremetal.iface != "" && cfg.baremetal.ifaceIp != "")
      "a bare-metal machine requires fleet.baremetal.iface and fleet.baremetal.ifaceIp to be set (a real host NIC + its IPv4); set them in devenv.local.nix.";
    {
      inherit (cfg.baremetal) iface arch;
      iface_ip = cfg.baremetal.ifaceIp;
      nodes = bmNodeList;
    };

  zoneShaped =
    assert lib.assertMsg (builtins.length zonePairs > 0)
      "every fleet.zones entry is disabled, so the fleet would render no zone, no spoke and no seed; leave at least one enabled.";
    assert lib.assertMsg (
      cfg.planes.vm || cfg.planes.baremetal
    ) "the fleet has no enabled node in either plane; enable a VM node or add a bare-metal machine";
    if isDefaultSingle then
      { nodes = map (n: removeAttrs n [ "zone" ]) nodeList; }
    else
      {
        nodes = nodeList;
        zones = zonesMeta;
      };

  effective = {
    inherit (cfg) network defaults;
  }
  // zoneShaped
  // lib.optionalAttrs cfg.planes.baremetal { baremetal = bmBlock; };

  # drop null/unset optionals so Pydantic's own defaulting still applies (omit
  # defaults.arch → host-arch detection; omit node.ip → index-derived IP).
  prune =
    v:
    if lib.isAttrs v then
      lib.mapAttrs (_: prune) (lib.filterAttrs (_: x: x != null) v)
    else if lib.isList v then
      map prune v
    else
      v;

  fleetYaml = pkgs.writeText "fleet.yml" (builtins.toJSON (prune effective));
in
{
  options.fleet = {
    planes = {
      vm = lib.mkOption {
        type = lib.types.bool;
        readOnly = true;
        description = "True when at least one VM node is enabled; the libvirt plane renders and SIM_REDFISH_PORT is set.";
      };
      baremetal = lib.mkOption {
        type = lib.types.bool;
        readOnly = true;
        description = "True when at least one bare-metal machine is enabled; the PXE plane renders on the uplink NIC.";
      };
    };
    network = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Network planes rendered verbatim into fleet.yml: name / cidr / domain / bmc_cidr, plus the optional dhcp and rendered_netplan toggles (both default false in Pydantic).";
    };
    defaults = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = { };
      description = "Fleet-wide node defaults: cpus / memory_mb / disk_gb / arch / bmc / disks / passthrough.";
    };
    zones = lib.mkOption {
      type = lib.types.attrsOf zoneType;
      default = { };
      description = "Per-zone specs keyed by Hub Zone.name; each carries index / bridges (HA spoke replicas) and its nodes. One default zone 'sim-zone' (index 0, 1 bridge) == the legacy single-spoke fleet.";
    };
    baremetal = {
      iface = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "Host NIC the spoke answers DHCP proxy/TFTP on (a real LAN interface). Required when a bare-metal machine is enabled.";
      };
      ifaceIp = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = "That NIC's IPv4 — the base for the baked CHAIN_BASE_URL + phone-home. Required when a bare-metal machine is enabled.";
      };
      arch = lib.mkOption {
        type = lib.types.enum [
          "amd64"
          "arm64"
        ];
        default = "amd64";
        description = "Fleet-wide default arch for bare-metal machines (per-machine arch overrides it).";
      };
      nodes = lib.mkOption {
        type = lib.types.attrsOf bmNodeType;
        default = { };
        description = "Bare-metal machines keyed by name. Each carries pxe_mac / bmc_ip / bmc_mac (required) + optional arch / zone / system_id / network_type. NO creds (sealed separately).";
      };
    };
  };

  # Committed base topology — the tracked default the stack renders from. To change the
  # default shipped to everyone, edit here; per-host experiments go in devenv.local.nix
  # (deep-merged per leaf via mkDefaults above). `arch` is intentionally omitted so schema.py's
  # host-arch detection applies (force cross-arch TCG with `fleet.defaults.arch` in an overlay).
  # The two MACs per node model the prod bare-metal NIC split: ipmi_mac (BMC NIC; seeds Redfish
  # UUID + SCSI serial/WWN) and data_mac (customer NIC; what qemu reports + bootpd matches).
  # "bc" octet = BMC plane, "da" octet = DAta plane. The base is one zone — add more under
  # fleet.zones.<name> (with a unique index + its own nodes) to model a multi-zone fleet.
  config.fleet =
    mkDefaults {
      network = {
        name = "brokkr-net";
        cidr = "192.168.${toString (200 + slot)}.0/24";
        domain = "sim.local";
        bmc_cidr = "192.168.${toString (105 + slot)}.0/24";
      };
      defaults = {
        cpus = 2;
        memory_mb = 2048;
        disk_gb = 40;
        bmc = {
          username = "admin";
          password = "admin";
        };
      };
      # single zone (index 0, 1 bridge → the lone `spoke`, legacy zone UUID …111). Slot 0 keeps
      # the literal 4-node set (byte-parity, no console stamps); slots >=1 generate nodeCount
      # nodes named s<S>-cpu-N with slot-derived MACs + console ports.
      zones."sim-zone" = {
        index = 0;
        bridges = 1;
        nodes =
          if slot == 0 then
            {
              cpu-1 = {
                ipmi_mac = "52:54:00:bc:00:01";
                data_mac = "52:54:00:da:00:01";
              };
              cpu-2 = {
                ipmi_mac = "52:54:00:bc:00:02";
                data_mac = "52:54:00:da:00:02";
              };
              cpu-3 = {
                ipmi_mac = "52:54:00:bc:00:03";
                data_mac = "52:54:00:da:00:03";
              };
              cpu-4 = {
                ipmi_mac = "52:54:00:bc:00:04";
                data_mac = "52:54:00:da:00:04";
              };
            }
          else
            builtins.listToAttrs (
              map (i: {
                name = "s${toString slot}-cpu-${toString i}";
                value = mkNode i;
              }) (lib.range 1 nodeCount)
            );
      };
    }
    // {
      planes = {
        vm = nodeList != [ ];
        baremetal = bmNodeList != [ ];
      };
    };

  # LOCAL_FLEET_SOURCE is the immutable /nix/store seed produced by this eval.
  # LOCAL_FLEET_PATH is the stable runtime location every consumer reads — bootstrapped
  # from the source via `cp -n` in each consumer's exec, then writable by the control
  # center so a fleet edit doesn't require a devenv re-eval to take effect. Stack reset
  # deletes the stable file so the next bring-up re-seeds from the source.
  config.env.LOCAL_FLEET_SOURCE = "${fleetYaml}";
  config.env.LOCAL_FLEET_PATH = "${config.env.DEVENV_STATE}/fleet.yaml";
  config.env.LOCAL_DATA_BRIDGE = "br-brokkr${slotSuffix}";
}
