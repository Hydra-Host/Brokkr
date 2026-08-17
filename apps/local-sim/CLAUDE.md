# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A local dev environment (formerly `loca-environment`, the package name is `local`) that simulates bare-metal machines so Hydra's bare-metal orchestration stack — the **hub** + the **spoke** — can be developed without real hardware. Each "node" is a libvirt domain with its own IPMI endpoint (OpenIPMI `ipmi_sim`) and Redfish endpoint (`sushy-emulator`). Cross-platform: **macOS** (HVF acceleration on Apple Silicon, qemu over socket_vmnet) and **Linux** (KVM, qemu over libvirt's native bridge network). Auto-detected per host.

The dev loop is driven by `task up` (from the repo root, inside the devenv shell), which brings up the whole stack — datastores, Vault, hub services, spoke service, sim fleet — supervised by **devenv** (a declarative reproducible env; process-compose runs every process over a Unix-domain socket). There is no `brokkr-local` tmux session anymore. See "Stack orchestration" below.

## Mental model: hub + spoke + datastores + fleet

```
Dev host (macOS Apple Silicon, or Linux x86_64/arm64)
├── Datastores (native devenv services — services.postgres/redis, no docker)
│   ├── postgres                   ← :5432, Hub DB ("brokkr")
│   ├── redis                      ← :6379, Bridge Redis (zone-namespaced keys)
│   └── nginx                      ← OS-layer cache (services.nginx; avoids re-downloading layers)
├── Hub ($HUB_REPO_PATH)
│   ├── api :3000                  ← customer + saga orchestration
│   ├── api dev:admin :3001        ← admin API
│   ├── web :5173                  ← customer UI
│   └── web-admin :5174            ← admin UI (where you click Provision)
├── Spoke (same checkout — hub and spoke are one monorepo)
│   └── bridge :8000               ← talks to BMCs over loopback, builds discovery initrds, hosts saga runtime
├── libvirt + qemu                 ← <domain> per node — HVF on macOS, KVM on Linux
│   └── N sim node VMs             ← each = per-VM iPXE EFI direct-loaded as <kernel>
├── ipmi_sim (root)                ← one per VM, binds 192.168.105.10–13:623 (lo0/lo aliases)
├── sushy-emulator (user)          ← one per VM, binds 192.168.105.10–13:8000
└── data-plane bridging            ← macOS: socket_vmnet + Apple bootpd
                                     Linux: flat L2 kernel bridge 'br-brokkr' (no libvirt net / dnsmasq)
```

Two distinct planes, both host-routable:

- **BMC plane** (`bmc_cidr`, default 192.168.105.0/24) — loopback alias IPs (lo0 on macOS, lo on Linux). Pure host loopback, no real interface. ipmi_sim + sushy bind here.
- **Data plane** (`cidr`, default 192.168.200.0/24) — host-routable bridge interface. Each VM's data NIC has a static IP baked into both the discovery initrd's netplan AND the installed-OS cloud-init `network-config` (both sourced from `device.netplan` in Bridge Redis, which the spoke synthesizes from the Hub-seeded `Server.netplanOverride` written by the `50-devices` generator).

## Boot path: PXE via iPXE direct-load

Each VM's libvirt XML has `<kernel>{state}/boot/<arch>/ipxe-<name>.efi</kernel>` — qemu direct-loads the per-VM iPXE binary at power-on. iPXE's embedded script DHCPs (or uses the static netplan baked into the discovery initrd), then HTTP-fetches kernel + 3-layer initrd (`vmlinuz`, `initrd.img`, `brokkr-discovery-{Device.id}.img`, `brokkr-live.img`) from the spoke at `http://127.0.0.1:8000`. There is no firmware-side PXE/TFTP — direct-load short-circuits firmware-network-boot.

**Discovery initrds are keyed by `Hub.Device.id` UUID.** Both the spoke's render contract and the prefetch/iPXE-builder embed the UUID. `fleet.py:_node_device_ids()` joins fleet.yml ↔ Hub by BMC IP and returns `name → Device.id` (UUID string).

The per-VM iPXE binary is always direct-loaded as `<kernel>` and is never stripped — ipmi_sim's chassis hook only persists IPMI bootdev events for the bridge's set-then-verify round-trip, never mutating boot order. The boot decision (brokkr-live vs. grub-from-disk) is made server-side by the spoke's `/api/chain` from `Hub.Device.status` + the GPT on disk. See "Reprov / Deprovision flow" gotcha below.

**No `<initrd>` or `<cmdline>` in the domain XML, and no kernel/initrd URLs in the embed script.** iPXE's embed script only sets the static IP/gateway/netmask, `ifopen`s the NIC, and `chain --autofree ${base}/api/chain##params` — handing the boot decision (kernel + initrd layer order + cmdline, or grub-from-disk) to the **spoke's `/api/chain`**, with system params (platform/arch/ip/mac/serial/ipmi\_\*) passed in the query string. The old `combined-{name}.initrd` per-VM cpio concatenation is gone.

## Common commands

Orchestration (bring-up/teardown) is the root Taskfile's verbs (`up`/`setup`/`doctor`/`down`/`reset`/`status`/`logs`) wrapping devenv; run them from the repo root inside the devenv shell. The engine's interactive operator verbs also live in the root Taskfile, under the `sim:` namespace — reach them with `task sim:<verb>`.

```bash
# === One-command bring-up (canonical dev loop) — repo root, in the devenv shell ===
task up                                 # idempotent host bootstrap (once) + passwordless sim sudo,
                                        # then `devenv up -d` (the full DAG: datastores + hub/spoke +
                                        # control center + seed + fleet). Re-run to reconcile.
                                        # See "Stack orchestration" below.

# Inspect / interact while the stack is up (root verbs)
task status                             # process-compose process list + the fleet status table
task logs                               # process-compose overview TUI (status/health + per-process logs)

# Engine operator verbs (task sim:<verb>)
task sim:fleet:consoles              # rebuild + attach a tmux window with one pane per VM (serial log)
task sim:fleet:shells                # tmux window, one SSH shell pane per reachable VM
task sim:dash                        # combined consoles+shells operator dashboard
task sim:node:console NAME=gpu-1     # tail one VM's serial console
ssh ubuntu@192.168.200.10               # SSH into a provisioned VM (default user `ubuntu`,
                                        # NOT root — root is the brokkr-live user)
ssh root@192.168.200.10                 # SSH into a brokkr-live (discovery-phase) VM

# Fleet power + restarts (process-compose, or the control center UI)
devenv processes start|stop|restart fleet   # power the VMs on / tear them down / cycle
devenv processes restart hub-api            # restart just the hub api (likewise hub-admin / spoke / …)

# Teardown
task down                               # devenv processes down (datastores + hub/spoke + control
                                        # center + fleet; the fleet's shutdown hook runs `fleet down`)
task reset                              # DESTRUCTIVE: down + wipe datastore data + fleet overlays
task sim:fleet:nuke                  # just the fleet: down + delete overlays + sushy configs + NVRAM

# BMC ops
task sim:ipmi -- gpu-1 chassis power on
task sim:ipmi -- gpu-1 chassis power reset  # NOTE: virtualbmc doesn't implement 'cycle' (0x02) — use 'reset' (0x03)
task sim:redfish -- gpu-1 power-cycle       # verbs: status | power-on | power-off | power-cycle

# Sim seed (runs in the devenv DAG after the hub is up; on demand below or via the control center "Seed DB" op)
devenv tasks run sim:seed               # generator-driven Hub Postgres seed (see §10). Lands devices
                                        # ready for Provision: role=Server + Device.status=ACTIVE +
                                        # Server.lifecycleStatus=INVENTORY + Server.storageLayouts +
                                        # StorageDrive + Zone + SshKeys + OS catalog + listing.

# Engine build / config (task sim:<verb>)
task sim:setup                       # re-run the host bootstrap (provisioning/bootstrap.sh)
task local:config                 # print resolved Settings (env + .env + defaults)
task local:config -- --show-secrets   # unmask DSNs

# Status + artifact builds run from the lab API (lab-web Status/Build tabs):
#   curl localhost:3002/api/status                            # fleet status
#   curl -X POST localhost:3002/api/build/agent               # rebuild brokkr-live.img
#   curl -X POST localhost:3002/api/build/netboot-grub        # rebuild grub binaries

# Python / tests / lint (from the devenv shell — the toolchain is on PATH)
pytest tests/
pytest tests/test_render_domain.py::test_name
ruff check scripts tests
ruff format scripts tests
```

The Python module under `scripts/local/` is a proper uv project — `uv.lock` is committed, dev deps live in `[dependency-groups]`, and the devenv shell installs deps + the dev group + the editable project — `pyproject.toml` puts `scripts/` on `sys.path` so imports are `from local.foo import ...`. The IPMI BMC is OpenIPMI `ipmi_sim`, a top-level C package (`devenv/pkgs/openipmi.nix`) resolved via `LOCAL_IPMI_SIM_BIN` — not a python dep, so it's unaffected by `uv sync`.

## Stack orchestration (one-command bring-up)

Orchestration lives in **devenv** (`devenv.nix` + `modules/hub.nix` / `modules/spoke.nix` / `modules/fleet.nix`), not in a Taskfile. `task up` (repo root, in the devenv shell) is the canonical entrypoint for a cold dev session. It is a thin wrapper that (1) runs the idempotent host bootstrap once (`provisioning/bootstrap.sh`, guarded by a success marker so it's a no-op after — installs the OS-level virt stack Nix can't provide: Linux libvirtd/KVM/firmware/docker, macOS Docker Desktop), (2) installs the passwordless-sudo drop-in (`devenv tasks run sudo:setup` — one prompt the first time, silent after), (3) runs `devenv up -d` (brings up + supervises the whole stack, detached), (4) runs `stack-reconcile` (`scripts/tasks/stack-reconcile.sh`) to revive any stopped or crash-looped datastore/hub/spoke process in dependency order — re-unsealing a sealed Vault, leaving Disabled (opt-in-off) + Running ones be — so a re-run self-heals. That same script backs the control center's "Reconcile / self-heal" op. Re-run `task up` anytime to reconcile (idempotent).

`devenv up -d` runs the DAG:

1. **toolchain + host paths** — the devenv shell provides the Node/pnpm/Python/uv toolchain; a `hostpaths` step creates the `/opt/brokkr → …` symlink both hub and spoke read.
2. **libvirt** — on **macOS** the user-session daemon runs as the supervised `virtqemud` process (`modules/fleet.nix`; `--timeout 0`, foreground — restart/health/logs in the DAG). On **Linux** the `libvirt:up` task verifies/starts the system libvirtd service (the macOS branch of the task is a no-op).
3. **native datastores** — `services.postgres` (:5432), `services.redis` (:6379), and `services.nginx` (OS-layer cache) come up as supervised processes (no docker). `thanos` is a receive placeholder.
4. **hub install/migrate** — in `$HUB_REPO_PATH`: `pnpm install` + workspace package build + `prisma migrate deploy` (devenv tasks defined in `modules/hub.nix`).
5. **hub processes** — `hub-api` (:3000), `hub-admin` (:3001), `hub-web` (:5173), `hub-web-admin` (:5174), gated on `/healthcheck`. Per-process env is declared in `modules/hub.nix` (pins `HYDRAHOST_ORGANIZATION_ID` to the static UUID).
6. **spoke** — `spoke` (:8000), gated on `/api/health` (env in `modules/spoke.nix`).
7. **`sim:seed`** (devenv task, after `hub-admin` healthy) — generator-driven Hub Postgres seed (Device/Server/storage/OS catalog/listing). Runs after the hub is up (the better-auth org bootstrap must exist) and before `fleet:init`, which needs the seeded Device rows for its fleet.yml ↔ Hub join + per-VM prefetch. Seeding is a DAG concern; `fleet:init` no longer does it.
8. **`fleet:init`** (devenv task, after `sim:seed` + spoke healthy + the libvirt dep — the `virtqemud` process on macOS / `libvirt:up` on Linux) — builds brokkr-live.img (native cpio), warms spoke cache, builds per-VM iPXE binaries.
9. **the `fleet` process** (`modules/fleet.nix`, after `fleet:init`) — `python -m local.fleet up --supervise`: renders libvirt XMLs, starts daemons (socket_vmnet on macOS / the `br-brokkr` L2 kernel bridge on Linux; virtqemud is no longer fleet-spawned — it's the separate `virtqemud` process on macOS), starts a per-node ipmi_sim + sushy, auto-powers-on each VM, then blocks; on SIGTERM (stop/restart) it runs `fleet down`.
10. **control center** — `processes.lab` (:3002) + `processes.lab-web` (:5175) come up alongside the rest.

**The `fleet` process** is a single supervised process-compose process. Control it with `devenv processes start|stop|restart fleet` or from the control center UI. A `fleet.autoStart` knob (in `devenv.local.nix`, default true) controls whether `task up`/`devenv up` auto-starts it; `{ fleet.autoStart = false; }` leaves `fleet` defined-but-`disabled` (and `sim:seed` + `fleet:init` fire only when the fleet does), giving a control-plane-only bring-up.

**Why the BMC daemons stay inside the fleet supervisor (not process-compose):** `virtqemud` was hoisted out to its own process because it's cardinality-1, sudo-free, and foundational. The per-node BMC daemons (`daemons.py`) are deliberately _not_ — they're managed by `fleet.py`'s `cmd_up`/`cmd_down` instead:

- **ipmi_sim** (N, one per node) runs as **root via sudo**, so process-compose (running as the user) can't deliver a stop signal to it — the same EPERM problem that bans `nest start --watch` from owning sudo grandchildren. Each binds `bmc_ip:623` on a loopback alias `cmd_up` adds _first_, and its per-node config is derived from `fleet.yml` (dynamic cardinality unknown at Nix eval time) — so `fleet.py`'s `cmd_up`/`cmd_down` own its lifecycle, not process-compose.
- **sushy** (N, one per node) and **socket_vmnet** (N, macOS, root) have **dynamic cardinality** from `fleet.yml` — unknown at Nix eval time — and per-node config derived in `derived.py` (`node_uuid` = uuid5-from-MAC). Re-deriving that in Nix would fork a source of truth. socket_vmnet adds sudo on top. The fleet-as-domain-supervisor boundary is the right call for these.

**Hands-off first-time setup** (zero manual config): `bash provisioning/bootstrap.sh` (installs Nix + direnv, AUTO-appends the direnv shell hook to your rc, AUTO-runs `direnv allow` on the repo) → open a fresh shell (`exec $SHELL`) → `cd` into the repo (direnv auto-loads devenv, building the toolchain) → `task setup` (clone any missing hub/spoke checkout + create the ssh key) → `task up`. No manual rc editing, no manual `direnv allow`. On a truly fresh machine the only sudo prompts are the unavoidable two (system-package install + the NOPASSWD drop-in), then never again.

**Preconditions** (the `setup:preflight` gate `task up` runs first — `task doctor` is the full readiness report):

- in the devenv shell (`$DEVENV_ROOT` set — `cd` in so direnv loads it, or `devenv shell`)
- `$HUB_REPO_PATH` points at the monorepo checkout that holds both hub and spoke. It defaults to this checkout (`config.polyrepo.hub.path` is empty → the repo root; see `modules/polyrepo.nix`), so it needs no setup in a normal clone. Override in `devenv.local.nix` (`config.polyrepo.hub.path`) or `.env`/`.envrc.local`.

**Supervision/inspection**: process-compose supervises everything over a Unix-domain socket. `task logs` (= `process-compose attach -U`) is the live overview TUI (status/health + per-process logs); `task status` is the process list + the fleet status table. There is no `brokkr-local` tmux session for hub/spoke anymore — process-compose replaced it. The fleet's per-VM serial-console tmux dashboards still exist as engine operator verbs (`task sim:fleet:consoles` / `fleet:shells` / `dash` / `node:console`). Restart a single component with `devenv processes restart <name>` (`hub-api`, `hub-admin`, `hub-web`, `hub-web-admin`, `spoke`, `fleet`).

## Architecture: how `fleet.yml` becomes a running fleet

The fleet topology is **declared in devenv and rendered to a `fleet.yml` the engine reads**. The committed base lives in `modules/fleet-topology.nix` (the `config.fleet` block in the topology module); per-host deltas go in `devenv.local.nix` and **deep-merge** over it (`fleet.nodes.cpu-1.memory_mb = 16384;` patches one field; `fleet.nodes.cpuN.enable = false;` drops a node; `fleet.nodes.cpu-5 = { … };` adds one). `modules/fleet-topology.nix` renders the effective config to a `/nix/store/…-fleet.yml` and points `LOCAL_FLEET_PATH` at it, which `paths.fleet_path` honors above the `_default_fleet_path` fallback (`fleet.local.yml` → none). Field names in the Nix layer mirror `schema.py` 1:1 (snake_case); per-node IPs are still list-position-derived, so the renderer emits nodes sorted by each node's `index` (default: trailing `-N` of the name) to keep IPs stable across appends (disabling/removing a non-terminal node still shifts every downstream node's data/BMC IP + Device UUID unless pinned via per-node `ip`/`bmc_ip`). The Nix layer is light typing + the override seam — **Pydantic stays the validation authority** (it re-validates the rendered YAML on load). The pipeline:

1. **`scripts/local/schema.py`** — Pydantic models (`Fleet`, `Node`, `Network`, `Defaults`, `BmcConfig`). Validates the rendered `fleet.yml`, applies defaults, enforces unique names/MACs. **Each node has two MACs**: `ipmi_mac` (BMC NIC; stable; seeds Redfish UUID, SCSI serial, SCSI WWN) and `data_mac` (customer-facing NIC; what qemu's virtio-net-pci reports and what bootpd matches against). They must differ.
2. **`scripts/local/config.py`** — pydantic-settings driven config. `get_settings()` (lru-cached) returns the composed `Settings` with sub-models: `state` (per-host paths under `~/.local/share/local/` by default, overridable via `LOCAL_STATE`), `paths` (binary + firmware paths, `LOCAL_*` env prefix — defaults are computed by `local.host_os` adapters so they work on both macOS and Linux without hardcoding `/opt/homebrew/...`), `bridge` (local endpoint + zone id + bridge-side state, `BRIDGE_*` env prefix), `sim` (`SIM_*` env prefix — site/location IDs, nameservers, `SIM_HOST_ARCH` auto-detected), `stores` (`HUB_DATABASE_URL`, `BRIDGE_REDIS_URL`), `runtime` (cache TTL).
3. **`scripts/local/host_os.py`** — cross-platform detection adapters: `libvirt_uri()`, `detect_edk2_code()`, `detect_edk2_vars_template()`, `detect_qemu_emulator()`. Called via lazy adapters from `config.py` so platform-specific paths (`/opt/homebrew/share/qemu/...` on macOS vs `/usr/share/qemu/...` / `/usr/share/AAVMF/...` on Linux) don't have to be hardcoded in defaults. Override via `LOCAL_*` env vars if your install layout is non-standard.
4. **`scripts/local/derived.py`** — pure functions of a `Node` or `Fleet`: `node_ip`, `bmc_ip`, `node_uuid` (Redfish system UUID, uuid5 from MAC), `node_serial` + `node_wwn` (SCSI INQUIRY values stable per MAC — bridge correlates `lsblk -o NAME,SERIAL,WWN` against `storage_layouts.configs[].disks[]`), `arch_url_segment`.
5. **`scripts/local/render.py` + `scripts/local/render_all.py` + `templates/domain.xml.j2`** — `render.py` produces a single node's XML string and the bootptab body. `render_all.py:render_fleet_to_dir` iterates the fleet and writes one XML per node into `state.render_dir/domains/`. The Jinja template is **cross-platform** — `host_os` ('macos' or 'linux') and `host_arch` ('arm64' or 'amd64') context vars drive `<domain type='hvf'>` vs `<domain type='kvm'>`, machine type, firmware paths, and network plumbing (`-netdev stream` to socket_vmnet on macOS, `<interface type='bridge'>` onto the flat L2 kernel bridge `br-brokkr` on Linux). virtio-scsi for OS disk (`/dev/sda`, sparse raw `.img`); EDK2 UEFI loaded passively via `<loader>` + per-VM `<nvram>`; `<kernel>` points at the per-VM iPXE binary; data plane NIC is `virtio-net-pci` on pcie.0:0x2 (iPXE needs PCI, not MMIO).
6. **`scripts/local/pxe.py`** — per-VM iPXE binary builder. `build_ipxe_for_node(fleet, node, device_id: str)` writes an embed script (set static IP/gw/netmask, `ifopen`, then `chain --autofree ${base}/api/chain##params` — the spoke renders the actual kernel/initrd/cmdline, see `_embed_script`) and compiles it via **`docker buildx`** (an inline `_IPXE_DOCKERFILE` git-clones ipxe.org fresh and runs `make {target}/ipxe.efi EMBED=/boot.ipxe`). `device_id` is `Hub.Device.id` (UUID) used in the prefetch + embed URLs (`brokkr-discovery-{UUID}.img`). Idempotent: rebuild fires only when the embed script's bytes change (script written to sidecar `.ipxe` file, compared on next call). `_vm_reachable_bridge_url(zone_index)` substitutes `127.0.0.1` → data-plane gateway IP (and the node's zone HTTP port) so iPXE in the VM can reach its zone's spoke.
7. **`scripts/local/fleet.py`** — orchestration entrypoint. `python -m local.fleet {init,up,down,nuke}` (the `fleet` process runs `up --supervise`). libvirt is up before `init` and the `fleet` process's `up` because both `after` the libvirt dep — the supervised `virtqemud` process on macOS, the `libvirt:up` task (system libvirtd) on Linux; `cmd_up` no longer spawns virtqemud itself (`preflight` only verifies it's reachable). Split into two phases:
   - **`init`** (slow, idempotent): preflight, sudo cache, state dirs, **brokkr-live.img native cpio build** via `local.live_initrd`, **per-node `Device.id` (UUID) lookup** via `_node_device_ids()` (joins fleet.yml ↔ Hub by BMC IP — needs the Device rows already seeded), spoke cache warm-up via `local.prefetch.prefetch_shared_boot_artifacts` (kernel + base initrd + brokkr-live.img per arch) + `prefetch_node_discovery_initrd` (per-VM `brokkr-discovery-{UUID}.img`), per-VM iPXE binary build via `local.pxe.build_ipxe_for_node`. **The sim seed is not part of `cmd_init`** — the devenv DAG runs the `sim:seed` task (the generator-driven seed, see §10) _before_ `fleet:init` (`fleet:init` declares `after = [ "sim:seed" … ]`), so the seeded Device rows exist when `_node_device_ids` + prefetch run. (`fleet:init` itself no longer seeds — seeding is a DAG concern.)
   - **`up`** (fast, idempotent): render libvirt XMLs, write `/etc/bootptab` (macOS only — Linux uses libvirt's managed bridge), per-node sparse raw overlay creation, per-VM NVRAM copy, socket_vmnet start (macOS), per-node setup (loopback alias + libvirt define + start ipmi_sim as root via sudo + sushy start + auto-power-on via `virsh start`).
8. **`scripts/local/live_initrd.py`** — builds `brokkr-live.img` **natively** by cpio-newc-packing bridge-api's `boot/initrd-live` tree. No docker buildx anymore: production CI does the build in a container and ships it as a release artifact; here we run the same `cpio -o -H newc` directly. Bridge-api's Dockerfile bakes internal Hydra CA certs into the prod build; the sim explicitly skips that (sim VMs only talk to the local spoke over plain HTTP). Required on the host: `cpio` (POSIX). The source tree is `apps/bridge/boot/initrd-live` in this repo (resolved from `HUB_REPO_PATH`, which defaults to the checkout the sim lives in). Idempotent: skips when output is newer than every input.
9. **`scripts/local/stores.py`** — Hub Postgres **read** client (`HubDB`, `SimDevice`). The seed _writes_ moved to the SQL generators (§10); what remains here are read helpers used by `fleet.py` + the e2e tests: `HubDB.get_sim_devices_by_bmc_ips` (the fleet.yml ↔ Hub join `_node_device_ids` uses), `get_server_state` (`Server.lifecycleStatus` + `Device.status` — the two lifecycle axes the saga drives), and `get_storage_layouts` (reads `Server.storageLayouts` — the seeded disk catalog a provision request's `diskLayouts` must agree with). Background on what the seed writes: `Device.status='ACTIVE'` (coarse role-agnostic lifecycle — post `20260603140000_device_status_lifecycle_split` `DeviceStatus` is `{PLANNED, STAGED, ACTIVE, MAINTENANCE}`; INVENTORY moved to `Server.lifecycleStatus`), `role='Server'` (the unconditional listing/provision discriminator post MTI migration), a paired empty `Server` row inheriting `lifecycleStatus=INVENTORY`, and `Server.storageLayouts`/`Server.netplanOverride` (canonical — the `Device.*` originals are a frozen archive). The org/owner identity is created by Hub's `main.admin.ts` bootstrap, not here (see "Seed preconditions").
10. **`sql-seed/` + `scripts/local/seed/`** — the sim seed is **generator-driven SQL**, not Python writes. `sql-seed/` holds numbered generator scripts (`NN-name.py`) alongside static `.sql`; the runner (the `sim:seed` devenv task, which the DAG runs after `hub-admin` is healthy and before `fleet:init` — also runnable on demand via `devenv tasks run sim:seed` or the control center "Seed DB" op) (1) waits for Hub's admin bootstrap to create the org, (2) runs each generator — which **prints idempotent SQL to stdout** — capturing it to `_generated/NN-name.sql` (gitignored), then (3) applies static + generated SQL via `psql` against the native Postgres, merged by numeric prefix. Each generator does the dynamic work plain SQL can't (read `fleet.yml`, HTTP-fetch the manifest, glob+hash `~/.ssh`) and emits `INSERT … ON CONFLICT` (idempotent); runtime FKs (user ids, Zone context, OS ids) resolve at apply-time via subqueries in the emitted SQL, so generators need no DB connection. Generators call `local.sqlemit` (`q`/`qj`/`header`/`logs_to_stderr`) and route logs to **stderr** so stdout stays pure SQL. Order:
    - `20-lifecycle-change-notify.sql` (static) — pg_notify triggers for the e2e timeline.
    - `30-ssh-keys.py` — `~/.ssh/*.pub` → `SshKeys` (`userId` via `User.email` subquery; no-ops if the owner user row doesn't exist yet).
    - `40-os-catalog.py` — HTTP manifest (`SIM_OS_LAYERS_MANIFEST_INDEX_URL`) → `LayerGroup`/`Layer`/`LayerArtifact` (+ system layers: rescue, discovery, custom-iPXE). Soft-deactivates prior active `LayerArtifact` rows per slot before inserting (partial unique index `LayerArtifact_active_slot_key`). Custom User-Agent — the Cloudflare-fronted host 403s `python-urllib`.
    - `45-zone.py` — sim `Zone` with primary/shipping addresses, contacts, maintenance history, and role=Bridge `Device` (+ `Bridge` row).
    - `50-devices.py` — per-VM `Device` (role=Server, `status=ACTIVE`, `systemSerial`/`chassisSerial`) + paired empty `Server` (inherits `lifecycleStatus=INVENTORY`) + `Server.storageLayouts` + `Server.netplanOverride` (match-by-MAC, `set-name: eth0`, fleet.yml-derived static IP) + `sda` `StorageDrive` + hardware inventory (`Cpu` × fleet `cpus`, `MemoryConfig`, BIOS/BMC `DeviceFirmware`, one synthetic `Gpu`) + interfaces (`eth0`/`IPMI` enriched with speed/mtu/driver/link state, plus synthetic `ib0` InfiniBand for admin UI). site/location/supplier resolve via `Zone` subquery (so `45-zone` must apply first). The spoke synthesizes its own Bridge Redis device record from this Hub state — there is no Redis write in the seed anymore. Hub's payload builder reads `Server.storageLayouts` for the saga's `disk_layouts`; serial/WWN must match `derived.node_serial`/`node_wwn` or bridge's `prepare_storage` fails with "at least one disk group is required."
    - `60-listing.py` — set pricing ($1.00/$0.50) + `isListed=true` on every sim Server so devices show in the admin `/devices` listing.
    - `61-device-diagnostics.py` — deterministic test-run and ended-deployment diagnostic histories for the first two sim servers; it leaves server lifecycle state untouched.
    - `62-device-documents.py` — sample `DeviceDocument` rows on the first two sim servers for the admin Documents tab.

    `scripts/local/seed/` now hosts **only the pure shapers** the generators import: `netplan.py` (`sim_static_netplan`), `storage.py` (`build_storage_layouts`), `ssh_keys.py` (`ssh_fingerprint`, `iter_ssh_pubkeys`), `os_catalog.py` (`fetch_manifest`, `http_get_json`, `normalize_selection_type`, `normalize_kind` — fetch + enum normalizers only, no write side). There are no phase classes (`SimSeeder`/`HydraHostBootstrap`/`DeviceSeeder`/etc.) and no `python -m local.seed`. Generator output shape is tested offline in `tests/test_sql_generators.py`.

11. **`scripts/local/prefetch.py`** — spoke cache warm-up. Under PXE, iPXE inside the VM fetches artifacts from the spoke over HTTP at power-on. Prefetch pre-builds spoke's per-VM `brokkr-discovery-{UUID}.img` so the first iPXE GET lands on a cache hit instead of stalling on an on-demand build. `curl_cmd()` no longer carries any mTLS flags — local spoke is plain HTTP.
12. **`scripts/local/daemons.py`** — socket_vmnet (macOS only), ipmi_sim, sushy lifecycle (virtqemud moved to the `virtqemud` process-compose process on macOS; `libvirt_uri_for_root()` stays here). `start_ipmi_sim(node, bmc)` renders a per-node lanserv `lan.conf` (binding `bmc:623`, wiring the `ipmi-sim-chassisctl.py` → virsh chassis hook + BMC creds) and `sim.emu`, then sudo-launches `ipmi_sim` as root by absolute store path (`LOCAL_IPMI_SIM_BIN`). No DB creds flow to it — the chassis hook only drives `virsh`. `ipmi_sim_registered_names()` enumerates the on-disk config dirs (`state/ipmi-sim/<node>`) so teardown works with the daemons already stopped.
13. **`scripts/local/status.py`** — Rich-rendered status table; surfaced by `task status` (root) and by the lab API at `GET /api/status`.
14. **`scripts/local/show_config.py`** — prints the resolved `Settings` (env + `.env` + defaults). `task local:config` runs it; `task local:config -- --show-secrets` unmasks DSNs.
15. **`scripts/local/process_utils.py`** — central subprocess + sudo wrappers: `run`, `sudo`, `virsh`, `cmd_succeeds`, `ensure_sudo_cached`, plus pidfile helpers. Every shell-out in the package goes through here so behavior (sudo cache, error handling, output capture) is uniform.
16. **`scripts/local/logger.py`** — shared CLI logger. `from local.logger import log` gives the module-level singleton with six methods (`info` / `success` / `detail` / `warn` / `error` / `skip`). **All human-facing CLI output goes through this** — no `print()` calls or local `log()` helpers. The one intentional bypass: Rich `Console().print(table)` for status tables in `status.py`.

State (overlays, prefetched boot artifacts, rendered XMLs, EDK2 NVRAM, pidfiles, logs, per-VM iPXE binaries) lives under **`~/.local/share/local/`** (override with `LOCAL_STATE`).

**The split rule between `config.py` and `derived.py`** (preserve this when adding new constants/functions):

- If it depends on a `Node` or `Fleet` → `derived.py`.
- Otherwise (install layout, env config, daemon paths) → `config.py`.

## Bridge endpoint

Bridge always runs on the same host at `http://127.0.0.1:8000`. There is no remote-bridge mode — `BRIDGE_LOCAL` / `BRIDGE_HOST` / `BRIDGE_URL` / `BRIDGE_CLIENT_*` and `certs/` are not consumed. Override the endpoint only for non-default ports / container networks (`BRIDGE_ENDPOINT=http://172.17.0.1:8000` etc).

iPXE's embed script substitutes `127.0.0.1` → data-plane gateway IP at build time (see `pxe.py:_vm_reachable_bridge_url`), since the VM's perspective of localhost differs from the Mac's.

## Spoke environment

"Bridge" and "spoke" are used interchangeably in this codebase — the dev tooling settled on **spoke** as the canonical name. It is not a separate repo: the spoke is `apps/bridge` in this monorepo. The spoke must run with `LOCAL_SIMULATION_ENABLED=true`. This flips two behaviors:

1. `phone_home_endpoint` → `http://192.168.200.1:3000/api/v1/bmc/phone-home` (data-plane gateway IP, locally hosted hub instead of remote `brokkr.hydrahost.com`).
2. The cpio packer (`bridge/services/initrd/common_utils.py`) appends `-R 0:0` to `cpio -o -H newc` so files written into discovery initrds end up owned by UID 0 — required because the spoke runs as the dev user (UID 501 on macOS, ~1000 on Linux) and sshd's `StrictModes yes` rejects `authorized_keys` not owned by the target user.

**SSH key**: set `BRIDGE_SSH_PRIVKEY_PATH=$HOME/.ssh/id_ed25519` (or wherever the keypair lives) — the spoke reads the `.pub` and bakes it into `/root/.ssh/authorized_keys` of the discovery initrd. Without this, root SSH from the spoke into sims fails, hanging `wait_for_brokkr_live`. (Two SSH-key envs exist on the spoke side; `BRIDGE_SSH_PRIVKEY_PATH` is sufficient — `core.py`'s `SSH_KEY_PATH` consumer falls back to it.)

## Seed preconditions (Hub Postgres state the provision saga reads)

The sim's seed isn't just per-device — together with the **hub's sim-admin bootstrap** it lays down the org/identity/billing rows the provision saga reads. In sim the owner identity is created by the hub itself (no Azure AD — see the owner bullet). Skip any of these and the saga fails before it ever talks to bridge.

- **Static Hydra Host org**: `Organization.id = HYDRAHOST_ORGANIZATION_ID` (default `00000000-0000-0000-0000-000000000000`), `tenantType='SupplyCustomer'`, `tenantId='1'`. **Created by Hub's `main.admin.ts` bootstrap** (see the owner bullet), not the sim seed. The `45-zone` generator FK-references it, and the `sim:seed` task waits for the row before applying.
- **Paired `FeatureFlags` row** — one-to-one with `Organization`. `BillingInformationService.createBillingInformationForOrganization` reads `customer.featureFlags.verifiedExtendTerms` and crashes with `Cannot read properties of null` if the row doesn't exist. Hub's admin bootstrap writes it alongside the org.
- **Owner identity (sim) — created by the hub, no Azure AD.** `$HUB_REPO_PATH/apps/api/src/main.admin.ts:bootstrapAdminUsers` (gated on `LOCAL_SIMULATION_ENABLED=true`) runs on admin-app startup: it upserts the sim org `00000000-0000-0000-0000-000000000000` ("Brokkr Org", tenant 1) + `FeatureFlags`, and signs up `brokkr@brokkr.local` / password `brokkr` via better-auth as **Owner**. There is **no Azure AD sign-in** in sim, and wiping the Postgres volume is safe — the hub re-bootstraps this on every start. Without an Owner membership, billing throws `Cannot read properties of undefined (reading 'user')`.
- **Owner membership (better-auth `Member`)**: the `Organization.members` relation Prisma reads (the saga's billing path) points at better-auth's `Member` table; Hub's admin bootstrap creates the Owner `Member` row when it signs up `brokkr@brokkr.local`. The sim seed does not write memberships.
- **Role must be `Owner`, not `Admin`**: `OrganizationMembershipRole` enum is `SuperAdmin | Admin | Member | Owner`. Billing's `createBillingInformationForOrganization` gates on `Owner` specifically; `Admin` doesn't pass.
- **SSH keys**: the `30-ssh-keys` generator attaches `~/.ssh/*.pub` to the owner user (resolving `userId` via a `User.email` subquery on `brokkr@brokkr.local`). The provision validator requires the reserving user to have ≥1 `SshKeys` row. Outside sim, `User` rows come from Azure AD + better-auth at first sign-in.
- **OS catalog freshness**: the `40-os-catalog` generator pulls the manifest from `SIM_OS_LAYERS_MANIFEST_INDEX_URL` and emits `LayerArtifact` rows with the host's arch (`SIM_HOST_ARCH`, auto-detected). The Cloudflare-fronted asset host blocks `python-urllib` UAs — the generator sets `User-Agent: local-environment-seed/1.0` to bypass.

## Gotchas

- **The boot decision is spoke-side (`/api/chain`), not a host-side XML rewrite.** ipmi_sim's chassis hook (`scripts/ipmi-sim-chassisctl.py`) persists `chassis bootdev` only to satisfy the bridge's set-then-verify round-trip; it never changes real boot order. The per-VM iPXE binary is always loaded as `<kernel>` and is never stripped/restored. Bridge always sends `bootdev=pxe` (`bridge/config/lifecycle.py:default_boot_device = "pxe"`); iPXE chains to the spoke's `/api/chain`, which decides discovery-vs-installed-OS from `Hub.Device.status` (incl. `DEPROVISIONING` → discovery + wipe) plus the GPT signature on the disk.
- **ipmi_sim is the BMC, built from source via Nix (`devenv/pkgs/openipmi.nix`).** It's the wrouesnel OpenIPMI fork at a pinned rev with `patches/openipmi-2.0-macos-build.patch` (POSIX unnamed sems / epoll / ether\_\*\_r — all `__APPLE__`-guarded, no-op on Linux). nixpkgs `openipmi` is Linux-only, hence the from-source build (which also ships `sdrcomp`). Power is actuated by the external `chassis_control` hook shelling to `virsh start/destroy/reset`; lanserv also backs SOL onto the VM's qemu telnet console (`derived.console_tcp_port`, wired in `domain.xml.j2`) so `ipmitool sol activate` works — plus SEL/FRU vbmc never had. vbmc/virtualbmc/pyghmi were fully retired.
- **Bridge's NetBox env is all-or-nothing — partial is fatal on cache miss**: `bridge/adapters/netbox/__init__.py` validates `NETBOX_URL` + `NETBOX_TOKEN` together. If only one is set, any cache miss for a device record crashes the discovery-initrd builder. The sim flow assumes BOTH unset: bridge's `device_service.get_device_by_id` is cache-first, and the devenv DAG runs the `sim:seed` task before `fleet:init`'s per-VM discovery prefetch, so every prefetch is a cache hit. If a stray `NETBOX_TOKEN`/`NETBOX_URL` leaks into bridge's env, unset it before running the sim.
- **ipmi_sim runs as root** to bind privileged port 623 (one process per node). The user-context Python uses `sudo -v` once up front (`ensure_sudo_cached`); subsequent `sudo` invocations stay in the cached window. To stop the per-step re-prompting entirely, install the scoped passwordless drop-in once: `devenv tasks run sudo:setup`. The drop-in (generated by `modules/sudo.nix`) routes every generic privileged op through ONE pinned helper, `brokkr-sim-priv` (`devenv/pkgs/sim-priv.{sh,nix}`), invoked via `process_utils.sudo_priv()`; the helper enforces scope **in code** (path containment under the calling user's home, anchored IPv4/pid/unit allowlists), so the sudoers file carries **no argument wildcards** — which makes it valid under **sudo-rs** (Ubuntu 25.10+ defaults `sudo` → sudo-rs, which rejects non-trailing wildcards and would otherwise hang headless `task up` on a prompt). ipmi_sim is launched through the helper's `ipmi-launch` verb (it builds `-c/-f/-s` itself, so a caller can't redirect `-c`); only `socket_vmnet` (macOS) stays a direct rule. `ensure_sudo_cached` no-ops on `sudo -n <helper> noop` (the helper's own do-nothing verb) rather than on the allowlisted `/usr/bin/true` — a sibling checkout's drop-in allowlists that too, so it would report passwordless while this checkout's helper is unauthorised; the drop-in carries no global `secure_path` (the helper absolutizes tools itself). Each drop-in is named `/etc/sudoers.d/brokkr-sim-<helper store hash>`, so checkouts at different revisions are authorised side by side instead of overwriting one another; the rule carries **no `Cmnd_Alias`** because alias names are one namespace across all of `/etc/sudoers.d`, and two drop-ins declaring the same alias collide (sudo keeps the first file parsed, discards the second, and warns on every call, leaving the later checkout unauthorised). `sudo:setup` collects any other `brokkr-sim*` file still on the old alias format, then re-probes the live policy with `sudo -k -n <helper> noop` (the `-k` is load-bearing — the credential it just primed would otherwise satisfy a bare `-n` whatever the policy says). The sweep enumerates `/etc/sudoers.d` unprivileged, so it no-ops where that directory is `0750` (Fedora, Arch); the post-install probe is privileged and still catches a shadowing drop-in there. `devenv tasks run sudo:teardown` reverts it. A `devenv update` rotates the pinned helper store path → re-run `sudo:setup` (one prompt).
- **ipmi_sim's chassis hook needs the user's session libvirt socket** (`qemu+unix:///session?socket=$HOME/.cache/libvirt/virtqemud-sock`), not `qemu:///session` — because under sudo, `session` resolves to root's session, not the user's. `libvirt_uri_for_root()` in `daemons.py` builds the explicit URI and is baked into each node's `lan.conf` chassis_control line.
- **socket_vmnet (macOS only)** — runs as a root daemon, exposes a UNIX socket the rootless qemu instances connect to via `-netdev stream` (QEMU 7.2+). This avoids needing the `com.apple.vm.networking` entitlement on the brew-installed qemu binary. On Linux this whole layer is gone — a flat L2 kernel bridge `br-brokkr` (created by `fleet.ensure_data_plane_bridge` via the sim-priv `bridge-ensure` verb: `ip link add … type bridge` + the gateway IP) handles L2 directly. No libvirt network, no dnsmasq, no DHCP; outbound NAT is provided separately by the `bridge-nat` verb (MASQUERADE out the host uplink).
- **Static netplan match-by-MAC + set-name: eth0** — under PXE we use `virtio-net-pci` (iPXE needs PCI, not MMIO), which triggers systemd predictable network naming (`enp0s2`). A netplan keyed on `eth0:` would silently no-op and leave systemd-resolved without uplink DNS. `seed/netplan.py:sim_static_netplan` matches by `data_mac` and uses `set-name: eth0` so downstream code that assumes that name keeps working.
- **`network.rendered_netplan: true` swaps that seeded override for the hub's renderer** (see README). It is single-zone-only — the schema rejects multi-zone because every zone shares one org and one `cidr`, so their primary prefixes are indistinguishable to the hub's planner and every device would fall back to DHCP. The rendered netplan carries no `set-name`, but the NIC still ends up `eth0`: the spoke derives `ifname=eth0:<mac>` kernel params from the netplan block key + `match.macaddress`.
- **Apple bootpd auto-spawns on the data-plane bridge (macOS only).** `fleet:up` writes `/etc/bootptab` from the fleet's MAC→IP map as a fallback. In normal operation no DHCP fires: the static netplan in `device.netplan` is what binds eth0 in both brokkr-live and the installed customer OS. bootpd is impossible to replace without SIP surgery (Apple's vmnet auto-spawns it), so bypassing DHCP entirely via the static netplan is the right path. On Linux there is no DHCP at all — `br-brokkr` is a plain L2 bridge (no dnsmasq), VMs get their IP from the same static netplan, and no `/etc/bootptab` is written.
- **Overlays are sparse raw `.img` on APFS, not qcow2.** qcow2's `discard='unmap'` leaks partial-cluster boundaries (LP#1884831 / qemu issue #1621). Raw on APFS routes `blkdiscard` through `FALLOC_FL_PUNCH_HOLE`; reads from filesystem holes are guaranteed zero, so `/dev/sda` passes bridge's wipe verifier.
- **SSD presentation on the OS disk**: `<target ... rotation_rate='1'/>` + `<driver ... discard='unmap' detect_zeroes='unmap'/>` in `domain.xml.j2`. Sets SCSI INQUIRY VPD page 0xB1 "non-rotating" bit, so `/sys/block/sda/queue/rotational = 0` and bridge classifies it as SSD → takes the fast `blkdiscard` wipe path.
- **SCSI serial + WWN must match across four places**: `derived.node_serial(mac)` / `derived.node_wwn(mac)` are seeded into (a) the libvirt `<serial>`/`<wwn>` elements, (b) the Bridge Redis device record, (c) `Hub.Server.storageLayouts` + `Hub.StorageDrive` rows, and (d) what bridge reads via `lsblk -o NAME,SERIAL,WWN` inside the guest. Mismatch in any pair → bridge's `prepare_storage` step fails with "At least one disk group is required." All four derive deterministically from `ipmi_mac`.
- **brokkr-app MTI split (Device → Server)**: `Server` is a multi-table-inheritance child of `Device`, joined on `Server.deviceId = Device.id`. Post-migration the listing/storage/pricing columns moved to `Server`. Two lifecycle axes now: `Device.status` (DeviceStatus enum, `{PLANNED, STAGED, ACTIVE, MAINTENANCE}` — coarse, role-agnostic) and `Server.lifecycleStatus` (ServerLifecycleStatus enum, `{INVENTORY, PROVISIONING, PROVISIONED, OFFLINE, FAILED, DEPROVISIONING}` — operational, server-only). The hub writes server-extension fields to `Server` only. `Device.storageLayouts`, `Device.netplanOverride` (for server-role rows), and `Device.isListed` are frozen archive columns; brok-local seeds the canonical `Server.*` only.
- **Hub `Job.status` skips `Pending` / `InProgress` in practice.** The Prisma enum defines them but Hub writes jobs already at `Completed` or `Failed`. The spoke `/api/chain` Deprovision branch gates on `Device.status='DEPROVISIONING'` (durable for the saga lifecycle), not `Job.status`.
- **Re-running Provision via Hub UI Retry vs. Reprov**: a Hub UI "Retry" of a failed Provision creates a new Job row with `jobType=Provision` (NOT `Reprovision`). The spoke `/api/chain` `Device.status` + GPT logic still handles this correctly — what matters is the device's lifecycle state and disk contents, not the job type. `<kernel>` is fixed (always the iPXE binary).
- **Default SSH user on the installed customer OS is `ubuntu`, not `root`.** The spoke's `deploy_os` cloud-init writes the customer's pubkey to `/home/ubuntu/.ssh/authorized_keys`, not `/root/.ssh/authorized_keys` — opposite of brokkr-live (where `root` is the user). When SSHing into a _provisioned_ sim, use `ssh ubuntu@192.168.200.10`, then `sudo` for anything privileged. brokkr-live (discovery phase) still takes `ssh root@...`.
- **Discovery initrd identity: `Device.id` (UUID), not netboxId.** The spoke's render contract for `/api/initrd/brokkr-discovery-{X}.img` uses the Hub Postgres `Device.id` UUID as `{X}`, not the integer netboxId. The atom-shaped Bridge Redis device record is also UUID-keyed (`{zone}:device:{Device.id}:device_record`) on the edf branch — both layers agree on UUID now. `fleet.py:_node_device_ids()` joins fleet.yml ↔ Hub by BMC IP to get the UUID at `cmd_init` time.
- **`BROKKR_PATH` in `.env` is stale.** The old `brokkr:init` task that consumed it is gone; the hub install + Prisma migrate now run as devenv tasks (`modules/hub.nix`) that read `$HUB_REPO_PATH` (path to the hub checkout). Safe to remove from `.env` — nothing reads `BROKKR_PATH` anymore.

## Where to put new code

- New fleet config field → `schema.py` (`Defaults` + `NodeRaw` + `Node` + the `nodes` property in `Fleet`) → test in `tests/test_schema.py`. The devenv layer needs no change to accept it — the per-node `freeformType` in `modules/fleet-topology.nix` passes unknown keys straight through; set it in the `config.fleet` base of `modules/fleet-topology.nix` or a `devenv.local.nix` overlay. To change the default _value_ shipped to everyone, edit that base, not a Python default.
- New default fleet topology change (node count, sizing, network planes) → the `config.fleet` base in `modules/fleet-topology.nix`. Per-host experiments → `devenv.local.nix` (deep-merged overrides). The control center's Fleet builder writes its edits to the `stack.local.nix` overlay (config.fleet), applied on Fleet rebuild.
- New install-layout constant, daemon binary path, or env-driven config → `config.py` as a pydantic-settings sub-model field with the appropriate env prefix.
- New **platform-specific path or auto-detection** (e.g. where qemu/EDK2 live, libvirt URI shape) → `host_os.py` as a `detect_*()` function; wire it into `config.py` via a lazy adapter (see `_libvirt_uri()` and `_detect_edk2_*()` in `config.py` for the pattern).
- New derived value that depends on a `Node` or `Fleet` → `derived.py` as a pure function → test in `tests/test_derived.py`.
- New template variable → render context in `render.py` + template change in `templates/` → test in `tests/test_render_domain.py` (or `test_render_bootptab.py` for the bootpd path). If the new behavior diverges by `host_os` / `host_arch`, gate it inside the Jinja template — those vars are already in the render context.
- New orchestration step → `fleet.py` as a function called from `cmd_up`/`cmd_down`/`cmd_nuke`. If it seeds Hub state, prefer a SQL generator (see below) instead.
- New Hub Postgres **read** → `stores.py` `HubDB` typed client; don't shell out to `psql` for reads. Bridge Redis device records are synthesized by the spoke from Hub state — the sim doesn't read Redis from Python. Seed **writes** are the exception — they go through the SQL generators (below), applied via `psql`.
- New sim-side tooling that joins fleet.yml ↔ Hub ↔ Bridge cache → its own module under `scripts/local/`; expose it as a `sim:*` operator verb in the root `Taskfile.yml` if it's interactive, or a devenv task if it's part of the bring-up DAG.
- New artifact the spoke needs from the Hub-seeded record → emit the column in the relevant generator's SQL (usually `sql-seed/50-devices.py`). The spoke synthesizes its own Redis device record from Hub state — don't vendor its Jinja templates locally.
- New Hub-side column the seed must write → emit it in the relevant `sql-seed/NN-*.py` generator (and read it back, if needed, via a `stores.py` `HubDB` method).
- New seed step (org-wide / identity / catalog / per-device) → add a generator `sql-seed/NN-name.py` that **prints idempotent SQL to stdout** (`INSERT … ON CONFLICT`; resolve FKs via subqueries); the runner picks it up by numeric prefix. Pure data shapers (no I/O) live in `scripts/local/seed/` as functions the generator imports. Add an offline shape test in `tests/test_sql_generators.py`.
- New env var the hub process needs at startup → `modules/hub.nix` (its per-process `environment`); spoke env → `modules/spoke.nix`. Anything that ALWAYS overrides (like `HYDRAHOST_ORGANIZATION_ID` to the static UUID) belongs there, not in `.env`.
- New datastore (e.g. a third one) → a `services.*` in `devenv.nix` (native devenv service), with its readiness probe wired into the DAG (mirror `services.postgres`/`redis`). There is no docker-compose for datastores.
- New subprocess invocation → use the wrappers in `process_utils.py` (`run` / `sudo` / `virsh` / `cmd_succeeds`). Don't call `subprocess.run` directly.
- New env-driven knob the user might want to inspect → it'll show up in `task local:config` automatically as long as it's a pydantic-settings field; secrets get masked unless `--show-secrets` is passed.
- New orchestration (a bring-up step, process, or datastore) → devenv (`devenv.nix` + `modules/*.nix`) as a task/process, not a Taskfile verb. A new **interactive operator verb** (console/test/BMC/inspection) → the root `Taskfile.yml` under the `sim:` namespace; match the existing naming scheme (`sim:fleet:* | sim:node:* | sim:ipmi/redfish`).
- New CLI message → `log.info` / `log.warn` / `log.error` etc. from `local.logger`. Don't add `print()` calls.

## Comment style

Default to no inline comments.

- **Function-level docstrings** carry behavior + non-obvious invariants. If an "Ordering constraints" section is needed (because a call sequence has real dependencies — e.g. the sim seed (the `sim:seed` devenv task) precedes `_node_device_ids` + `prefetch_node_discovery_initrd` so the seeded Device rows exist when the join + prefetch run; BMC loopback aliases exist before `start_ipmi_sim` binds `bmc:623`), put it there in the _enclosing_ function's docstring, not as inline `#` blocks above each call.
- **Callee docstrings** carry the "why X exists" for each helper. Don't restate that at the call site.
- **`log.info()` lines** narrate the runtime pipeline. They make the call sequence observable without needing explanatory comments above each step.

If you find yourself wanting to write a multi-line `#` block above a call, the explanation belongs in the _called_ function's docstring (where it's reusable), or — if it's a sequencing rule — in the enclosing function's docstring under "Ordering constraints".
