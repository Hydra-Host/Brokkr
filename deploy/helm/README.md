# Brokkr via Helm

Two charts that mirror the real topology - install them where they belong:

| Chart             | Folder                               | Runs on                                   | What it is                                                             |
| ----------------- | ------------------------------------ | ----------------------------------------- | ---------------------------------------------------------------------- |
| **brokkr-hub**    | [`brokkr-hub/`](./brokkr-hub/)       | one cluster (cloud / central)             | Control plane: Postgres + Redis + the customer/operator app (`:3000`). |
| **brokkr-bridge** | [`brokkr-bridge/`](./brokkr-bridge/) | each site cluster/node, next to the metal | The "spoke" (`:8000`, host networking). One release per zone.          |

A self-hoster installs `brokkr-hub` into their control-plane cluster and
`brokkr-bridge` onto each site cluster (or single-node k3s box). Each chart is
self-contained with its own values.

## How they connect

The hub never calls a bridge directly. All hub<->bridge traffic is the **shared
Redis bus** (BullMQ), keyed by a Zone UUID:

```
  hub cluster                            site cluster/node
  +------------------------+             +--------------------+
  | postgres               |             |                    |
  | redis  :6379  <--------+-------------+---- brokkr-bridge  |
  | brokkr-hub :3000       |  REDIS_URL  |     (:8000, host   |
  +------------------------+             |      networking)   |
                                         +--------------------+
```

The bridge needs **only** network reachability to the hub's Redis - no Postgres,
no hub HTTP. Set the bridge's `config.REDIS_URL` to the hub's Redis and its
`config.BROKKR_ZONE_ID` to a Zone you created in the hub.

The hub chart's bundled Redis defaults to a ClusterIP Service: bridges in the
**same cluster** reach it at
`redis://<release>-redis.<namespace>.svc.cluster.local:6379`; bridges elsewhere
need it exposed deliberately (`redis.service.type=LoadBalancer` or `NodePort`) -
and for any non-private link, lock it down (private network + `rediss://` + a
password).

## Run it

1. **Hub cluster:**

   ```sh
   helm install brokkr ./brokkr-hub -n brokkr --create-namespace
   ```

   then follow the release notes: reach `:3000`, sign up, become a supplier,
   and create a Zone.

2. **Each site** (`--set-file` keeps the key out of your shell history and
   the process table):

   ```sh
   openssl rand -base64 32 > bridge-at-rest.key && chmod 600 bridge-at-rest.key
   ```

   Same cluster as the hub (ClusterIP Redis, plaintext is fine):

   ```sh
   helm install site1 ./brokkr-bridge -n brokkr --create-namespace \
     --set config.REDIS_URL=redis://<hub-release>-redis.<hub-namespace>.svc.cluster.local:6379 \
     --set config.BROKKR_ZONE_ID=<zone-uuid> \
     --set-file secrets.BRIDGE_AT_REST_KEY=bridge-at-rest.key
   ```

   Remote site reaching an externally exposed hub Redis (TLS + password
   required - see the [bridge README](./brokkr-bridge/README.md)):

   ```sh
   helm install site1 ./brokkr-bridge -n brokkr --create-namespace \
     --set config.REDIS_URL="rediss://:YOURPASSWORD@<hub-redis>:6379" \
     --set config.BROKKR_ZONE_ID=<zone-uuid> \
     --set-file secrets.BRIDGE_AT_REST_KEY=bridge-at-rest.key
   ```

To try both in one cluster, install `brokkr-hub` first, then point the bridge's
`config.REDIS_URL` at the hub release's Redis Service.

See [`brokkr-hub/README.md`](./brokkr-hub/README.md) and
[`brokkr-bridge/README.md`](./brokkr-bridge/README.md) for details, and the
[deployment overview](../README.md) for the component model and configuration
contract.
