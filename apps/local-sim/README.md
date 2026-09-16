# sim — the simulator engine

The Python engine that simulates bare-metal servers (libvirt + qemu VMs, each with its own IPMI/OpenIPMI `ipmi_sim` + Redfish/`sushy-emulator` BMC) so Hydra's bare-metal orchestration — the **hub** + the **spoke** — can be developed and tested against the full provision → power-cycle → reprovision → deprovision lifecycle, with no real hardware.

**Cross-platform**, auto-detected per host:

- **macOS** (Apple Silicon) — qemu with HVF acceleration, data plane over `socket_vmnet`.
- **Linux** (x86_64 / arm64) — qemu with KVM, data plane over a flat L2 kernel bridge (`br-brokkr`; no libvirt network / dnsmasq / DHCP). The host bootstrap installs the OS-level virt stack on Debian/Ubuntu (apt), Fedora/RHEL (dnf), and Arch (pacman).

Cross-arch (forcing a non-host `arch` in `fleet.yml`) falls back to TCG emulation — functional but ~10–30× slower.

> This is the engine. The web cockpit that drives it lives in `../apps/` and comes up with the rest of the stack under **`task up`** (it runs as devenv processes — see [Control center](#control-center-the-web-cockpit) below). For engine internals beyond this overview, **`ARCHITECTURE.md` (next to this file) is the reference**: it has the boot/IPMI/data-plane diagrams.

## What it gives you

For every node in `fleet.yml`, over both IPMI and Redfish:

- `power on` / `power off` / `power status` / `chassis power reset` (note: `power cycle`/0x02 is **not** implemented — use `reset`/0x03)
- `chassis bootdev pxe|disk` — ipmi_sim's chassis hook persists the bootdev for the bridge's set-then-verify round-trip; what actually boots is decided server-side by the spoke's `/api/chain` (see [Bridge lifecycle compatibility](#bridge-lifecycle-compatibility))
- A booted brokkr-live (discovery) OS reachable over SSH from the host directly (`ssh root@192.168.200.10`)
- A provisioned customer OS reachable as `ssh ubuntu@192.168.200.10` (the installed-OS user is `ubuntu`, not `root`)
- SSD-class disk wipe: `/dev/sda` reports non-rotational, so bridge takes the fast `blkdiscard` path

The spoke drives **provision**, **reprovision**, and **deprovision** end-to-end against this env, including the post-`deploy_os` reboot into the freshly-installed customer OS.

## Prerequisites

- **libvirt/qemu** (macOS: Apple Silicon; Linux: a host that can run KVM). The bootstrap installs the OS-level virt stack for you. (Docker is used on both macOS and Linux, for the grub-build / iPXE-build containers — the bootstrap skips installing it when one is already present. The iPXE build also needs the `docker buildx` plugin, which the Linux `docker.io` package does not install. The bootstrap installs the plugin, or links the Nix-pinned one when no distribution package exists.)
- A checkout of this monorepo — it holds both the hub and the spoke. `HUB_REPO_PATH` points at it and defaults to the checkout the sim lives in, so a normal clone needs no configuration.

Everything else — the Node/pnpm/Python/uv/go-task toolchain — comes from the **devenv** (a declarative reproducible env). You don't install it by hand.

```bash
bash provisioning/bootstrap.sh   # idempotent host bootstrap: installs Nix + direnv, auto-appends the
                                 # direnv shell hook to your rc, auto-runs `direnv allow` on the repo,
                                 # and installs the privileged OS virt stack. The toolchain comes from devenv.
exec $SHELL                      # fresh shell so the direnv hook loads
cd <repo root>                   # direnv auto-loads devenv, building the toolchain (first time is slow)
```

No manual rc editing, no manual `direnv allow`. On a truly fresh machine the only sudo prompts are the unavoidable two (system-package install + the NOPASSWD drop-in `task up` installs), then never again. Re-run the bootstrap later with `task sim:setup`.

> The IPMI BMC is OpenIPMI `ipmi_sim`, a top-level Nix package (`devenv/pkgs/openipmi.nix`) resolved via `LOCAL_IPMI_SIM_BIN` — not a python dep, so `uv sync` doesn't touch it.

## Quickstart

The canonical bring-up is **one command** (repo root, inside the devenv shell) — it does datastores + hub + spoke + seed + fleet, supervised by process-compose (no tmux session). It is hermetic — no secrets provider, every secret resolving from `secretspec.toml`'s `local` profile defaults.

```bash
task up          # idempotent host bootstrap (once) + passwordless sim sudo, then `devenv up -d`.
task status      # process list + the fleet status table
task logs        # process-compose overview TUI (status/health + per-process logs)
task down        # tear it all down (the fleet's shutdown hook runs its teardown)
```

The bring-up DAG and the devenv layout are declared in `devenv.nix` and `devenv/modules/`. See [`devenv/README.md`](../../devenv/README.md) for the operator reference.

The **fleet** (the sim VMs) is a single supervised process named `fleet` — it builds artifacts + powers on the VMs, and tears them down on stop. A `fleet.autoStart = false` knob in `devenv.local.nix` gives a control-plane-only bring-up; start the fleet on demand from the control center UI or:

```bash
process-compose -U -u "$PC_SOCKET_PATH" process start fleet   # build artifacts + render XMLs + start daemons + auto-power-on the VMs
process-compose -U -u "$PC_SOCKET_PATH" process stop fleet    # tear the fleet down (ipmi_sim/sushy + undefine)
curl -s localhost:3002/api/status | jq   # per-node libvirt + ipmi_sim + sushy state (or use the lab-web Status tab)
```

Power a node (three equivalent ways) and SSH in (data-plane IP is deterministic per `fleet.yml` index — `cpu-1`=.10, `cpu-2`=.11, …):

```bash
task sim:ipmi    -- cpu-1 chassis power on   # via ipmi_sim (the path the spoke exercises)
task sim:redfish -- cpu-1 power-on           # via sushy-emulator (HTTP Redfish)
virsh --connect qemu:///session start cpu-1     # straight to libvirt (qemu:///system on Linux)

ssh root@192.168.200.10                         # brokkr-live (discovery phase)
ssh ubuntu@192.168.200.10                       # provisioned customer OS
```

## Control center (the web cockpit)

The **web cockpit** that drives the stack — power/console the VMs, run the lifecycle tests, review results — runs as **devenv processes** (`lab` :3002, `lab-web` :5175). It comes up with everything else under `task up`; you don't bring it up separately. It drives the stack over the process-compose REST API + direct sim-engine calls (not by shelling out to `task`).

The web and the API bind loopback (`127.0.0.1`) by default, so the cockpit answers at `http://localhost:5175` and nowhere else. The `lan.mode` knob is what moves those listeners onto the network, and each mode carries a different cost — see the [security posture](../local-lab/README.md#security-posture-read-this) before you change it. `HUB_REPO_PATH` is read from the repo-root `.env` (or `.envrc.local`) and defaults to this checkout. See the repo-root `README.md` for how the cockpit is wired.

## How the stack lays out

```
Dev host (macOS Apple Silicon, or Linux x86_64/arm64)
├── Datastores (native devenv services — services.postgres/redis, no docker)
│   ├── postgres  :5432   ← Hub DB
│   ├── redis     :6379   ← Bridge Redis (zone-namespaced keys)
│   └── nginx             ← OS-layer cache (services.nginx)
├── Hub      ($HUB_REPO_PATH)         ← api :3000, admin :3001, web :5173, web-admin :5174
├── Spoke(s) (same checkout)     ← one per bridge ordinal; zone 0 bridge 0 on :8000
├── libvirt + qemu               ← one <domain> per node — HVF on macOS, KVM on Linux
├── ipmi_sim (root)              ← one process per node, IPMI on 192.168.105.10+:623 (lo0/lo alias)
├── sushy-emulator (user)        ← one Redfish endpoint per node on 192.168.105.10+:8000
└── data plane                   ← macOS: socket_vmnet + Apple bootpd; Linux: flat L2 kernel bridge 'br-brokkr'
```

Two planes, both host-routable:

- **BMC plane** (`bmc_cidr`, default `192.168.105.0/24`) — loopback alias IPs (lo0 on macOS, lo on Linux). Pure loopback; ipmi_sim + sushy bind here.
- **Data plane** (`cidr`, default `192.168.200.0/24`) — host-routable bridge. Each VM's data NIC gets a static IP from a match-by-MAC netplan baked into BOTH the discovery initrd AND the installed-OS cloud-init `network-config` (both sourced from `device.netplan` in Bridge Redis, which the spoke synthesizes from the Hub-seeded `Server.netplanOverride`). No DHCP fires.

#### `network.rendered_netplan` — exercise the hub's netplan renderer

Default `false`: the seed writes `Server.netplanOverride` and the hub skips publishing the netplan
atom, so the guest's address comes from a static file the sim controls end to end.

Set `true` and the sim stops short-circuiting the renderer — the override is not written (so
`NetplanService` falls through to `renderNetplanYaml`), `46-prefixes` seeds a real `Gateway` on the
primary prefix so a default route can resolve, and the hub publishes the atom for real. Use it to
diff rendered output against the known-good static netplan on the same fleet.

Two constraints:

- **Single-zone only.** Every zone shares one org and one `cidr`, so a multi-zone fleet seeds
  indistinguishable primary prefixes and the hub resolves none of them — the schema rejects the
  combination rather than letting the fleet silently fall back to DHCP.
- **The guest NIC is still renamed to `eth0`,** even though the rendered netplan carries no
  `set-name`. The spoke derives `ifname=eth0:<mac>` kernel params from the netplan block key plus its
  `match.macaddress` (`bridge/src/bridge-network/netplan-to-kernel-params.service.ts`), and the seed
  names the DB interface `eth0`.

### Boot path: iPXE direct-load → spoke `/api/chain`

There's no firmware-side PXE/TFTP and no Redfish virtual media. Each VM's libvirt XML has `<kernel>{state}/boot/<arch>/ipxe-<name>.efi</kernel>` — qemu direct-loads a **per-VM iPXE binary** at power-on. That binary's embed script brings up the NIC with its static IP and then **chains to the spoke**:

```
chain --autofree ${base}/api/chain##params
```

`${base}` is the spoke URL with `127.0.0.1` rewritten to the data-plane gateway (the VM's localhost isn't the host's — see `pxe._vm_reachable_bridge_url`); `##params` passes platform/arch/ip/mac/serial/ipmi\_\* to the spoke. **The spoke's `/api/chain` decides what to boot** — discovery (kernel + Ubuntu base initrd + `brokkr-discovery-{Device.id}.img` + `brokkr-live.img`) or, for a provisioned device, grub-from-disk (`/api/grub`). The kernel cmdline and initrd layer order live server-side, not in the embed script.

**Discovery initrds are keyed by `Hub.Device.id` (UUID)** — `brokkr-discovery-{UUID}.img`. `fleet.py:_node_device_ids()` joins `fleet.yml` ↔ Hub by BMC IP to resolve each node's UUID at `fleet:init` time.

The per-VM iPXE binary is always direct-loaded as `<kernel>` and is never stripped — the boot decision is made server-side by the spoke's `/api/chain` from `Hub.Device.status` + the GPT on disk: inventory → discovery → brokkr-live; provisioned → grub-from-disk → `/dev/sda` (installed OS). ipmi_sim's chassis hook only persists the IPMI bootdev for the round-trip. See [Bridge lifecycle compatibility](#bridge-lifecycle-compatibility).

State (overlays, prefetched boot artifacts, rendered XMLs, NVRAM, pidfiles, logs, per-VM iPXE binaries) lives under **`~/.local/share/local/`** (override with `LOCAL_STATE`). The native-built `brokkr-live.img` / `bridge-agent.img` land under `/tmp/brokkr-dev/initrd-builds/` (override via `persistent_storage`).

**For the full picture** — boot pipeline, IPMI routing, the ipmi_sim chassis-hook decision matrix, the data-plane/DHCP story — see [ARCHITECTURE.md](ARCHITECTURE.md).

## Configuration

### Fleet topology

The topology — nodes, defaults, and the two planes — is **declared in `modules/fleet-topology.nix`** (the committed base in its `config.fleet` block) and **rendered to a `fleet.yml`** the engine reads (`LOCAL_FLEET_PATH`); there's no hand-edited `fleet.yml` in the tree. Override per host in `devenv.local.nix` (deep-merged — `fleet.zones."sim-zone".nodes.cpu-1.memory_mb = 16384;`) or from the control center's Fleet builder; see [`devenv/README.md`](../../devenv/README.md) for the override layers. The schema and the render pipeline live in `modules/fleet-topology.nix` and `devenv/modules/fleet.nix`.

Each node has **two MACs**: `ipmi_mac` (BMC NIC — stable identity; seeds Redfish UUID + SCSI serial/WWN) and `data_mac` (customer-facing NIC — virtio-net-pci, what bootpd matches). They must differ (mnemonic: `bc` octet = BMC, `da` octet = DAta). `arch` omitted ⇒ host arch. Default fleet is `cpu-1..cpu-4`. The rendered `fleet.yml` the engine validates looks like:

```yaml
network:
  cidr: 192.168.200.0/24 # data plane
  bmc_cidr: 192.168.105.0/24 # BMC plane
defaults:
  cpus: 2
  memory_mb: 2048
  disk_gb: 40
  bmc: { username: admin, password: admin }
nodes:
  - { name: cpu-1, ipmi_mac: '52:54:00:bc:00:01', data_mac: '52:54:00:da:00:01' }
  - { name: cpu-2, ipmi_mac: '52:54:00:bc:00:02', data_mac: '52:54:00:da:00:02' }
  # …
```

### Spoke endpoint & zones

The spoke runs locally; zone 0 bridge 0 is `http://127.0.0.1:8000`. Zones are declared in `fleet.zones` (`devenv/modules/fleet-topology.nix`, overridable from the control center's Config → Zones page), each with its own `bridges` count. Every bridge takes the next ordinal in a shared band and gets its own HTTP/gRPC port (`8000+i` / `9082+i`) and Redis namespace; each node names its zone. One zone at index 0 with one bridge and the canonical name renders byte-identically to the historical single-zone setup. Override the endpoint only for non-default ports / container networks (`BRIDGE_ENDPOINT=...`).

There is no remote-bridge mode — no `BRIDGE_LOCAL` toggle, no `certs/` plumbing, no PKI minting.

### Spoke environment

The spoke must run with `LOCAL_SIMULATION_ENABLED=true`, which flips two behaviors:

1. `phone_home_endpoint` → `http://192.168.200.1:3000/api/v1/bmc/phone-home` (data-plane gateway, the local hub).
2. The cpio packer appends `-R 0:0` so files in discovery initrds are owned by UID 0 — required because the spoke runs as the dev user and sshd's `StrictModes yes` rejects an `authorized_keys` not owned by root.

**SSH key:** set `BRIDGE_SSH_PRIVKEY_PATH=$HOME/.ssh/id_ed25519` (or wherever) — the spoke bakes the `.pub` into the discovery initrd's `/root/.ssh/authorized_keys`. Without it, root SSH from the spoke hangs `wait_for_brokkr_live`.

## Seed — Hub Postgres state the provision saga reads

The seed is **generator-driven SQL**, not Python writes. The `sim:seed` devenv task runs the `sql-seed/NN-*.py` generators — each prints idempotent `INSERT … ON CONFLICT` SQL to stdout — captures it to `_generated/`, and applies static + generated SQL in numeric order via `psql`. The DAG runs it **after the hub is up** (the org bootstrap must exist) and **before `fleet:init`** (which needs the seeded Device rows for its BMC-IP join + per-VM prefetch); run it on demand via `devenv tasks run sim:seed` or the control center "Seed DB" op. **`fleet:init` does not seed** — seeding is a DAG concern.

The seed writes **Hub only** — the spoke synthesizes its own Bridge Redis device record from Hub state on-miss (no Redis write in the seed). What it lands per device: `Device` (role=`Server`, `status=ACTIVE`) + a paired empty `Server` (`lifecycleStatus=INVENTORY`) + `Server.storageLayouts` + `Server.netplanOverride` + `StorageDrive`, plus a `Zone`, the OS catalog, SSH keys, and a listing.

**The org/owner identity is created by the hub, not the seed** — there is no Azure AD in sim. `$HUB_REPO_PATH/apps/api/src/main.admin.ts:bootstrapAdminUsers` (gated on `LOCAL_SIMULATION_ENABLED=true`) runs on admin-app startup: it upserts the static sim org `00000000-0000-0000-0000-000000000000` + `FeatureFlags`, and signs up `brokkr@brokkr.local` / `brokkr` as **Owner** via better-auth. Wiping the Postgres volume is safe — the hub re-bootstraps on every start. The `30-ssh-keys` generator attaches your `~/.ssh/*.pub` to that owner (the provision validator requires ≥1 key).

The seed generators under `sql-seed/` are the checklist of rows the saga reads. Each one names the precondition it satisfies.

## SSH access

```bash
export BRIDGE_SSH_PRIVKEY_PATH=$HOME/.ssh/id_ed25519   # in the spoke's environment
```

The spoke reads `$BRIDGE_SSH_PRIVKEY_PATH.pub` and packs it (UID 0) into the discovery initrd's `/root/.ssh/authorized_keys` — so the same key reaches brokkr-live from both the host and the spoke. Your `~/.ssh/*.pub` keys (attached to the owner by the seed) are what land on the **provisioned** OS (`/home/ubuntu/.ssh/authorized_keys`). Change the key ⇒ restart the `fleet` process (`process-compose -U -u "$PC_SOCKET_PATH" process restart fleet`) to rebuild the discovery initrd.

## Bridge lifecycle compatibility

| Bridge saga / step                            | Status | Notes                                                                                                                       |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| IPMI `power on/off/reset/status`              | ✅     | ipmi_sim → virsh chassis hook                                                                                               |
| IPMI `chassis bootdev pxe/disk`               | ✅     | ipmi_sim persists it for the round-trip; what boots is decided by the spoke's `/api/chain`                                  |
| Redfish `Systems/.../Reset`                   | ✅     | sushy-emulator                                                                                                              |
| SSH disk wipe / partition / curtin install    | ✅     | `/dev/sda` reports SSD → fast `blkdiscard` path                                                                             |
| Provision saga (Inventory → installed Ubuntu) | ✅     |                                                                                                                             |
| Reprovision saga                              | ✅     | works from both "installed Ubuntu" and "brokkr-live" starting states                                                        |
| Deprovision saga (back to brokkr-live + wipe) | ✅     | spoke `/api/chain` reads `Hub.Device.status='DEPROVISIONING'` → discovery chain + wipe                                      |
| Redfish vendor BIOS / TEE config              | ❌     | sushy doesn't emulate vendor BIOS endpoints — bridge skips/501s; doesn't block provision                                    |
| IPMI SOL activate                             | ✅     | ipmi_sim backs SOL onto the VM's qemu telnet console (`ipmitool sol activate`); `task sim:node:console` still tails the log |

The chain-driven boot decision (ipmi_sim's chassis hook + the spoke's `/api/chain`) is documented in `ARCHITECTURE.md §4`.

## Tasks reference

Orchestration is the **root** Taskfile's lifecycle verbs (run from the repo root, in the devenv shell); they wrap devenv. The engine's interactive **operator verbs** also live in the root Taskfile, under the `sim:` namespace — reach them with `task sim:<verb>`.

```bash
# Root verbs (orchestration) — repo root, in the devenv shell
task up                       # canonical bring-up: host bootstrap (once) + sudo + `devenv up -d`
                              # (datastores + hub + spoke + control center + seed + fleet)
task down                     # stop everything (the fleet's shutdown hook runs its teardown)
task reset                    # DESTRUCTIVE: down + wipe datastore data + fleet overlays
task status                   # process list + the fleet status table
task logs                     # process-compose overview TUI (status/health + per-process logs)

# Fleet + seed + restarts (devenv, or the control center UI)
process-compose -U -u "$PC_SOCKET_PATH" process start|stop|restart fleet   # power the VMs on / tear down / cycle
process-compose -U -u "$PC_SOCKET_PATH" process restart hub-api            # restart one component (hub-admin / hub-web / spoke / …)
devenv tasks run sim:seed                   # generator-driven Hub Postgres seed (on demand)

# Operator verbs (task sim:<verb>)
task sim:setup                     # re-run the host bootstrap (deps, patches)
task sim:fleet:nuke                # fleet down + delete overlays + sushy configs + NVRAM
task sim:fleet:consoles            # tmux window, one pane per VM tailing its serial log
task sim:fleet:shells / dash       # SSH-shell panes / combined consoles+shells dashboard
task sim:node:console NAME=cpu-1
task sim:ipmi    -- cpu-1 chassis power on
task sim:redfish -- cpu-1 power-cycle
task local:config [-- --show-secrets]   # print resolved Settings (env + .env + defaults)

# Status + build verbs are covered by the lab API (lab-web Status/Build tabs):
#   curl localhost:3002/api/status                            # fleet status
#   curl -X POST localhost:3002/api/build/agent               # rebuild brokkr-live.img
#   curl -X POST localhost:3002/api/build/netboot-grub        # rebuild grub binaries

# From the devenv shell — the toolchain is on PATH
pytest tests/                 # engine unit tests
ruff check scripts tests
```

## Layout

```
(fleet.yml)                        # NOT committed — rendered from modules/fleet-topology.nix (LOCAL_FLEET_PATH)
provisioning/
  bootstrap.sh                     # Nix-first host entry (macOS inline; sources the Linux helper)
  linux-bootstrap.sh               # sourced linux_host_packages() — Linux system virt stack + residue
                                   # (the OpenIPMI macOS build patch lives in devenv/patches/, applied by openipmi.nix)
scripts/
  tasks/                           # bash helpers behind the operator verbs (sql-seed-run.sh, ipmi.sh, …)
  local/                           # the Python orchestration package (import as `local.*`)
    schema.py                      # Pydantic Fleet model (dual ipmi_mac/data_mac)
    config.py                      # pydantic-settings config (state/paths/bridge/sim/stores)
    host_os.py                     # cross-platform detection (libvirt URI, EDK2, qemu emulator)
    derived.py                     # Node/Fleet → IPs, UUIDs, SCSI serial/WWN
    zones.py                       # multi-spoke zone derivation (UUID/name/ports by index)
    render.py / render_all.py      # fleet → libvirt XML + /etc/bootptab via Jinja
    pxe.py                         # per-VM iPXE EFI binary builder (docker buildx + embed script)
    fleet.py                       # main CLI — `python -m local.fleet {init,up,down,nuke}`
    daemons.py                     # socket_vmnet (macOS), ipmi_sim, sushy lifecycle
    prefetch.py                    # warm each spoke's cache (per-VM brokkr-discovery-{UUID}.img)
    live_initrd.py                 # native cpio build of brokkr-live.img + bridge-agent.img
    grub_build.py                  # grub boot-from-disk binaries (spoke serves at /api/grub)
    stores.py                      # Hub Postgres + Bridge Redis READ clients (HubDB, BridgeRedis)
    admin_api.py                   # authenticated client for the Hub admin API (:3001)
    sqlemit.py                     # SQL-literal helpers for the generators (q / qj / header)
    seed/                          # pure shapers imported by the generators
      netplan.py / storage.py / ssh_keys.py / os_catalog.py
    process_utils.py               # central subprocess wrappers (run/sudo/virsh/cmd_succeeds)
    show_config.py / status.py / logger.py
sql-seed/                          # generator-driven Hub seed (the sim:seed devenv task)
  20-lifecycle-change-notify.sql   # static — pg_notify triggers for the e2e timeline
  30-ssh-keys.py 40-os-catalog.py 45-zone.py 50-devices.py 60-listing.py
templates/domain.xml.j2            # cross-platform libvirt domain (hvf/kvm, macos/linux)
tests/                             # pytest — schema, derived, render, sql generators, config; e2e/ lifecycle
```
