# Brokkr bridge (spoke)

Runs on each site machine, next to the bare metal. It connects back to the hub's
Redis bus and registers under this site's zone. Self-contained: just this folder
and an `.env` - no repo checkout, no Postgres, no hub HTTP.

## Prerequisites

- Docker + the Compose v2 plugin, on a machine that can reach the hub's Redis.
- A Zone created in the hub (sign up as a supplier -> DC Management -> Zones); use
  its UUID as `BROKKR_ZONE_ID`.

## Quick start

```sh
cp .env.example .env
# edit .env:
#   REDIS_URL           -> the hub machine's Redis (e.g. redis://10.0.0.5:6379)
#   BROKKR_ZONE_ID      -> the Zone UUID from the hub
#   BRIDGE_AT_REST_KEY  -> openssl rand -base64 32   (bridge refuses to start on the placeholder)
docker compose up -d
docker compose logs -f brokkr-bridge   # watch it connect + register
```

Confirm it registered on the hub's bus (run on the hub machine):

```sh
docker compose exec redis redis-cli KEYS '*:bridge:instance:*'
```

## How it works

- Connects to `REDIS_URL`, elects a leader, and writes presence to
  `{BROKKR_ZONE_ID}:bridge:instance:*` - which the hub's heartbeat monitor scans.
- The hub enqueues saga jobs to `{BROKKR_ZONE_ID}:lifecycle`; the bridge executes
  them and writes results to the shared `results:inbox`.
- Crypto enrollment is dormant (no `BROKKR_HUB_URL`), so no admin-minted token is
  needed - the bus runs in plaintext.

## Caveats

- **Secure the link.** `REDIS_URL` crosses machines. Keep bridges on a private
  network to the hub, or use `rediss://` + a password. (Sealed-envelope bridge
  crypto is on the roadmap.)
- **Runs with host networking.** The bridge uses `network_mode: host` + `CAP_NET_ADMIN`
  so it can drive real hardware directly on the site's L2: PXE/DHCP/TFTP and the VRRP
  floating IP (`ip addr add`) land on the host's real NICs, not an isolated container
  netns. It therefore shares the host's network stack (no `ports:` mapping; `:8000` is
  published on the host directly).
- **Real provisioning still needs data.** Set `BRIDGE_SYNC_ENABLED=true` to pull
  discovery images (adds the asset-CDN dependency). DHCP is configured entirely from the
  hub via atoms (no bridge-side env vars); configure DHCP subnets in the hub UI.
