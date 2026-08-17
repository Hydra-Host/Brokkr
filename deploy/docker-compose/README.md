# Brokkr via Docker Compose

Two deploy units that mirror the real topology - run them on the machines they
belong on:

| Unit       | Folder                 | Runs on                              | What it is                                                             |
| ---------- | ---------------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| **Hub**    | [`hub/`](./hub/)       | one machine (cloud / central box)    | Control plane: Postgres + Redis + the customer/operator app (`:3000`). |
| **Bridge** | [`bridge/`](./bridge/) | each site machine, next to the metal | The "spoke" (`:8000`). One per zone.                                   |

A self-hoster copies `hub/` onto their control-plane box and `bridge/` onto each
site box. Each folder is a self-contained `docker compose` project with its own
`.env`.

## How they connect

The hub never calls a bridge directly. All hub<->bridge traffic is the **shared
Redis bus** (BullMQ), keyed by a Zone UUID:

```
  hub machine                          site machine
  +---------------------+              +------------------+
  | postgres            |              |                  |
  | redis  :6379  <-----+--------------+---- brokkr-bridge|
  | brokkr-hub :3000    |   REDIS_URL  |     (:8000)      |
  +---------------------+              +------------------+
```

The bridge needs **only** network reachability to the hub's Redis - no Postgres,
no hub HTTP. Set the bridge's `REDIS_URL` to the hub machine's Redis and its
`BROKKR_ZONE_ID` to a Zone you created in the hub.

## Run it

1. **Hub box:** `cd hub && cp .env.example .env && docker compose up -d`, then
   sign up at `http://<hub>:3000`, become a supplier, and create a Zone.
2. **Each site box:** `cd bridge && cp .env.example .env`, set `REDIS_URL` to the
   hub's Redis and `BROKKR_ZONE_ID` to the zone, then `docker compose up -d`.

To try both on one machine, run `hub/` first, then point the bridge's `REDIS_URL`
at the host (e.g. `redis://host.docker.internal:6379`).

See [`hub/README.md`](./hub/README.md) and [`bridge/README.md`](./bridge/README.md)
for details, and the [deployment overview](../README.md) for the component model
and configuration contract.
