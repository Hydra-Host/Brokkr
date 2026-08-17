# Brokkr hub (control plane)

Runs on one machine. Postgres + Redis + a one-shot `migrate` + the customer /
operator app (`:3000`), in local-simulation mode. Bridges connect back to this
machine's Redis from each site - see [`../bridge/`](../bridge/).

## Prerequisites

- Docker + the Compose v2 plugin.
- A checkout of this repo (the `migrate` step bind-mounts `packages/database/prisma`
  and `prisma.config.ts`).

## Quick start

```sh
cp .env.example .env          # adjust if needed
docker compose up -d
docker compose logs -f brokkr-hub   # watch migrations + healthcheck
```

Open <http://localhost:3000> and **sign up** to create your account (no email
verification in sim mode). To manage bare metal, pick **"Become a supplier"** at
commissioning - that unlocks the DC Management UI (Zones / Bridges / Devices). Create
a Zone, then use its UUID as `BROKKR_ZONE_ID` on each bridge.

Tear down (keep data): `docker compose down`. Wipe data too: `docker compose down -v`.

## How it works

- **Env**: every var lives in `.env` (copied from `.env.example`). Integrations
  are empty - `getOrThrow()` only fails on an _undefined_ key, and
  `LOCAL_SIMULATION_ENABLED=true` disables their use. Two values are non-empty on
  purpose (`CLICKHOUSE_HOST`, `OPENMETER_WEBHOOK_SECRET`).
- **Ordering**: `postgres`/`redis` healthy -> `migrate` runs once -> the app
  starts (health-gated on `/healthcheck`).
- **No Vault**: the app reads `VAULT_ADDR` at construction but never contacts it
  during boot, login, or browsing.
- **Redis is published on `:6379`** so remote bridges can reach the bus. For any
  non-private network, bind it to a private interface and/or use `rediss://` + a
  password.
- **Migrations**: `migrate` runs `prisma migrate deploy` via the hoisted
  `/app/node_modules/.bin/prisma`; the migrations dir + `prisma.config.ts` are
  bind-mounted from the repo (the published image omits them).

## Caveats

- **Not for production as-is.** Hardcoded Postgres credentials and a throwaway
  `BETTER_AUTH_SECRET` are dev-only.
- **Provisioning is gated by app integrations.** Reaching `provisioned` device
  status needs the app's Vault-backed phone-home; zone<->bridge UI linkage reads
  NetBox. Both are being removed/pluginized upstream - until then those paths are
  limited. The hub-and-spoke wiring itself works without them.
