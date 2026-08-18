# Local-dev environment (devenv)

The operator reference for Brokkr's in-repo local-dev stack: a **`devenv`/Nix + `direnv` + `process-compose`** environment that brings up the datastores, the hub and spoke, a web control center, and a **simulated device fleet** (libvirt/qemu guests with `ipmi_sim`/`sushy` BMCs) — no real hardware.

> **First time here?** The from-scratch walkthrough (install the toolchain → `task up`) lives in the root [`README.md`](../README.md). This guide is the deeper reference: how the environment is wired, the override/config layers, secrets & profiles, platform specifics, and troubleshooting. For the simulator engine's internals see [`apps/local-sim/CLAUDE.md`](../apps/local-sim/CLAUDE.md); for architecture diagrams see [`docs/architecture.md`](../docs/architecture.md).

## Where things live

The devenv lives **inside the brokkr-app monorepo**. The declarative entrypoints sit at the **repo root**; only the modules, packages, and helper scripts are under `devenv/`:

```
brokkr-app/
├── devenv.nix  devenv.yaml  devenv.lock   # the declarative environment (toolchain + native
│                                          #   datastores + processes) + pinned inputs
├── .envrc                                 # direnv: eval "$(devenv direnvrc)"; use devenv
├── Taskfile.yml                           # lifecycle verbs (task up/down/local:reset/sim:* …)
├── secretspec.toml                        # the app-config secrets contract (profiles)
├── devenv.local.nix                       # (gitignored, optional) your Nix overrides
├── stack.local.nix                        # (gitignored, optional) control-center-written overrides
├── devenv/
│   ├── modules/   # the bring-up DAG, the port map, the sudo drop-in, the fleet topology,
│   │              #   the override seam, the hub/spoke units, profiles, git hooks
│   ├── pkgs/      # sim runtime pkgs as derivations (openipmi ipmi_sim + sushy + socket_vmnet)
│   ├── lib/       # reap-stale shell helper (stack-orphan reaper)
│   └── README.md  # this file
└── apps/
    ├── api/  bridge/  live-agent/  web/  …  # the product (hub, spoke, agent, …)
    ├── local-sim/        # the Python simulator engine (Taskfile, scripts, sql-seed, templates)
    ├── local-lab/        # control-center API — NestJS + ts-rest (:3002)
    └── local-lab-web/    # control-center web — Vite + React + TanStack (:5175)
```

The control center is a standard fullstack **api + web split** (`apps/local-lab` + `apps/local-lab-web`), mirroring the hub's `apps/api` + `apps/web`. The simulator engine `apps/local-sim` is a Python workspace app.

## Prerequisites

- **libvirt/qemu** (Linux: KVM; macOS: Apple Silicon). On a fresh machine the bootstrap installs the OS-level virt stack for you — on **Linux** that's apt/dnf/pacman + systemd (one re-login so the `libvirt`/`kvm`/`docker` groups take effect); on **macOS** you also need Docker Desktop _running_ (the fleet's iPXE build uses it).
- A checkout of the **brokkr-app monorepo** — it contains the hub (`apps/api`), the spoke/bridge (`apps/bridge`), `apps/live-agent`, etc. The location is the `config.polyrepo` seam: `config.polyrepo.hub.path` (`devenv/modules/polyrepo.nix`) **defaults to empty, which means _this repo_** (resolved to `config.devenv.root`). You only set it for a polyrepo layout where the hub code lives elsewhere — via `config.polyrepo.hub.path` in `devenv.local.nix`, or `HUB_REPO_PATH` in `.env` / `.envrc.local` (see [Configuration](#configuration)). `task local:setup` clones it if missing.

Everything else — the Node/pnpm/Python/uv/go-task toolchain — comes from the **devenv**. You don't install it by hand. See the root [`README.md`](../README.md) for the one-time `bootstrap.sh` + `task local:setup` onboarding.

On a machine with nothing on it, the root [`install.sh`](../install.sh) does all of the above in one command — it installs `git`, runs `bootstrap.sh`, and then drives `task local:setup` + `task up` through `devenv shell` (there is no login shell yet, so the direnv hook isn't loaded):

```bash
curl -fsSL https://raw.githubusercontent.com/Hydra-Host/Brokkr/master/install.sh | sh
```

It streams devenv's own phase markers while it builds, so a long first run names the step it is on rather than going silent, and it passes `--no-tui` to every `devenv` call (devenv enables its interactive TUI whenever stdout is a terminal, which a scripted install must not opt into). `BROKKR_PROGRESS_INTERVAL` tunes the idle ticker and `BROKKR_VERBOSE=1` shows devenv's unfiltered `-v` output. Every run logs to `~/.local/state/brokkr-local/logs/` (`latest.log` is the newest, 10 are kept) — that file always holds devenv's full output, including the lines the terminal view drops, so read it first when a build fails. `--log` moves it and `--no-log` disables it.

Point it at another remote with `BROKKR_REPO_URL`, choose the clone directory with `BROKKR_DIR` (default `./boss`), or stop before the bring-up with `BROKKR_NO_UP=1`. It is idempotent: it adopts an existing checkout, lets `bootstrap.sh`'s own content-hash marker decide whether the OS-package step re-applies, and `task up` reconciles a stack that is already running.

## Running it

From the repo root, **inside the devenv shell** (direnv loads it when you `cd` in):

```bash
task up   # idempotent host bootstrap (once) + passwordless sim sudo, then `devenv up -d`:
          # datastores + hub/spoke + control center (lab :3002 / lab-web :5175) + seed + fleet.
          # Re-run anytime to reconcile a wedged stack — it's idempotent.
```

`task up` claims this checkout's stack slot, then runs a **preflight gate** (`setup:preflight`) — the brokkr-app checkout must exist and no stale `dist/main` process may be squatting this slot's app ports (it auto-reaps orphans). The claim comes first so the scan reads this stack's ports rather than slot 0's. It then runs `devenv up -d` (detached) — the stack keeps coming up in the background; watch it with `task logs`.

### Multiple stacks on one host (worktrees)

Each checkout claims a **slot** (0-46) from the host registry on first `task up`; the slot derives the stack's whole port block (20000+500·S), subnets, node names, and state dirs, so sibling checkouts' stacks run concurrently. Slots 1+ get a single-node fleet by default. Note the behavior change: `task up` no longer stops siblings — it _reports_ them. To stop stacks explicitly: `task down:others` (siblings only), `task down:all` (every registered stack), `task purge:all` (full wipe of all slots' host-global state). `task local:status` shows the host's stacks table. To move a stack to another slot: `task stack:reslot` (destructive migration of slot-bound state), or set `stack.slot` from the control center's Stack settings (it redeploys through the reslot migration).

- `task local:setup` — onboarding: create the SSH key + clone a missing hub checkout (idempotent)
- `task local:doctor` — read-only readiness report (checkout, ssh key, Docker running, group membership)
- `task logs` — the process-compose overview TUI (live status/health + per-process logs; `q` detaches, the stack keeps running)
- `task status` — process list + the fleet status table
- `task down` — stop the whole stack (datastores + hub/spoke + control center + fleet)
- `task local:reset` — **destructive**: down + wipe datastore data + fleet overlays
- `task local:purge` — **destructive**: reset + nginx cache + process-compose logs + task db

> Task naming: the lifecycle verbs are namespaced `local:*` (`task local:setup`, `task local:doctor`, `task local:reset`, `task local:purge`); `task status` and `task logs` are aliases for `local:status` / `local:logs`. `task up` / `task down` are top-level.

The web and API bind **all interfaces (`0.0.0.0`)** by default, so the cockpit is reachable over LAN/Tailscale at `http://<your-host-ip>:5175` (handy from a phone — the UI is mobile-responsive). Locally, open **http://localhost:5175** and drive everything from the UI:

| Section       | What it does                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stack**     | Process-compose status + start/stop/restart the supervised hub & spoke, with live logs, the **Seed DB** op, and the stack-settings knobs (see [Configuration](#configuration)). |
| **Fleet**     | Per-VM power (on/cycle/off) + an interactive serial **console** (auto-reattaches across power-cycles); start/stop the `fleet` process; edit the fleet topology.                 |
| **Testing**   | Run pytest e2e/lifecycle **scenarios** (pick target nodes) in a live terminal.                                                                                                  |
| **Results**   | Per-run breakdown: summary, step tree, and attachments (serial, timeline, hub/spoke logs).                                                                                      |
| **Overview**  | The landing page: the control plane's bring-up pipeline, init progress, the host's other stacks, the fleet, and recent activity.                                                |
| **Datastore** | Postgres (tables + queries), Redis, Thanos (PromQL), and the BullMQ **queues**. The selected tab lives in the URL.                                                              |
| **Hub**       | Read-only hub views: lifecycle jobs with their saga timeline, webhook deliveries, and device tokens.                                                                            |
| **Storage**   | What the spoke serves to a booting node — discovery image, built initrds, disk overlays, layer cache — with **verify**, **resync** and **wipe**.                                |
| **Settings**  | Stack knobs, the Fleet Builder, image layers, and this checkout's `stack.slot` (changing it redeploys through the reslot migration).                                            |
| **API docs**  | The control-center API's own reference, served by the running stack.                                                                                                            |
| **Audit log** | Every mutation the cockpit performed and every one it refused, with the caller's origin. Denied rows keep a separate retention cap.                                             |
| **Wiki**      | The in-app glossary, plus the two guided tours: an orientation deck and an operations deck.                                                                                     |

A control-plane-only bring-up (no VMs) is `{ fleet.autoStart = false; }` in `devenv.local.nix` — `task up` then stops at the control plane and you start the fleet on demand (the UI, or `devenv processes start fleet`).

### Ports

Every host:port is declared once in `devenv/modules/ports.nix` (the TS apps mirror it via env vars onto the lab process) — change a port in one place. Datastore/service ports are also promoted to overridable options, so the control center can retune them per stack via `stack.local.nix`.

| Port        | Service                   |
| ----------- | ------------------------- |
| 5175        | control-center web (Vite) |
| 3002        | control-center API        |
| 3000 / 3001 | hub api / admin           |
| 5173 / 5174 | hub web / web-admin       |
| 8000 / 9082 | spoke (bridge) / gRPC     |
| 5432 / 6379 | Postgres / Redis          |
| 8888        | nginx (OS-layer cache)    |

Multi-zone math: hub api/admin shift by 2 per zone (`3000 + 2i` / `3001 + 2i`), spoke + gRPC by 1 (`8000 + i` / `9082 + i`).

## How the environment works

Everything is **declarative**: `devenv.nix` + the `devenv/modules/*.nix` describe the toolchain, the native datastores, and every process. **devenv** evaluates that and hands it to **process-compose**, which supervises the whole stack over a Unix-domain socket (`task logs` attaches to it). There's no docker for the datastores and no tmux session for hub/spoke — process-compose owns supervision, restarts on failure, and exposes the REST surface the control center drives.

`task up` is a thin idempotent wrapper: it runs the host bootstrap once, installs the sudo drop-in, then `devenv up -d` brings up the **DAG** (each step waits on its dependencies' readiness probes):

```
hostpaths → libvirt → datastores (postgres · redis · nginx)
  → hub:init → hub:migrate → sql-seed:notify → hub-api · hub-admin · hub-web · hub-web-admin
  → spoke → sim:seed → fleet:init → fleet

apps:init → lab · lab-web        # root task — the control center waits on nothing else
```

`apps:init` declares no dependencies at all: the control center is the one thing that has to come up
even when the stack it manages does not, so it is a root task rather than a link in the chain above.

Each of those init tasks leaves a log and an exit-status sidecar in the process-compose log dir, so
the control center's Stack tab renders the roster live (per-task state, exit code, tailable log) —
that is where to look first when a bring-up stalls. Re-running `task up` reconciles a wedged stack
from the terminal; the cockpit's **Reinit** (wipe datastore data + rebuild), **Reset** (also wipes
fleet overlays) and **Purge** (also wipes host-global caches) drive the same cycle from the browser,
detaching so the recreation outlives the control-center API it restarts.

The orchestration is split across small modules, each documented in its own header:

| Module                                                | Owns                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devenv/modules/ports.nix`                            | the canonical host:port + derived-URL map (single source of truth)                                                                                                 |
| `devenv/modules/hub.nix` / `devenv/modules/spoke.nix` | the hub/spoke install+migrate tasks, their processes, and their **per-process env** (declarative Nix — no `hub-env.sh`/`spoke-env.sh` shims)                       |
| `devenv/modules/fleet.nix`                            | the `fleet` process (`python -m local.fleet up --supervise`), the macOS `virtqemud` process / Linux `libvirt:up` task, and the `sim:seed` + `fleet:init` DAG tasks |
| `devenv/modules/fleet-topology.nix`                   | the **declarative fleet topology** — see [Configuration](#configuration)                                                                                           |
| `devenv/modules/polyrepo.nix`                         | the brokkr-app checkout seam (`config.polyrepo.hub.path`) + the `setup:preflight` / `setup:doctor` / `setup:onboard` tasks                                         |
| `devenv/modules/profiles.nix`                         | the `dev` / `stg` real-infra postures (the hermetic `local` default is implicit)                                                                                   |
| `devenv/modules/sudo.nix`                             | the scoped passwordless-sudo drop-in (`sudo:setup` / `sudo:teardown`)                                                                                              |
| `devenv/modules/overrides.nix`                        | the control-center / local-config knob _options_ (the override seam)                                                                                               |
| `devenv/modules/dx.nix`                               | the git hooks (pre-commit · commit-msg · pre-push) — see [Git hooks](#git-hooks)                                                                                   |
| `devenv/pkgs/`                                        | sim runtime pkgs as Nix derivations (`openipmi` ipmi_sim + `sushy` + `socket_vmnet`)                                                                               |

The datastores are **native devenv services** (`services.postgres/redis/nginx` in `devenv.nix`) — no containers. `nginx` is an OS-layer asset cache that proxies R2 so repeat provisions skip the multi-GB re-download.

For the sim engine's internals (the boot pipeline, the seed, the fleet pipeline) see [`apps/local-sim/README.md`](../apps/local-sim/README.md); for how the control center is wired see [`apps/local-lab`](../apps/local-lab) (the API) and [`apps/local-lab-web`](../apps/local-lab-web) (the cockpit).

## Git hooks

The git hooks are managed by devenv (`devenv/modules/dx.nix`) and **install automatically on shell entry** — `direnv allow` (or `devenv shell`) writes `.git/hooks`, so there's no separate bootstrap step. Three stages run:

| Stage        | Runs                                                             | Rules live in                          |
| ------------ | ---------------------------------------------------------------- | -------------------------------------- |
| `pre-commit` | `lint-staged` (eslint/prettier/prisma) + `gitleaks` secret scan  | `.lintstagedrc.json`, `.gitleaks.toml` |
| `commit-msg` | `commitlint` (conventional commits)                              | `commitlint.config.mjs`                |
| `pre-push`   | `turbo run typecheck` + tests for packages affected since master | —                                      |

`gitleaks` comes from the pinned nixpkgs, so the secret scan always runs (no `brew install` step, no silent skip). Bypass a stage for a single commit/push with `git commit`/`git push --no-verify`.

**Migrating off husky:** a clone that previously ran husky still has `core.hooksPath=.husky/_` in its git config, which would redirect git away from the `.git/hooks` dispatcher devenv installs. Shell entry now clears this automatically (the `brokkr:clear-stale-husky-hookspath` task unsets a `.husky`-pointed `core.hooksPath` before the hooks install), so `direnv reload` is all that's needed. If you run git entirely outside the devenv shell, clear it by hand:

```bash
git config --unset core.hooksPath   # then re-enter the shell (direnv reload)
```

Fresh clones need nothing — husky's `prepare` bootstrap is gone, so `core.hooksPath` is never set.

**Linked worktrees:** hooks live in the shared `.git/hooks` directory, but `.pre-commit-config.yaml` is generated per checkout (gitignored) on shell entry. A worktree that has never entered the devenv shell lacks that file and pre-push/pre-commit fail with `config file not found`. Shell entry patches the prek shims to resolve the config absolutely, falling back to the primary checkout beside `.git/` when the worktree has no local copy — so at least one checkout (usually the main tree) must have entered the shell once. For day-to-day work in a worktree, `direnv allow` (or `cd` in so direnv loads) is still recommended so the worktree gets its own config symlink and the full toolchain on `PATH`. Do **not** use `PREK_ALLOW_NO_CONFIG=1` here — that silences the config check without running the hooks.

## Configuration

### Viewing the resolved config

```bash
task local:config                    # the resolved env + the engine's Settings (env + .env + defaults)
task local:config -- --show-secrets  # same, with DSNs unmasked
task status                          # process list + the fleet status table
devenv eval stackOverrides stackCounts identity osLayerCache fleet   # the effective overlay values
devenv eval stackDefaults portGroups labBridges                      # the pre-override defaults the control center reads back
```

Ports/URLs come from `devenv/modules/ports.nix`; the fleet topology from `devenv/modules/fleet-topology.nix` (below).

`stackDefaults.{hub,spoke}` is each service's env **before** the overlay's `stackOverrides` are merged — the value a control-center knob reverts to (`stackDefaults.hubKnobEnv` maps the one hub knob whose UI name is not its env key). `portGroups.{editable,readOnly}` partitions `config.ports` into what the UI may override and what it only displays. `labBridges` lists every bridge process (`proc`/`zone`/`replica`/`port`/`grpc`) across every zone.

### Overriding without editing committed files

All four override layers are **gitignored**, so your machine-local choices never touch the tree:

| File               | You edit it?               | Loaded by                                      | What it holds                                                                                                              |
| ------------------ | -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `.env`             | yes                        | devenv `dotenv` (repo root) + `apps/local-sim` | `HUB_REPO_PATH`, datastore URLs                                                                                            |
| `.envrc.local`     | yes                        | `.envrc` (sourced at the repo root)            | machine-local **shell** exports (alternate repo paths, shell knobs)                                                        |
| `devenv.local.nix` | yes                        | devenv (auto-imported)                         | **Nix** knobs: repo path (`config.polyrepo.hub.path`), `fleet.autoStart`, fleet topology deltas, service ports, any option |
| `stack.local.nix`  | the control center owns it | devenv (imported when present)                 | the UI's stack-settings: env overrides, replica counts, identity, service ports, OS-layer cache origin, fleet topology     |

All four sit at the **repo root** (next to `devenv.nix`). Examples:

```bash
# .env (or export the same in .envrc.local) — point at a polyrepo hub checkout
HUB_REPO_PATH=$HOME/projects/work/hydra/brokkr-app
```

```nix
# devenv.local.nix — control-plane-only bring-up + a per-host fleet delta
{
  fleet.autoStart = false;                 # bring up the control plane, start the fleet on demand
  fleet.nodes.cpu-1.memory_mb = 16384;     # bump one node; the rest inherit the committed base
}
```

The **fleet topology** is itself declarative. The committed base lives in `config.fleet` in `devenv/modules/fleet-topology.nix`; per-host deltas in `devenv.local.nix` **deep-merge** over it (set one field, drop a node, or add one). Nix renders the effective topology to an immutable store `fleet.yml` and points `LOCAL_FLEET_PATH` at it — there's no hand-edited `fleet.yml` in the tree.

### Stack settings from the control center

The cockpit's **Stack** and **Fleet** tabs write their knobs to `stack.local.nix` (env overrides, hub/spoke replica counts, Postgres identity, service ports, OS-layer cache origin, fleet topology), then apply them:

- **Redeploy** re-evaluates the overlay (`devenv build`), hot-swaps the running process-compose config (`project update`, no teardown), and restarts the affected hub/spoke processes.
- **Fleet rebuild** re-renders the topology, then `fleet nuke` → reseed → `fleet init` → restart the `fleet` process.

`.envrc` watches `stack.local.nix`, so a knob change needs **no manual `direnv reload`**. One caveat: an `identity` change (Postgres user/password/db, or the org id) only takes full effect on a fresh datastore — a `task local:reset` (and a reseed for an org-id change).

### External assets and override knobs

`task up` needs no Vault and no internal credentials, but it is not network-free: two artifact families come from a **public** Hydra-operated CDN (`brokkr.assets.hydra.host`, anonymous, no token) — the **discovery OS** the fleet PXE-boots, and the **OS layers** a provision installs. (The build-time toolchain fetches — Nix, pnpm, and the container that git-clones `ipxe.org` to compile each VM's iPXE binary — are separate and not covered by these knobs.) Each consumer has its own knob, so a mirror or an air-gapped cache is a per-layer override:

| Knob                               | Layer                                  | Points at                                                                               |
| ---------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------- |
| `osLayerCache.originHost`          | Nix (`devenv.local.nix`)               | The asset origin host; `DISCOVERY_BASE_URL` and the nginx cache upstream derive from it |
| `SIM_OS_LAYERS_MANIFEST_INDEX_URL` | sim seed (`40-os-catalog.py`)          | The OS-layers release index the catalog seed reads                                      |
| `DISCOVERY_BASE_URL`               | spoke (`modules/spoke.nix`)            | Where `bridge_sync` downloads the discovery OS                                          |
| `OS_LAYER_URL`                     | spoke                                  | Where a device pulls OS-layer blobs (locally, the nginx cache on `:8888`)               |
| `OS_LAYER_MANIFEST_URL`            | hub container (`docker-entrypoint.sh`) | Catalog seed source on startup; set it empty to skip the seed                           |
| `LAB_LAYERS_ALLOWED_HOSTS`         | control center                         | Extra manifest hosts the Layers tab is allowed to fetch                                 |

The release index is served from whatever origin you configure, but the `url` inside it points at an env-qualified host — `brokkr.assets.hydra.host` hands back `https://brokkr.assets.prod.hydra.host/...`. It is a pointer in the body, not an HTTP redirect, and the versioned path resolves on either host. So a **network** allowlist needs both names: the sim seed and the hub's startup seed both follow that pointer. `LAB_LAYERS_ALLOWED_HOSTS` does not — the control center derives the env-qualified siblings of its origin automatically.

With the origin unreachable, bring-up still completes but two things degrade: the catalog seed emits only the system layers (rescue, brokkr-discovery, custom-iPXE), so there are **no selectable OS bases**; and the spoke serves no discovery images, so VMs 404 at iPXE. Both log the knob to fix.

The origin is public but sits behind Cloudflare, which **403s any request whose User-Agent is `Python-urllib/*`** — the default for `urllib.request`. Send any other UA (the sim seed sends `local-environment-seed/1.0`); curl, wget, and browser/undici UAs are unaffected.

**The discovery OS is a published binary, not built here.** `vmlinuz`, `initrd.img` and `brokkr-discovery.iso` are downloaded from `${DISCOVERY_BASE_URL}/${BROKKR_LIVE_VERSION}/<arch>` at the version pinned in `devenv/modules/spoke.nix` — this repo contains no builder for them. Only the cpio overlays layered on top (`brokkr-live.img`, `bridge-agent.img`) are built locally. To run against your own images, publish that same `<version>/<arch>/` layout on your own origin and repoint `osLayerCache.originHost` (or `DISCOVERY_BASE_URL` directly).

## Secrets & profiles

App-config secrets are described **once**, declaratively, in the repo-root `secretspec.toml` — a provider-agnostic contract. devenv reads the active profile's secrets into `config.secretspec.secrets.*`, which `modules/hub.nix` / `modules/spoke.nix` wire into each process's env. The **profile** selects which set of values resolves, and the **provider** says where they come from.

| Bring-up            | devenv profile | secretspec profile | Provider                                      |
| ------------------- | -------------- | ------------------ | --------------------------------------------- |
| `task up` (default) | `local`        | `local`            | `env` — every secret has a default (hermetic) |

### Hermetic `local` (the only local posture)

`task up` runs with **no secrets provider** — no Vault, no internal credentials. The `[profiles.local]` block in `secretspec.toml` gives every secret a default (mostly empty or a local value mirroring `modules/hub.nix`'s `baseHubEnv`), so the contract resolves with **no external provider**. This is the normal local-dev path — nothing to import, nothing to log into. (Secrets are the hermetic part; boot artifacts still come over the network — see [external assets and override knobs](#external-assets-and-override-knobs).)

There is **no `task up:dev` / `task up:stg`**. Pointing a developer's local hub at the shared dev/stg Postgres+Redis was removed: it caused read/write contention on the shared datastores and risked seeding an auth-bypass Owner into the remote DB. To work against a real environment, run against a deployed hub — don't run a local hub against shared infra.

## Platform notes

Auto-detected per host; the same `task up` works on both.

|                 | macOS (Apple Silicon only)                        | Linux (x86_64 / arm64)                                                                    |
| --------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Acceleration    | qemu + HVF                                        | qemu + KVM                                                                                |
| libvirt         | user-session `virtqemud` (a supervised process)   | system `libvirtd`                                                                         |
| Data plane      | `socket_vmnet` + Apple `bootpd` (`/etc/bootptab`) | flat L2 kernel bridge `br-brokkr`                                                         |
| BMC plane       | `lo0` loopback aliases                            | `lo` aliases via `ip addr`                                                                |
| Extra host deps | Docker Desktop (grub/iPXE build containers)       | OVMF/swtpm/cpio firmware + docker (from `apps/local-sim/provisioning/linux-bootstrap.sh`) |

**Passwordless sim sudo.** A few sim operations need root (binding the BMC's privileged port 623, loopback aliases, root-owned state cleanup, the macOS vmnet bridge). The first `task up` installs a **scoped** `sudoers` drop-in (`/etc/sudoers.d/brokkr-sim-<helper store hash>`, generated by `devenv/modules/sudo.nix`) — one prompt, then never again. The drop-in is named for the helper it authorises, so concurrent checkouts at different revisions each install their own file and stay authorised in parallel (several `brokkr-sim-*` files on a host is normal; each still pins one exact path). That parallelism depends on the rule carrying **no `Cmnd_Alias`**: alias names are one namespace shared by every file in `/etc/sudoers.d`, so two drop-ins declaring the same alias collide — sudo keeps the first file it parses, discards the second, and warns on every `sudo` call, silently leaving the later checkout unauthorised. The commands are therefore inlined as absolute paths in a single user specification, which sudo accepts cumulatively. When `task sudo:setup` actually installs or updates a drop-in, it also garbage-collects any other `brokkr-sim*` file that still uses the old alias format or whose pinned helper has left `/nix/store` (the already-current fast path exits before that, deliberately: the sweep needs a plain `sudo rm`, which is not allowlisted and would reintroduce a prompt — but the fast path also checks for the pre-content-addressing `/etc/sudoers.d/brokkr-sim`, because a live sudo ticket would otherwise let the passwordless probe answer for a policy that grants nothing). Both the sweep and that check read `/etc/sudoers.d` unprivileged, so on hosts where it is `0750` (Fedora, Arch — macOS and the apt family are `0755`) they match nothing and the fast path is unreachable, which means every run reinstalls and re-verifies rather than skipping. Collecting a legacy file can deauthorise a sibling checkout still on that format; its own `task sudo:setup` restores it. Every generic privileged op routes through **one pinned helper** (`brokkr-sim-priv`, `devenv/pkgs/sim-priv.{sh,nix}`) that enforces scope **in code**, so the drop-in is a single bare-path rule with **no argument wildcards** — which keeps it valid under **sudo-rs** (Ubuntu 25.10+ defaults `sudo` → sudo-rs, which only accepts a single trailing `*`; the old per-op arg-globs silently failed there and hung headless `task up` on a password prompt). The helper's store path is the security boundary (pinned, immutable); `socket_vmnet` (macOS) stays a direct rule. After a `devenv update` rotates the helper path, re-run it with `task sudo:setup` (one prompt); `task sudo:teardown` reverts to per-op prompts.

## Bare-metal fleet mode (Linux only)

The Fleet tab in the control center (`:5175/settings`) toggles between **VM fleet** (libvirt/qemu sims, the default) and **bare-metal fleet** (PXE-boot real machines on a host NIC). Both configs are kept; the toggle only changes which one runs. Nothing applies until you **Save** then **Apply** — Apply runs the `fleet-mode-apply` op (no `task down`/`up`): it re-bakes iPXE with an IP-literal chain URL, re-evals the overlay, and `process-compose project update`s exactly **`{spoke, hub-api, fleet}`** into their new posture.

- **LAN assumptions.** The uplink NIC you pick must be on the same L2 as the machines. **Your router stays the DHCP server** — the spoke only answers PXE boot requests (DHCP proxy mode, configured per-prefix in the hub UI), it never leases. Give this host a **static IP or a DHCP reservation** on your router: the iPXE binaries and the phone-home/OS-layer URLs embed that address (`BRIDGE_URL`/`OS_LAYER_URL`/`PHONE_HOME_BASE_URL` rebase to the iface IP in bm mode).
- **Known-MAC-only boot offer.** Only known **PXE MACs** get a boot offer — the gate is the hub's per-prefix DHCP atom (`proxyAllowedMacs`), derived from the prefix's reservation MACs unioned with the operator-managed `Prefix.dhcpProxyAllowedMacs` (edited in the hub UI's prefix DHCP config card). It is **fail-closed**: a PROXY prefix with an empty allowlist denies every client, and non-PROXY modes publish an empty list. Unlisted clients on the LAN get **no** DHCP response, so the toggle can't hijack other machines' netboot. The atom hot-swaps on change, so adding a MAC needs no re-Apply or spoke restart.
- **Live power.** The roster's On/Off/Reset/Power-cycle buttons talk **Redfish straight to each BMC** (self-signed TLS accepted per-call). Power-cycle falls back to ForceOff→poll→On (30s) when the BMC lacks `PowerCycle`.
- **Ports** on the uplink NIC: **67/69** (DHCP proxy + TFTP, privileged — bound via an ambient-cap `setpriv` wrapper the flip provisions: a file-capped `setpriv` copy raises `cap_net_bind_service` ambiently and execs the real PATH `node`, so node keeps `AT_SECURE=0` — its TLS cert env stays intact — while still binding the privileged ports), **4011** (PXE), **8000** (spoke: iPXE chain + HTTP), **3000** (hub phone-home), **8888** (OS-layer blobs).
- **Active-saga guard.** A flip is refused (409) while lifecycle/collection jobs are in flight in any zone; the UI offers a **force** override.
- **Stale-bake recovery.** If you change the uplink NIC/IP, the baked iPXE chain URL goes stale — the Fleet tab shows a "stale — re-apply to rebake" badge; just Apply again.
- **First deploy needs one `task up`** so the devenv DAG is initialized; thereafter the flip is hot.
- **Unsupported:** Secure Boot / signed shim (the locally-built iPXE is unsigned), and bare-metal mode on **macOS** (the toggle is Linux-only).

## Sim engine directly (CLI, optional)

You don't need this for normal use (the control center drives it), but the engine's interactive operator verbs are exposed as root-level `sim:*` tasks:

```bash
task sim:node:console NAME=<node>   # tail a node's serial console
task sim:ipmi    -- <node> <cmd>    # ipmitool passthrough (e.g. cpu-1 chassis power on)
task sim:redfish -- <node> <verb>   # Redfish passthrough (e.g. cpu-1 power-on)
task sim:dash                       # tmux dashboard: per-VM consoles + shells
task local:config                   # resolved env + engine settings (-- --show-secrets to unmask)
devenv processes start|stop fleet   # power the VMs on/off
```

List the full verb surface with `task --list` (the `sim:*` entries are the operator verbs). See [`apps/local-sim/CLAUDE.md`](../apps/local-sim/CLAUDE.md) for engine internals (fleet pipeline, boot path, seed, gotchas).

## VRRP VIP failover e2e (opt-in)

VRRP virtual-IP failover is verifiable locally without real `iproute2` or root. The bridge reconciler binds VIPs with `ip addr add … label brokkr-vrrp`; the opt-in `vrrpSim` module (`devenv/modules/vrrp-sim.nix`, off by default) puts a sim `ip`/`arping` shim first on each bridge's PATH so those verbs run against a per-bridge state file instead of a real interface. Production Linux uses the real `ip` under `CAP_NET_ADMIN` — the constant `brokkr-vrrp` label already works there for any interface name; the shim is strictly a local device.

- **Fast path (no stack) — the real reconciler against live Redis + the shim:** with `task up` running (Redis up),
  ```
  cd apps/bridge && ../../node_modules/.bin/tsx scripts/vrrp-e2e.ts
  ```
  Drives two `VrrpReconcilerService` instances through a hub-shaped Redis atom: leader binds the VIP, follower doesn't, failover moves it, `detachAll`/atom-clear release it. Prints `PASS` / `FAIL`.
- **Full-stack path (two live bridges):** enable the shim and add a second HA bridge in your gitignored `stack.local.nix`, then `task up`:
  ```nix
  { ... }: {
    vrrpSim.enable = true;
    fleet.zones."sim-zone".bridges = 2;
  }
  ```
  `vrrpSim.enable` on its own binds **nothing** at boot (VRRP is hub-atom-driven; the shim only fakes `ip`/`arping`) — `task up` gives you two bridges with no VIP configured. Bridges report their **real host NICs** in presence (no simulated interfaces — a VIP is a secondary address the leader adds on top of a real NIC, matching production). To test: `devenv tasks run vrrp:seed` pre-creates real IPAM inventory (the data-plane prefix `192.168.200.0/24` + one IP per spoke, at `.240+`) — it binds nothing; then attach a VIP to a bridge NIC yourself in the hub UI (edit prefix → VRRP Virtual IP), watch the leader bind it (per-bridge state files under `vrrpSim.stateDir`), and kill the leader to watch it move. `devenv tasks run vrrp:verify` asserts leader-exclusivity generically (each `brokkr-vrrp`-labeled VIP held by exactly one bridge, no hardcoded VIP value); `vrrp:seed:clear` removes the seeded IPs.

## Troubleshooting

- **"unknown service / not ready"** → the supervised hub/spoke haven't started; check `task status` / `task logs`, or re-run `task up` to reconcile.
- **A backend won't recover** → re-run `task up` (idempotent; runs `stack-reconcile` to revive any stopped/crash-looped datastore/hub/spoke process in dependency order), click **Reconcile / self-heal** in the control center's Stack section, or restart it directly: `devenv processes restart hub-api` (etc.).
- **`task up` fails on a port already in use** → a stale `apps/api/dist/main` (orphaned `pnpm start:prod`, reparented to PID 1) is squatting the port. The preflight auto-reaps brokkr-owned orphans; a foreign listener it reports but won't kill — stop it yourself, then re-run.
- **`fleet:init` dies with `[build-grub] /build.sh: /build.sh: Is a directory` and `returned non-zero exit status 126`** → the checkout sits outside the paths your container runtime shares. `grub_build.py` and `ipxe_build.py` bind-mount files out of the checkout into a `linux/amd64` container (`-v …/grub-build.sh:/build.sh:ro`). Docker Desktop, Lima and Colima all share your home directory by default but **not `/tmp`** or `/private/tmp`; when the runtime cannot see the source path it creates an empty directory at the mount point instead, so `bash /build.sh` is handed a directory. Confirm with:

  ```bash
  docker run --rm -v "$PWD/apps/local-sim/scripts/local/grub-build.sh:/x:ro" ubuntu:24.04 stat -c %F /x
  ```

  `regular file` means the mount works; `directory` means it does not. Move the checkout under your home directory, or add its path to the runtime's file-sharing settings. Note the empty directories the runtime created inside its VM persist — they are its own copy, not yours.

- **sudo started prompting again** → a `devenv update` rotated the pinned store paths; re-run `task sudo:setup` (one prompt).
- **A stack-settings change didn't take effect** → click **Redeploy** (env/identity/counts) or **Fleet rebuild** (topology) in the control center; the overlay is inert until applied.
- **Toolchain looks stale / a command is missing** → make sure you're in the devenv shell (`cd` into the repo so direnv loads it; `direnv allow` if prompted).
- **Consoles / test runs fail to spawn (node-pty `EACCES` on `spawn-helper`)** → the root `postinstall` chmods node-pty's prebuilt `spawn-helper`; if it didn't run, re-run `pnpm install`.
- **Fleet crash-loops on Linux with `cannot execute binary /nix/store/…/qemu-system-x86_64: Permission denied`** (or `internal error: Failed to start QEMU binary … for probing`) → the distro `libvirtd`'s AppArmor profile confines exec/read to system paths, but the devenv runs its **Nix-store** qemu + EDK2 firmware (the rendered domain XML's `<emulator>`/`<loader>`/`<nvram>` point into `/nix/store`, from `LOCAL_QEMU_EMULATOR`/`LOCAL_EDK2_*`). The Linux host bootstrap (`apps/local-sim/provisioning/linux-bootstrap.sh`) now adds the local allow-rules automatically; they re-apply on your next `task up` after pulling (the bootstrap content-SHA marker changes). If you're on an older checkout, hit this on a modular-daemon host (the probe runs under `usr.sbin.virtqemud` instead of `usr.sbin.libvirtd`), or want to apply them by hand, allow them once per host (the `/nix/store/**` glob survives a `devenv update` rotating the store path):

  ```bash
  echo '/nix/store/** rmix,' | sudo tee    /etc/apparmor.d/local/usr.sbin.libvirtd
  echo '/nix/store/** rmix,' | sudo tee -a /etc/apparmor.d/local/abstractions/libvirt-qemu
  sudo systemctl reload apparmor
  ```

  The first rule lets the `libvirtd` daemon probe-exec qemu; the second lets each running VM's qemu read the Nix EDK2 blobs. Then restart the fleet — `process-compose -U -u "$PC_SOCKET_PATH" process restart fleet` (the `fleet` process, or the control center's fleet controls; `devenv processes …` is unavailable under the process-compose manager).
