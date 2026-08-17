# Brokkr — Self-Hosting Getting Started

A practical guide to standing up Brokkr on your own infrastructure with Docker Compose.

> Conventions: replace anything in `<ANGLE_BRACKETS>` with your own values. Commands assume
> Docker Engine + Docker Compose v2 (`docker compose ...`).

---

## What you're deploying

Brokkr is split into two components:

- **Hub** — the central control plane: REST API + web UI, backed by **Postgres** and **Redis**.
  You run **one** hub per deployment. Users and operators interact with the hub.
- **Spoke (bridge)** — a per-site/per-zone worker that talks to your machines' **BMCs**
  (IPMI/Redfish) and their **provisioning network**, and pulls jobs from the hub over Redis.
  You run **one spoke per zone** (a site/location/network the hub manages).

```
        users ── https ──► [ Hub: brokkr-hub + Postgres + Redis ]
                                      ▲ (Redis job queue, per-zone)
                                      │
        [ Spoke A (zone A) ]   [ Spoke B (zone B) ]  ...
              │  IPMI/Redfish + provisioning net
              ▼
        bare-metal machines / BMCs
```

---

## Prerequisites

- **Hub host**: Linux with Docker + Compose v2. ~4 vCPU / 8 GB RAM / 50 GB disk to start.
- **Spoke host(s)**: Linux with Docker + Compose v2, attached to the management network that can
  reach your machines' BMCs **and** the provisioning network the machines boot on. One per zone.
- **DNS + TLS** for the hub: a hostname (e.g. `brokkr.example.com`) and a certificate
  (Let's Encrypt or your own). The hub should sit behind an HTTPS reverse proxy.
- **A way to reach the hub's Redis from each spoke** (over your private network or VPN). Do **not**
  expose Redis to the public internet.

---

## 1. Deploy the Hub

Create a working dir (e.g. `/opt/brokkr`) with `docker-compose.yml`:

```yaml
name: brokkr-hub
services:
  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${PG_USER}
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: ${PG_DB}
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U ${PG_USER} -d ${PG_DB}']
      interval: 5s
      timeout: 5s
      retries: 30

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--appendonly', 'yes']
    ports: ['6379:6379'] # reachable by your spokes over the private network
    volumes: [redisdata:/data]
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 3s
      retries: 30

  brokkr-hub:
    image: hydrahost/brokkr-hub:<TAG>
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    ports: ['3000:3000']
    environment:
      NODE_ENV: production
      HUB_PORT: '3000'
      HOST: 0.0.0.0
      DATABASE_URL: postgresql://${PG_USER}:${PG_PASSWORD}@postgres:5432/${PG_DB}
      REDIS_URL: redis://redis:6379
      BASE_URL: https://<HUB_FQDN> # public URL users hit (auth/CORS)
      PHONE_HOME_BASE_URL: <HUB_URL_REACHABLE_BY_MACHINES> # where provisioned machines call back
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET}
      DEVICE_TOKEN_PEPPER: ${DEVICE_TOKEN_PEPPER}

volumes:
  pgdata:
  redisdata:
```

Create the `.env` next to it. **Generate strong secrets** — never ship the defaults. This block is
**idempotent**: it only fills a value that isn't already set, so re-running it never rotates an
existing secret.

```bash
touch .env && chmod 600 .env
setdefault() { grep -q "^$1=" .env || echo "$1=$2" >> .env; }   # set only if absent
setdefault PG_USER             brokkr
setdefault PG_DB               brokkr
setdefault PG_PASSWORD         "$(openssl rand -hex 16)"
setdefault BETTER_AUTH_SECRET  "$(openssl rand -hex 32)"      # 256-bit
setdefault DEVICE_TOKEN_PEPPER "$(openssl rand -hex 32)"      # 256-bit
setdefault BROKKR_HUB_PRIVATE_KEY "$(openssl rand -base64 32)"  # X25519 (base64, 32 bytes)
```

> **`BROKKR_HUB_PRIVATE_KEY` is required, not optional.** It's the hub's X25519 private key used
> for **zone enrollment** and **device-secret encryption**. If it's unset, the hub logs "crypto
> dormant" and `POST /api/v1/zones/<id>/enroll` returns **503** — so **no bridge can ever enroll**.
> Confirm it loaded via the boot log: `Hub crypto loaded; hub_pub=<hex>`. Any random 32 bytes is a
> valid X25519 scalar, so `openssl rand -base64 32` is fine (or run `apps/api/.../generate-hub-key.ts`).

> **HA / multiple hub nodes:** `BETTER_AUTH_SECRET`, `DEVICE_TOKEN_PEPPER`, **and
> `BROKKR_HUB_PRIVATE_KEY`** **must be identical on every hub node.** Generate them once and copy the
> _same_ values to each node's `.env` — if they differ, sessions/device tokens/zone-enrollment crypto
> minted by one node fail on the others. (Generate once, distribute; don't run the generator per node.)
>
> **Rotation:** changing `DEVICE_TOKEN_PEPPER` invalidates every issued device token (machines must
> re-enroll); changing `BETTER_AUTH_SECRET` invalidates all user sessions. Back these up somewhere safe.

`BASE_URL` vs `PHONE_HOME_BASE_URL`: `BASE_URL` is the **public** name users/browsers use (behind
TLS). `PHONE_HOME_BASE_URL` is the address **provisioned machines** use to call home — keep it on
an address those machines can actually reach (often an internal one). They are frequently different;
don't collapse them.

Bring it up (database migrations run on first start):

```bash
docker compose pull
docker compose up -d
docker compose logs -f brokkr-hub
```

### First admin login (operator bootstrap)

On **every** boot the hub idempotently ensures an **instance-operator org** and an initial **admin
Owner** exist — so a brand-new deployment has someone who can log in and gate the staff-only
surfaces (device secrets, lifecycle approvals, zone registration tokens). With zero config you get:

| Env var                 | Default                                | Sets                                    |
| ----------------------- | -------------------------------------- | --------------------------------------- |
| `BROKKR_ADMIN_ORG_ID`   | `00000000-0000-0000-0000-000000000000` | UUID of the operator org                |
| `BROKKR_ADMIN_ORG_NAME` | `Brokkr`                               | Display name of the operator org        |
| `BROKKR_ADMIN_EMAIL`    | `admin@brokkr.local`                   | Login email for the initial admin Owner |
| `BROKKR_ADMIN_PASSWORD` | `brokkr`                               | Initial admin password                  |

All four are **optional** — set them on the `brokkr-hub` service (e.g. via `.env`) to control the
first admin. So **log in at `https://<HUB_FQDN>` with `admin@brokkr.local` / `brokkr`** if you left
the defaults.

> **⚠️ Change the default credential immediately on any reachable deployment** — `admin@brokkr.local`
> / `brokkr` is well-known. Two ways:
>
> - **Before first boot:** set `BROKKR_ADMIN_PASSWORD` (and `BROKKR_ADMIN_EMAIL`) on the hub.
> - **After first login:** rotate the password in the app.
>
> **Important — the password is written only on _first_ credential creation, never on later boots.**
> So changing `BROKKR_ADMIN_PASSWORD` _after_ the admin already exists does **nothing** (it won't
> reset a forgotten password) — rotate in-app instead. The bootstrap is otherwise fully idempotent:
> it upserts the org/owner each boot, and if you change `BROKKR_ADMIN_ORG_ID` it demotes the prior
> operator org. (Changing `BROKKR_ADMIN_EMAIL` creates a _new_ admin user rather than renaming the old.)

---

## 2. Put the Hub behind HTTPS

Run a reverse proxy (nginx, Caddy, Traefik…) terminating TLS for `<HUB_FQDN>` and proxying to the
hub on `:3000`. Minimal nginx location:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;       # websockets/SSE
    proxy_set_header Connection "upgrade";
}
```

Point your DNS A-record at the proxy and issue a cert (e.g. `certbot --nginx` / Caddy auto-TLS).
Set the hub's `BASE_URL` to `https://<HUB_FQDN>`.

---

## 3. Create a Zone (gets you the spoke's credentials)

In the hub web UI, create a **Zone** for each site/network you'll manage. Then open the zone's
**overview page** and click **Mint registration token**. You need two values for the spoke:

- the **Zone ID** (UUID, shown on the zone page) — the spoke sets it as `BROKKR_ZONE_ID`, which is
  also its Redis job-queue prefix (it must match the prefix the hub enqueues under); and
- the **registration token** (from "Mint registration token") — the spoke authenticates with it.

Keep both for the next step. (The token is a secret — store it like a password.)

> If you enabled **per-zone Redis ACLs** (see "Per-zone Redis ACLs" below), creating the zone also
> pops a **one-time Redis credential** (`brokkr-spoke-<zoneId>` + password). Copy it now — like the
> registration token, it's shown exactly once — and use it in the spoke's `REDIS_URL` in step 4.

**Registration-token lifecycle (don't get caught out):**

- The raw token is shown **exactly once** at mint — copy it immediately; it's unrecoverable afterward.
- It's **single-use** (consumed when a spoke enrolls) and **expires after 24h** if unused.
- A zone has **only one live token at a time** — minting again (or hitting "invalidate") supersedes
  the previous one, which then shows as `expired`/invalidated. So **mint right before deploying the
  spoke** and use it promptly; don't mint early and let it sit (or re-mint and forget which is live).
- Token status on the zone page reads `unused` → `consumed` (a bridge enrolled) or `expired`/invalidated.

---

## 4. Deploy a Spoke (one per zone)

On the spoke host (on the machines' management/provisioning network), `docker-compose.yml`:

```yaml
name: brokkr-spoke
services:
  brokkr-bridge:
    image: hydrahost/brokkr-bridge:<TAG>
    restart: unless-stopped
    network_mode: host # needs direct reach to BMCs + the provisioning network
    environment:
      HOST: 0.0.0.0
      PORT: '8080'
      REDIS_URL: ${REDIS_URL} # the HUB's Redis, e.g. redis://<HUB_HOST>:6379
      BROKKR_ZONE_ID: ${ZONE_ID} # the zone UUID; also the Redis/BullMQ queue prefix
      BROKKR_HUB_URL: ${HUB_URL} # e.g. https://<HUB_FQDN> (or internal hub URL)
      BROKKR_REGISTRATION_TOKEN: ${REG_TOKEN}
      BRIDGE_AT_REST_KEY: ${BRIDGE_AT_REST_KEY} # encrypts BMC creds etc. cached in Redis
      BRIDGE_HOSTNAME: ${BRIDGE_HOSTNAME} # unique per spoke
      BRIDGE_URL: http://<THIS_SPOKE_IP>:8080
      SSH_KEY_PATH: /opt/brokkr/keys/id_ed25519
      BRIDGE_SSH_PRIVKEY_PATH: /opt/brokkr/keys/id_ed25519
    volumes:
      - bridge-state:/opt/brokkr/state
      - ./keys:/opt/brokkr/keys:ro # SSH keypair baked into discovery images
volumes:
  bridge-state:
```

The two volumes matter: `bridge-state` persists the bridge's local working state
across restarts, and `./keys` mounts an SSH keypair **read-only** that the bridge
bakes into the discovery/provisioning images so it can reach the machines it boots
(`SSH_KEY_PATH` / `BRIDGE_SSH_PRIVKEY_PATH` point at it).

Now generate that keypair, write the matching `.env` (using the **Zone ID** and
**registration token** from step 3), and bring the spoke up:

```bash
mkdir -p keys && ssh-keygen -t ed25519 -N '' -f keys/id_ed25519
cat > .env <<EOF
REDIS_URL=redis://<HUB_HOST>:6379
ZONE_ID=<ZONE_UUID>
HUB_URL=https://<HUB_FQDN>
REG_TOKEN=<REGISTRATION_TOKEN>
BRIDGE_HOSTNAME=spoke-1
BRIDGE_AT_REST_KEY=$(openssl rand -base64 32)
EOF
docker compose up -d
docker compose logs -f brokkr-bridge
```

> **`BRIDGE_AT_REST_KEY`** encrypts sensitive data the bridge caches in the hub's Redis (BMC
> credentials, etc.). Generate it with `openssl rand -base64 32`. **It MUST be identical on every
> bridge in the same zone** — bridges share that Redis cache, so a different key means one bridge
> can't decrypt what another wrote. Generate it **once** and copy the same value to each bridge's
> `.env`; do **not** regenerate per bridge.

The spoke should register with the hub and show up under its zone.

**Multiple bridges:**

- **Same zone (HA):** share `ZONE_ID` and `BRIDGE_AT_REST_KEY`; each bridge gets a **unique
  `BRIDGE_HOSTNAME`** and its **own single-use `REG_TOKEN`** (mint one per bridge).
- **Different zone:** its own `ZONE_ID`, token, and at-rest key.

> Networking: the spoke reaches BMCs over IPMI (UDP 623) / Redfish (HTTPS) and serves boot to a
> provisioning network. Isolate the BMC/OOB network from your general LAN.

### Per-zone Redis ACLs (optional hardening)

By default every spoke connects to the hub's Redis as the **default user with full access** —
key-prefix isolation between zones is by convention only. If you run your own Redis (this guide's
setup), you can have the hub manage a **scoped ACL user per zone** instead. Set on the hub:

```
REDIS_ACL_MANAGEMENT_ENABLED=true
```

What it does (default **off**; leave it off if something else owns your Redis ACLs):

- **Zone create** provisions a Redis ACL user `brokkr-spoke-<zoneId>` restricted to that zone's key
  namespace plus the shared results inbox (`~<zoneId>:* ~results:*`, all commands except
  `@admin`/`@dangerous`, with `KEYS`/`INFO` re-granted) — and shows the password **exactly once** in
  the create response. The hub stores only its SHA-256 hash.
- Put the credential in that spoke's connection string:
  `REDIS_URL=redis://brokkr-spoke-<zoneId>:<password>@<HUB_HOST>:6379`. HA bridges in the same zone
  share the one zone user.
- **Zone delete** revokes the user immediately (and fails the delete if revocation fails — a
  deprovisioned zone must not retain Redis access).
- **Rotate** from the zone overview page (or `POST /zones/:zoneId/redis-credential/rotate`) when a
  password is lost or was never captured. Bridges on the old password lose access instantly, and the
  hub does **not** push the new credential to the spoke — rotation is a coordinated, operator-driven
  action. Runbook:
  1. Rotate on the hub and copy the new `REDIS_URL` from the show-once dialog.
  2. Update that zone's bridge `.env` `REDIS_URL` (all HA bridges in the zone share the one user) —
     paste the value verbatim; the password is intentionally un-encoded and the bridge encodes it
     for you.
  3. Recreate the bridge container(s) so the new env takes effect (`docker compose up -d` /
     `docker compose restart brokkr-bridge`).

  Until step 3 completes, the zone's bridges fail Redis AUTH — schedule rotation during a maintenance
  window, or roll bridges one at a time so the zone keeps a leader.

- On **startup** the hub reconciles: re-applies users from stored hashes (survives Redis
  restarts/flushes), creates **locked** users for zones that predate the flag (rotate to get a
  usable password), and removes users for deleted zones.

Requirements & caveats:

- The **hub's own `REDIS_URL` user needs ACL admin rights** (the default user on a stock Redis has
  them). The hub keeps using its full-access connection; only spokes get scoped users.
- The zone users only confine clients that use them — also set a password on (or otherwise lock
  down) the **default user** in your `redis.conf` so spokes can't just connect unauthenticated.
- With the flag on, zone creation **fails if the ACL user can't be provisioned** (it's a security
  option — no zone without its credential).

---

## 5. Add machines

With a zone online, register/discover your machines so the spoke can drive them (power, boot,
provisioning) via their BMCs. Use the hub UI/CLI for enrollment.

---

## 6. Upgrades & operations

```bash
# upgrade (per stack dir)
docker compose pull && docker compose up -d

# status / logs
docker compose ps
docker compose logs -f <service>

# back up the hub database (the pgdata volume) regularly
```

For unattended upgrades, point your compose `image:` at a moving tag (e.g. `:latest`) and poll the
registry digest on a timer (or use a tool like Watchtower) to `pull && up -d` on change.

---

## Hardening checklist

- Strong, backed-up `BETTER_AUTH_SECRET` / `DEVICE_TOKEN_PEPPER` (and DB password).
- Hub only reachable over HTTPS; never expose the hub API without auth.
- Redis reachable by spokes over a private network/VPN only — never the public internet.
- BMC/OOB network isolated from general traffic.
- Per-spoke SSH keypair. (If pulling images from your own private registry
  instead of Docker Hub, also provision a least-privilege `read_registry`
  deploy token.)
