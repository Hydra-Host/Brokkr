# Brokkr hub (Helm)

The control plane on Kubernetes: Postgres + Redis + the customer/operator app
(`:3000`), in `LOCAL_SIMULATION_ENABLED` mode. Bridges run at each site and
connect back to this release's Redis (see [`../brokkr-bridge/`](../brokkr-bridge/)).
No Vault.

The web UI is not served in this posture (see the `NODE_ENV` note in
[`values.yaml`](./values.yaml)) - interact via the REST API at `:3000/api/v1`
(auth bypass in sim mode).

**WARNING:** sim mode bypasses authentication - never expose `:3000` (or the
Redis bus) to an untrusted network.

## Prerequisites

- Kubernetes 1.25+ and Helm 3.
- A default StorageClass (or set `postgres.persistence.storageClass` /
  `redis.persistence.storageClass`, or disable persistence for a throwaway
  trial).

## Quick start

```sh
helm install brokkr . -n brokkr --create-namespace
kubectl -n brokkr logs -f deploy/brokkr-brokkr-hub
kubectl -n brokkr port-forward svc/brokkr-brokkr-hub 3000:3000
```

Open `http://localhost:3000/api/v1`, sign up, pick "Become a supplier" at
commissioning (unlocks the DC Management surface: Zones / Bridges / Devices),
create a Zone, and use its UUID as `config.BROKKR_ZONE_ID` on each bridge.

Tear down: `helm uninstall brokkr -n brokkr` (PVCs from the bundled
postgres/redis StatefulSets survive - delete them to wipe data).

## How it works

- **One contract.** The keys under `env:` and `secrets:` in `values.yaml` are
  the same knobs as the Compose target's `.env`
  ([`../../docker-compose/hub/.env.example`](../../docker-compose/hub/.env.example)) -
  plain keys render into a ConfigMap; every credential-typed key (auth
  secrets, datastore URLs, integration passwords/tokens/keys) lives under
  `secrets:` and renders into a Secret. Every key stays PRESENT (empty is
  fine); integrations stay empty in sim mode.
- **Bundled datastores.** `postgres.enabled` / `redis.enabled` run the two hard
  dependencies as single-replica StatefulSets and derive `DATABASE_URL` /
  `REDIS_URL` from their Service names. Disable either and set
  `secrets.DATABASE_URL` / `secrets.REDIS_URL` to bring your own.
- **Migrations.** The hub image applies `prisma migrate deploy` in its
  entrypoint on every start (idempotent, serialized by a Postgres advisory
  lock) - that is the `migrate` component here, and it also orders startup:
  the pod only serves after the schema is current. `migrate.enabled=true`
  externalizes it as a pre-install/pre-upgrade hook Job for gated upgrades
  (external database only, and requires `secrets.existingSecret` - the hook
  runs before the release's Secret exists and never inlines credentials).
- **Redis for bridges.** The bus must be reachable by every bridge.
  Same-cluster bridges use the ClusterIP Service; for remote sites set
  `redis.service.type` to `LoadBalancer`/`NodePort` and lock the link down
  (private network + `rediss://` + a password), or run an external Redis.
- **Secrets.** Set `secrets.existingSecret` to source the secret-typed keys
  from a Secret you manage (the chart then renders none). It must carry every
  key listed under `secrets:` in `values.yaml` - the app requires each key to
  be present, even if empty. Note that plain `--set secrets.X=...` overrides
  land in your shell history and in Helm's release Secret; prefer
  `--set-file`, or `existingSecret` with an external secret manager.

## Caveats

- **Not for production as-is.** The default Postgres credentials and the
  throwaway `BETTER_AUTH_SECRET` / `DEVICE_TOKEN_PEPPER` placeholders are
  dev-only; sim mode itself is a trial posture.
- Provisioning is gated by app integrations: reaching `provisioned` device
  status needs the Vault-backed phone-home, and zone<->bridge UI linkage reads
  NetBox. Both are being removed/pluginized upstream; in sim mode you exercise
  the API, zones, and the bridge bus.
