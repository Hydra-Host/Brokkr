_:

# devenv profiles. `local` is the implicit default (no profile) and the only supported posture:
# the hermetic local loop with no Vault. The former dev/stg real-infra postures (a developer's
# LOCAL hub pointed at the SHARED dev/stg Postgres+Redis) have been removed — they caused
# read/write contention on shared datastores and risked seeding an auth-bypass Owner into the
# remote DB. The deploy pipeline (nomad/terraform/backup) still talks to real infra via its own
# ops tasks and remote Vault; that path is unchanged.
#
# NOTE: the `remoteInfra.enable` / `fleet.autoStart` options (modules/overrides.nix) are still
# consumed by hub.nix / spoke.nix / fleet.nix / devenv.nix, but nothing flips remoteInfra true
# anymore — it stays at its always-false default, so only the hermetic local stack ever runs.
{
  # --- Per-developer / per-machine overrides (additive — not the local critical path) ----
  #
  # devenv auto-activates profiles.user.<name> by $USER and profiles.hostname.<host> by
  # hostname, so these replace the ad-hoc .env / devenv.local.nix edits people keep for their
  # own checkout path or port nudges. Set the same options the local stack already exposes
  # (config.polyrepo.hub.path, config.ports.*). Uncomment + rename to your username / hostname:
  #
  # profiles.user.<your-username>.module = {
  #   config.polyrepo.hub.path = "~/hydra-repos/brokkr-app";
  #   config.ports.hubApi.base = 3100;   # nudge ports if 3000/5173 collide on your box
  # };
  #
  # profiles.hostname.<your-hostname>.module = {
  #   config.polyrepo.hub.path = "/data/checkouts/brokkr-app";
  # };

  # HA / CI scenario profiles (placeholder). Future multi-instance (stackCounts.hub > 1)
  # or CI-runner postures land here as named `profiles.<name>.module` blocks.
}
