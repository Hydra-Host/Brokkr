{
  pkgs,
  lib,
  config,
  ...
}:

# Local e2e harness for VRRP virtual-IP failover, OPT-IN and off by default —
# `vrrpSim.enable = false` contributes nothing, so a normal `task up` is byte-identical.
#
# The bridge VRRP reconciler binds floating IPs with real `iproute2` (`ip addr add … label
# brokkr-vrrp`) and reads interface state back with `ip -j addr show`. On a dev box we must not
# bind real addresses (and macOS has no `ip` at all), so this module puts a sim `ip`/`arping`
# shim first on each bridge's PATH. The shim (devenv/pkgs/vrrp-sim/ip.py) fakes exactly those
# verbs against a per-bridge JSON state file, modelling each bridge as its own netns. Production
# Linux uses the real `ip` under CAP_NET_ADMIN — the constant `brokkr-vrrp` label already works
# there for any interface name; this shim is strictly a local-sim device, never a prod path.
#
# Faithful to the product model: bridges report their REAL host NICs (no simulated
# interfaces), a VIP is a secondary address the leader adds on top of a real NIC, and NOTHING is
# bound automatically — `vrrpSim.enable = true` only turns the reconciler on. The operator
# creates the VIP's prefix/IP in IPAM (the `vrrp:seed` task pre-creates those rows to save
# clicks) and attaches the VIP to a bridge NIC through the hub UI, exactly like production.
#
# For an HA failover demo you also need TWO bridges in the zone — set that in your gitignored
# stack.local.nix (kept out of the module so it can't perturb the default single-spoke fleet):
#   fleet.zones."sim-zone".bridges = 2;
let
  cfg = config.vrrpSim;
  P = (import ./ports.nix).fromConfig config;
  inherit ((import ./lib.nix)) cdRepo;
  # Same local DB/Redis the hub uses, so the on-demand seed writes where the running stack reads.
  pgUrl = P.mkPgUrl { inherit (config.identity.pg) user password db; };

  ipShim = pkgs.writeShellScriptBin "ip" ''
    exec ${pkgs.python3}/bin/python3 ${../pkgs/vrrp-sim/ip.py} "$@"
  '';
  # GARP is broadcast-only best-effort; the reconciler already swallows its failure, so a no-op
  # is a faithful sim (nothing consumes the ARP on the loopback-only sim network anyway).
  arpingShim = pkgs.writeShellScriptBin "arping" "exit 0";
  shim = pkgs.symlinkJoin {
    name = "vrrp-sim-shims";
    paths = [
      ipShim
      arpingShim
    ];
  };
in
{
  options.vrrpSim = {
    enable = lib.mkEnableOption "VRRP VIP failover local e2e (sim ip/arping shim on the bridge PATH + VRRP env)";
    stateDir = lib.mkOption {
      type = lib.types.str;
      default = "${config.env.DEVENV_STATE}/vrrp-sim";
      description = "Directory the ip shim writes per-bridge binding state to (<BRIDGE_HOSTNAME>.json).";
    };
  };

  config = lib.mkIf cfg.enable {
    # attrsOf str → merges onto the static spoke env in modules/spoke.nix. VRRP_SIM_SHIM_DIR is
    # prepended to PATH by the spoke exec (guarded, no-op when unset). The VIP set comes
    # exclusively from hub-published atoms (operator-configured via the UI) — these vars only
    # wire the ip/arping shim, not VRRP behavior.
    stackOverrides.spoke = {
      VRRP_SIM_STATE_DIR = cfg.stateDir;
      VRRP_SIM_SHIM_DIR = "${shim}/bin";
    };

    tasks."vrrp:verify" = {
      description = "VRRP e2e check: assert exactly one bridge (the leader) holds each brokkr-vrrp-labeled VIP in its shim state. Requires a VIP to be configured first (hub UI, after vrrp:seed pre-creates the IPAM rows).";
      exec = ''
        set -euo pipefail
        dir=${lib.escapeShellArg cfg.stateDir}
        shopt -s nullglob
        # Collect every distinct brokkr-vrrp-labeled VIP across all bridge state files, then
        # assert each is held by exactly one bridge. No hardcoded VIP value — works against
        # whatever the operator configured.
        vips=$(${pkgs.jq}/bin/jq -r '[.[] | select(.label == "brokkr-vrrp") | "\(.local)/\(.prefixlen)"] | .[]' "$dir"/*.json 2>/dev/null | sort -u)
        if [ -z "$vips" ]; then
          echo "✗ no brokkr-vrrp-labeled VIP found in any bridge state under $dir — configure one via the hub UI first" >&2
          exit 1
        fi
        status=0
        while IFS= read -r vip; do
          holders=0
          for f in "$dir"/*.json; do
            if ${pkgs.jq}/bin/jq -e --arg vip "$vip" \
              '[.[] | select(.label == "brokkr-vrrp") | "\(.local)/\(.prefixlen)"] | index($vip)' "$f" >/dev/null; then
              echo "  $vip held by $(basename "$f" .json)"
              holders=$((holders + 1))
            fi
          done
          if [ "$holders" -eq 1 ]; then
            echo "✓ $vip: exactly one holder (leader)"
          else
            echo "✗ $vip: expected exactly 1 holder, found $holders" >&2
            status=1
          fi
        done <<< "$vips"
        exit "$status"
      '';
    };

    # On-demand IPAM scaffold (never in the boot DAG): pre-creates the REAL prefix/IP rows an
    # operator would otherwise click together, so VIP testing starts at the "attach it in the UI"
    # step. It does NOT bind anything. Sim-gated in the script itself; the env below points it at
    # the running local DB.
    tasks."vrrp:seed" = {
      description = "Pre-create real IPAM rows for VIP testing (data-plane prefix + one IP per spoke). Creates inventory only — attach the VIP via the hub UI. On-demand; not run by task up.";
      exec = ''
        set -euo pipefail
        ${cdRepo "HUB_REPO_PATH"}
        export DATABASE_URL=${lib.escapeShellArg pgUrl}
        export REDIS_URL=${lib.escapeShellArg P.urls.redis}
        export LOCAL_SIMULATION_ENABLED=true
        export HH_ENV=dev
        exec pnpm --filter api seed:vrrp-vip
      '';
    };
    tasks."vrrp:seed:clear" = {
      description = "Remove the IPAM rows vrrp:seed created (the seeded per-spoke IpAddress rows).";
      exec = ''
        set -euo pipefail
        ${cdRepo "HUB_REPO_PATH"}
        export DATABASE_URL=${lib.escapeShellArg pgUrl}
        export REDIS_URL=${lib.escapeShellArg P.urls.redis}
        export LOCAL_SIMULATION_ENABLED=true
        export HH_ENV=dev
        exec pnpm --filter api seed:vrrp-vip -- --clear
      '';
    };
  };
}
