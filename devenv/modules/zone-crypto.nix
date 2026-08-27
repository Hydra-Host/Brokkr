{ lib, ... }:

# Zone-crypto (S1 auth-DH enrollment) knobs for the local sim. Unlike prod, local dev is keyed
# BY DEFAULT: the hub key below ships a committed NON-SECRET local-dev constant so a fresh,
# OFFLINE `task up` keys the hub, the sim self-enrolls its bridge(s), and the seed-bmc task can
# seal the admin/admin loopback BMC creds into the DB (device-context is fail-closed post-cutover,
# so without a keyed hub + enrollment, BMC/power/SOL ops have no creds to dispatch). Empty leaves
# it DORMANT (hub /enroll returns 503; every bridge stays in the pre-S1 plaintext path with no
# BROKKR_HUB_URL), matching prod where this module is never imported and BROKKR_HUB_PRIVATE_KEY is
# unset.
#
# OVERRIDING: the keys are plain option defaults, so devenv.local.nix (gitignored, auto-imported)
# can set `zoneCrypto.hubPrivateKey = "";` to go back to the dormant/plaintext path, or set a
# different key. Registration tokens are normally minted automatically per zone by the sim DAG
# (devenv.nix mint-sim-registration-token → spoke.nix BROKKR_REGISTRATION_TOKEN); set
# zoneCrypto.tokens.<zone> by hand only to pin a specific token. Full flow:
# docs/zone-crypto-dev-rollout.md in the hub repo.
#
# Example devenv.local.nix (go dormant, or pin a hand-minted token):
#   { ... }: {
#     zoneCrypto.hubPrivateKey = "";
#     zoneCrypto.tokens."sim-zone2" = "<one-time registration token minted in admin-web>";
#   }
{
  options.zoneCrypto = {
    hubPrivateKey = lib.mkOption {
      type = lib.types.str;
      # NON-SECRET local-dev constant — a throwaway X25519 private key generated ONCE via
      # `pnpm --filter api key:generate-hub`. Its ONLY job is to let a fresh offline `task up` key
      # the hub so the sim self-enrolls and the admin/admin loopback BMC creds seal into the DB; it
      # protects nothing of value (admin/admin against ipmi_sim/sushy on host loopback). Committed
      # deliberately. Inert outside local dev: prod/stg/dev deployments never import this devenv
      # module, so their hub's BROKKR_HUB_PRIVATE_KEY stays unset (dormant). A devenv.local.nix config
      # assignment overrides this default to "" (dormant) or another key. Its derived hub_pub is
      # 306d628de48ea331b993774cd9cd40f64915b750c657b93ae503cb2a7d6a8c7f — cross-check it against the
      # hub boot log ("Hub crypto loaded; hub_pub=<hex>") to confirm the committed key loaded.
      default = "CLgn641z7sEoBORwcShY+RdjAUnrluM/y+dzOa3oEko=";
      description = ''
        Hub private key (base64) → the hub's BROKKR_HUB_PRIVATE_KEY, and the master switch for the
        whole subsystem. Defaults to a committed NON-SECRET local-dev key so a fresh
        offline `task up` keys the hub and the sim self-enrolls. Set to "" to go dormant (hub /enroll
        returns 503; every bridge stays in the pre-S1 plaintext path with no BROKKR_HUB_URL). One key
        serves all zones. Regenerate with `pnpm --filter api key:generate-hub` in the hub repo (copy
        the base64 stdout line) only if you rotate the local-dev key.
      '';
    };
    bridgeAtRestKey = lib.mkOption {
      type = lib.types.str;
      # NON-SECRET local-dev constant — a throwaway 32-byte AES-256-GCM key generated ONCE via
      # `openssl rand -base64 32`. The bridge fails closed without BRIDGE_AT_REST_KEY in EVERY env
      # (it AES-encrypts BMC creds / server tokens / password hashes at rest in Redis); this default
      # supplies it for local dev so a fresh offline `task up` boots. It protects nothing of value
      # (admin/admin against ipmi_sim/sushy on host loopback in throwaway local sim data). Committed
      # deliberately. Inert outside local dev: prod/stg/dev deployments never import this devenv
      # module — there an EXTERNAL setter (out of repo) provides BRIDGE_AT_REST_KEY.
      #
      # STABILITY IS LOAD-BEARING — this MUST be the same value on every `task up`/restart, NEVER
      # regenerated per-run. A changing key means the bridge can't decrypt its cached zone_crypto
      # snapshot → it re-enrolls → ZoneEnrollment.generation bumps → every seeded DeviceSecret
      # orphans (all sim machines' BMC creds invalidated). A stable key lets restarts reuse the
      # zone_crypto cache and keeps DeviceSecrets valid; only a datastore reset starts fresh (and the
      # stable key cleanly re-encrypts the fresh data). Hence a committed static constant — never a
      # generate-per-run value or gitignored state. A devenv.local.nix config assignment overrides it.
      default = "I1GOxiD9hSt9QvHUdylUSXKW/WHM6PF2dUCovWeSTXg=";
      description = ''
        Bridge at-rest encryption key (32-byte base64) → the bridge's BRIDGE_AT_REST_KEY. The bridge
        refuses to start without it in every environment. Defaults to a committed
        NON-SECRET local-dev constant so a fresh offline `task up` boots. MUST stay stable across
        restarts — a changing key orphans every seeded DeviceSecret (re-enroll bumps
        ZoneEnrollment.generation). Regenerate with `openssl rand -base64 32` only to rotate the
        local-dev key (which requires a datastore reset). Prod/stg/dev set this externally, out of repo.
      '';
    };
    tokens = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        "sim-zone2" = "rt_…";
      };
      description = ''
        Per-zone one-time registration tokens, keyed by Hub Zone.name (e.g. "sim-zone1"). Each
        becomes that zone's bridges' BROKKR_REGISTRATION_TOKEN — the leader consults it to enroll;
        followers ignore it and load the result from zone Redis. Single-use, 24h TTL, zone-bound;
        mint in the admin web app. Only applied when zoneCrypto.hubPrivateKey is set. After setting
        one, restart just that zone's bridge(s) (cockpit, or `process-compose process restart spoke-<zone>`).
      '';
    };
  };

  # Metadata only: the options are declared above, and registering them here is what puts them in
  # the catalog — which is also what makes the env-pin refusal see them as read-only secrets.
  config.knobMeta = {
    "zoneCrypto.hubPrivateKey" = {
      label = "Hub private key";
      group = "Security";
      secret = true;
      danger = true;
      editable = false;
    };
    "zoneCrypto.bridgeAtRestKey" = {
      label = "Bridge at-rest key";
      group = "Security";
      secret = true;
      danger = true;
      editable = false;
    };
  };
}
