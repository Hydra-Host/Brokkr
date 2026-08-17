# sql-seed

Numbered SQL applied to the hub Postgres (`brokkr`) by the `devenv up` DAG, in two
slots: the static `.sql` glue (e.g. lifecycle NOTIFY triggers) runs early via the
**`sql-seed:notify`** task (right after Prisma migrate); the generator-driven
device/catalog/listing seed runs later via the **`sim:seed`** task (after the Hub
admin org bootstrap, before `fleet:init`).

- Files run in lexical order — prefix with `NN-` (e.g. `01-`, `20-`) to order them.
- Each runs with `ON_ERROR_STOP=1`; write them **idempotent** (`CREATE OR REPLACE`,
  `DROP ... IF EXISTS`, `INSERT ... ON CONFLICT`) since they re-run every bring-up.
- This is **sim-only** glue applied _on top of_ the hub schema — it is NOT part of
  the hub's own Prisma migrations, so nothing here is invasive to brokkr-app.

Drop in whatever bootstrap data or DB instrumentation you want.

## Two kinds of file

- **Static `.sql`** — applied verbatim (schema glue, instrumentation).
- **Generator `NN-name.py`** — executed by the runner; each **prints SQL to
  stdout**, which the runner materializes to `_generated/NN-name.sql` (gitignored)
  and then applies. Generators do the dynamic work that plain SQL can't — read
  `fleet.yml`, HTTP-fetch the OS manifest, glob+hash `~/.ssh/*.pub` — and emit
  idempotent SQL. Runtime FKs (user ids, zone context, OS ids) are resolved at
  apply-time via subqueries inside the emitted SQL, so generators need no DB
  connection. They import the same pure shapers the Python seed uses
  (`local.derived`, `local.seed.storage`, `local.seed.netplan`,
  `local.seed.ssh_keys`, `local.seed.os_catalog`) — logic stays single-sourced.

Generators are run by the **`sim:seed`** devenv task (`scripts/tasks/sql-seed-run.sh`),
which (1) waits for the Hub admin bootstrap to create the org, (2) regenerates
`_generated/*.sql`, (3) applies static + generated SQL merged by numeric prefix. It
is the sim seed (it replaced the former `python -m local.seed` SimSeeder) and runs
**after the Hub is up, before `fleet:init`** — also on demand via `devenv tasks run
sim:seed` or the control center "Seed DB" op. The early post-migrate `sql-seed:notify`
slot applies only the static `.sql`.

## Current files

- `20-lifecycle-change-notify.sql` — `pg_notify('sim_lifecycle', …)` triggers on
  the lifecycle tables so the e2e harness can record a real-time DB-change
  timeline (the Postgres analog of Redis keyspace notifications).
- `30-ssh-keys.py` — `~/.ssh/*.pub` → `SshKeys` (userId via `User.email` subquery).
- `40-os-catalog.py` — HTTP manifest → `LayerGroup`/`Layer`/`LayerArtifact`
  (+ system layers: rescue, discovery, custom-iPXE). Needs network at gen time.
- `45-zone.py` — sim `Zone` + role=Bridge `Device` (+ `Bridge`).
- `46-prefixes.py` — per-zone `IpamPrefixVlanRole` + primary/management `Prefix`
  rows (optional DHCP gateway/pool on primary).
- `47-vrfs-vlan-groups.py` — org-scoped `Vrf` (`sim-vrf`) + per-zone `VlanGroup`;
  attaches existing prefixes to the VRF so admin IPAM relation counts are non-zero.
- `48-vlans-ip-ranges.py` — per-zone `Vlan` rows (data/mgmt/reserved) + always-on
  admin `IpRange` pools on primary/management prefixes (DHCP pools from 46 are
  optional extras); links prefixes→VLANs so VLAN `prefixCount` is non-zero.
- `50-devices.py` — per-VM `Device`/`Server`/`storageLayouts`/`netplanOverride`/
  `StorageDrive`/`Cpu`/`MemoryConfig`/`DeviceFirmware`/`Gpu` + enriched
  `Interface` rows (eth0/IPMI/ib0) from `fleet.yml` (site/location/supplier via
  `Zone` subquery).
- `51-commissioning-devices.py` — `seed_as_server=false` fleet nodes → `role=NULL`
  commissioning devices (IPMI-only, DHCP).
- `53-unassigned-devices.py` — two static `PLANNED` / `role=NULL` devices
  (`unassigned-1` / `unassigned-2`) for admin Create Switch/Server pickers
  (`adminListDevices?role=unassigned`). Independent of fleet.yml.
- `55-dcim.py` — DCIM / Circuits / BGP / Tags / Device-Models test data hung off
  the seeded servers: a model on each `cpu-N`, one rack (`SIM-R1`) with every
  device + four peer infra devices (switch/PDU/console-server/patch-panel) racked
  on it, ports + cables wiring them, plus tags, ASNs/BGP sessions, and a circuit.
  Runs after `50-devices` (servers must exist) and before `60-listing`.
- `60-listing.py` — pricing + `isListed` on every sim Server (set-based).
- `61-device-diagnostics.py` — historical `DeviceTestRun` and ended-deployment
  `DeviceDiagnostics` records for the first two sim servers.
- `62-device-documents.py` — sample `DeviceDocument` rows on the first two sim
  servers for the admin Documents tab (`uploadedBy` = `brokkr@brokkr.local`).
