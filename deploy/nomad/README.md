# Brokkr via Nomad

Two portable jobspecs that mirror the real topology - run them where they
belong. They assume nothing about your cluster beyond the prerequisites below:
infra values come from `-var`/`*.nomadvars`, and the env contract comes from a
Nomad Variable per job (encrypted at rest, scoped by workload identity).

| Unit       | Folder                 | Runs on                          | What it is                                                               |
| ---------- | ---------------------- | -------------------------------- | ------------------------------------------------------------------------ |
| **Hub**    | [`hub/`](./hub/)       | one cluster (cloud / central)    | Control plane: Postgres + Redis sidecars + the app (`:3000`), one alloc. |
| **Bridge** | [`bridge/`](./bridge/) | the site node, next to the metal | The "spoke" (`:8000`, host networking). One job per zone.                |

## How they connect

The hub never calls a bridge directly. All hub<->bridge traffic is the **shared
Redis bus** (BullMQ), keyed by a Zone UUID. The hub job publishes Redis on the
hub node at `redis_port` (default `6379`); set the bridge's `REDIS_URL` to that
address and its `BROKKR_ZONE_ID` to a Zone you created in the hub. For any
non-private link, lock the bus down: private network + `rediss://` + a password
(or `bundled_datastores = false` with your own secured Redis).

The hub alloc is the compose "hub machine": Postgres and Redis run as prestart
sidecar tasks on `127.0.0.1`, a wait task gates the hub on their readiness, and
the hub image applies `prisma migrate deploy` on start (idempotent,
advisory-locked) - that is the `migrate` component here.
[`hub/brokkr-migrate.nomad.hcl`](./hub/brokkr-migrate.nomad.hcl) externalizes it
as an optional batch job for gated upgrades against an external database
(pair it with `RUN_DB_MIGRATIONS=false` in the hub's Variable).

## Prerequisites

- Nomad 1.7+ with the Docker driver, Nomad Variables, and workload identity.
- Hub node: CNI plugins for `bridge` network mode.
- Bridge node: the client's docker plugin `allow_caps` must include `net_admin`
  (VRRP binds the floating IP via `ip addr add`) alongside the defaults.
- The bundled datastores keep data on a sticky ephemeral disk - best-effort
  persistence, fine for a trial. Use `bundled_datastores = false` + your own
  Postgres/Redis for real data.

## Run it

1. **Hub cluster** - populate the env contract, then run the job:

   ```sh
   cd hub
   grep -vE '^\s*(#|$)' hub.env.example | xargs nomad var put -force nomad/jobs/brokkr-hub
   nomad job run -var-file=brokkr-hub.nomadvars brokkr-hub.nomad.hcl
   ```

   Reach the API at `http://<hub-node>:3000/api/v1` (the web UI is not served
   in the sim posture), sign up, become a supplier, and create a Zone - its
   UUID is each bridge's `BROKKR_ZONE_ID`.

2. **Each site** - fill in `bridge.env.example` (`REDIS_URL` to the hub node,
   the Zone UUID, and a fresh `BRIDGE_AT_REST_KEY` from
   `openssl rand -base64 32`), then:

   ```sh
   cd bridge
   grep -vE '^\s*(#|$)' bridge.env.example | xargs nomad var put -force nomad/jobs/brokkr-bridge
   nomad job run -var-file=brokkr-bridge.nomadvars brokkr-bridge.nomad.hcl
   ```

**WARNING:** sim/trial posture - `LOCAL_SIMULATION_ENABLED` bypasses
authentication; never expose the hub or the Redis bus to an untrusted network.
See the [deployment overview](../README.md) for the component model and
configuration contract.
