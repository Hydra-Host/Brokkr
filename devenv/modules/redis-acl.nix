{ lib, ... }:

# Per-zone Redis ACL management knob for the local sim. When enabled (the
# local-dev default), the hub runs with REDIS_ACL_MANAGEMENT_ENABLED=true
# (hub.nix), the `redis-acl:seed` task (spoke.nix) provisions each seeded
# zone's `brokkr-spoke-<zoneId>` ACL user with a committed NON-SECRET
# deterministic password, and every spoke's REDIS_URL carries that zone's
# scoped credential — so the sim exercises the exact ACL rule self-hosters
# get (`+@all -@admin -@dangerous +keys +info ~<zoneId>:* ~results:*`).
#
# The devenv Redis default user stays open (no requirepass): the hub needs
# ACL-admin access, and locking the default user down is out of scope for the
# sim — the point is verifying the per-zone users exist and are scoped, plus
# that spokes function end-to-end when confined to them.
#
# Disable in devenv.local.nix to return to the pre-ACL sim (spokes on the
# default user, hub flag off):
#   { ... }: { redisAcl.enable = false; }
{
  options.redisAcl = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Enable per-zone Redis ACL management in the local sim: hub flag on,
        seeded zones get ACL users with deterministic sim passwords, spokes
        connect as their zone-scoped user.
      '';
    };
  };

  # Presentation metadata only; modules/overrides.nix derives the widget and the tooltip from the
  # option above.
  config.knobMeta."redisAcl.enable" = {
    label = "Per-zone Redis ACLs";
    group = "Security";
  };
}
