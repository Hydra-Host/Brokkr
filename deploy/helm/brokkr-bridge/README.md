# Brokkr bridge (Helm)

The "spoke" on Kubernetes. One release per zone, on the site cluster/node next
to the bare metal. Connects back to the hub's Redis bus and registers under
this site's zone (`config.BROKKR_ZONE_ID`). It needs ONLY network reachability
to the hub's Redis - no Postgres, no hub HTTP. Crypto enrollment is dormant and
Vault is unused in sim mode.

## Prerequisites

- Kubernetes 1.25+ (a single-node k3s on the site box is the typical shape)
  and Helm 3, on a node that can reach the hub's Redis.
- A Zone created in the hub (sign up as a supplier -> DC Management -> Zones);
  use its UUID as `config.BROKKR_ZONE_ID`.

## Quick start

Generate the at-rest key into a file and pass it with `--set-file` - a plain
`--set` would land the key in your shell history, the process table, and be
easy to leak. Note that Helm stores chart values in its release Secret either
way; use `secrets.existingSecret` to keep the key out of Helm state entirely.

```sh
openssl rand -base64 32 > bridge-at-rest.key
chmod 600 bridge-at-rest.key
```

Same cluster as the hub (ClusterIP Redis, plaintext is fine):

```sh
helm install site1 . -n brokkr --create-namespace \
  --set config.REDIS_URL=redis://<hub-release>-redis.<hub-namespace>.svc.cluster.local:6379 \
  --set config.BROKKR_ZONE_ID=<zone-uuid> \
  --set-file secrets.BRIDGE_AT_REST_KEY=bridge-at-rest.key
```

Remote site reaching an externally exposed hub Redis (TLS + password required):

```sh
helm install site1 . -n brokkr --create-namespace \
  --set config.REDIS_URL="rediss://:YOURPASSWORD@<hub-redis>:6379" \
  --set config.BROKKR_ZONE_ID=<zone-uuid> \
  --set-file secrets.BRIDGE_AT_REST_KEY=bridge-at-rest.key
```

Then delete the key file (it lives in the release Secret now - keep a copy in
your secret manager; losing it orphans stored device secrets):

```sh
shred -u bridge-at-rest.key || rm -P bridge-at-rest.key
kubectl -n brokkr logs -f deploy/site1-brokkr-bridge
```

Confirm registration against the hub's Redis:

```sh
redis-cli -u <hub REDIS_URL> --scan --pattern '<zone-uuid>:bridge:instance:*'
```

## How it works

- **One contract.** The keys under `config:`, `secrets:` and `env:` in
  `values.yaml` are the same knobs as the Compose target's `.env`
  ([`../../docker-compose/bridge/.env.example`](../../docker-compose/bridge/.env.example)).
  The chart renders the same stack defaults as the Compose service
  (`LOCAL_SIMULATION_ENABLED`, `GRPC_INSECURE`, orchestrator on, HA off, ...) -
  override any of them under `env:`.
- Connects to `config.REDIS_URL`, elects a leader, and writes presence to
  `{BROKKR_ZONE_ID}:bridge:instance:*` - which the hub's heartbeat monitor
  scans. The hub enqueues saga jobs to `{BROKKR_ZONE_ID}:lifecycle`; the bridge
  executes them and reports into the shared `results:inbox`.
- **Host networking** (`hostNetwork: true` + `CAP_NET_ADMIN`): the bridge
  drives real hardware - PXE/DHCP/TFTP and the VRRP floating IP land on the
  node's real NICs, not an isolated pod netns. `:8000` binds on the node
  directly; the Deployment uses the `Recreate` strategy so a replacement pod
  never collides on the port. Pin the pod to the metal-facing node with
  `nodeSelector`.
- **DHCP/DNS/VRRP** are configured entirely from the hub via config atoms -
  there are no bridge-side knobs for them. Configure subnets, DNS, VIPs, and
  runtime tuning in the hub UI.

## Caveats

- **Secure the link:** `config.REDIS_URL` crosses networks. Keep bridges on a
  private network to the hub, or use `rediss://` + a password.
- **`BRIDGE_AT_REST_KEY` must be your own freshly generated key** (`openssl
rand -base64 32`) - the bridge fails closed on the placeholder, and rotating
  it orphans stored device secrets.
- **Real provisioning still needs data:** set `config.BRIDGE_SYNC_ENABLED`
  `"true"` plus `DISCOVERY_BASE_URL` / `OS_LAYER_URL` / `BROKKR_LIVE_VERSION`
  under `env:` to pull discovery images (adds an asset-CDN dependency).
- `BRIDGE_URL` must be reachable FROM the devices - typically the node's
  device-facing address (e.g. `http://192.168.200.1:8000`), not a cluster
  address.
