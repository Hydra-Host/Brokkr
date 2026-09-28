# bridge — the spoke gateway

NestJS app that is a **line-for-line TypeScript port of the Python `bridge-api`** — the spoke side of the hub-and-spoke architecture. It runs in each zone, consumes `saga.run` jobs from the hub over BullMQ, dispatches operations to devices over gRPC, and writes results back to the shared `results:inbox`. Domain subtrees under `src/` (`provision`, `collection`, `deprovision`, `power-ops`, `device-health-check`, `saga-framework`, `snmp`, `tftp`, `redfish`, `ipxe`, etc.) mirror the Python package layout.

> For the repo-wide architecture and bring-up see the repo-root `README.md`. For the device-side agent see `../live-agent`. The hub side is `apps/api`.

## Running it

```bash
pnpm --filter bridge dev    # nest start --watch
```

- **HTTP adapter**: the bridge runs on **Fastify** (`NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())` in `src/main.ts`), unlike the hub's default Express adapter.
- **Default port**: `8080` (`DEFAULT_PORT` in `src/startup/listen-target.ts`), overridable via `PORT`. Port parsing matches Python `int()` semantics (rejects floats, accepts PEP-515 underscores) for parity with `bridge/config/core.py`.
- **Bind host**: defaults to loopback (`127.0.0.1`) (`DEFAULT_HOST` in `src/startup/listen-target.ts`), in the container too — the image fails safe and is not reachable off-box unless an operator opts in by setting `HOST` (e.g. `0.0.0.0` behind the management network) or maps the port on the host loopback (see security posture).

## Security posture (read this)

The bridge's REST surface is **unauthenticated**. There is no HTTP auth layer in front of it: `app.module.ts` registers no `APP_GUARD`, and the controllers carry no `@UseGuards`. Any client that can reach the listening socket can call **every** endpoint of **every** controller wired into `AppModule` (`src/app.module.ts` is the source of truth). The full set today:

- `/admin/crons` — inspect scheduled-job state, read-only (`src/admin/crons.controller.ts`).
- `/api/status` — bridge status and configuration (`src/bridge-status/bridge-status.controller.ts`).
- `/api/health` — health/readiness (`src/bridge-status/health.controller.ts`).
- `/api/monitoring/*` — device sensors, IPMI, SNMP, ICMP, Redfish, and Prometheus metrics (`src/monitoring/**`).
- `/api/discovery`, `/api/discovery/:arch/:filename` — discovery boot artifacts (`src/download/discovery.controller.ts`).
- `/api/discovery/inventory` — read-only per-arch presence/size/mtime of the required discovery files (TS-only; no secrets, relative paths only) (`src/download/discovery.controller.ts`).
- `/api/grub` — GRUB config (`src/download/grub.controller.ts`).
- `/api/os-image/*` — OS image artifacts (`src/download/os-image.controller.ts`).
- `/api/initrd`, `/api/initrd/:buildName` — initrd build artifacts (`src/initrd/initrd.controller.ts`).
- `/api/chain` — iPXE chain content (`src/ipxe/ipxe.controller.ts`).
- `/apispec.json`, `/docs`, `/docs/swagger`, `/docs/redoc` — OpenAPI spec and API docs (`src/docs/docs.controller.ts`).

Several of these (discovery, grub, os-image, initrd, chain) serve boot artifacts and iPXE chain content — they are part of the bare-metal provisioning control surface, not just observability. The list above reflects the controllers registered at the time of writing; treat `app.module.ts` as authoritative if it has since changed.

Mutual-TLS / certificate auth (described in `assets/docs/api-description.md`) is terminated upstream by the zone trust chain, **not** by this process — it does not authenticate the local REST surface above.

Mitigations, in order:

- **It binds loopback (`127.0.0.1`) by default — including in the container** (`resolveListenHost()` returns `DEFAULT_HOST` when `HOST` is unset/empty; `entrypoint.sh` does not override it), so neither a bare `node dist/main.js` nor the unmodified image is reachable off-box. This is deliberate: the artifact fails safe and never defaults to all-interfaces, so a missing/misconfigured network boundary cannot silently expose the fleet-control surface.
- **Off-box reach is an explicit operator opt-in, not a default.** When an off-box HTTP consumer needs it (e.g. a **remote Prometheus scrape of `POST /api/monitoring/prometheus/metrics`**), either set `HOST=0.0.0.0` (or a specific management-interface address — prefer the narrowest bind) in the deploy contract, or keep the loopback bind and map the port on the host loopback (`-p 127.0.0.1:8080:8080`) and reach it via that interface. Do this **only** behind the firewalled/isolated management network below. The gRPC path is separate — it has its own `GRPC_INTERNAL_HOST` (`src/agent/gateway/grpc.config.ts`).
- **Firewall the REST port** (`8080` by default) so only the management network / hub and trusted scrapers can reach it. Treat reachability to this surface as equivalent to control over the zone's bare-metal fleet (power, provisioning, OOB).

Keep it on a **trusted, firewalled management network** — any all-interfaces bind you opt into assumes exactly that boundary.

### In-process DNS server (hub-atom controlled)

The DNS server (`src/dns/`) replaces the legacy BIND9 sidecar and is **configured entirely by the hub**: the zone-global `{zone}:config:dns` atom carries enablement, upstream resolvers, TTL/cache tuning, and TCP limits (per-prefix `prefix:{id}:config:dns` atoms override upstreams). There are no `DNS_*` env vars; with no atom (or `enabled=false` in it) the server is off. When enabled, it binds UDP+TCP `:53` (TCP is always on alongside UDP) on the **atom-served interface IPs**, derived from hub-published DHCP config atoms via `getAtomServedIps` (`composition/atom-served-ips-holder.ts`), re-derived each reconcile. DHCP is scoped to the same atom-served set but filters by NIC _name_ (`servedInterfaceNames`), so on a NIC holding both an atom-subnet IP and an off-subnet one DHCP binds a reply socket per address while DNS binds only the served IP — harmless, since a reply socket takes no `'message'` handler and `socketFor` only selects one whose CIDR holds the target. This includes data-plane bridge interfaces (`br-*`) when their IP falls inside an atom-configured subnet. There is no interface pin (`DHCP_DNS_IFACE` is gone) and no name-classifier bind set; with no DHCP atoms the server binds nothing (hub-authoritative, coupled to DHCP). DNS answers independently on all bridges (active-active, no leader gate); only DHCP is leader-gated.

Owned names (`brokkr.lan`, `<hostname>.lan`) answer **per-ingress**: each listener returns its own listening IP — the IP the query arrived on — as the single A record, so a client always gets a server address reachable on its own subnet. This replaces BIND9's per-subnet zones/views (the socket binding encodes the subnet, so there is no `match-clients` machinery). The legacy `alt-brokkr.lan` secondary-bridge record is deprecated and deliberately not served (NXDOMAIN under the owned domain); provisioned hosts carry it in `/etc/hosts` from the host-manager playbooks, and resolver redundancy comes from DHCP advertising a second DNS server instead. The authoritative `*.lan` zone is answered to any source; **upstream recursion is gated to RFC1918/loopback sources plus clients inside any atom-served subnet CIDR** (including relayed subnets), so customer hosts on public provisioning subnets keep upstream resolution — legacy BIND9 ran `allow-recursion { any; }`, so this is strictly tighter — while arbitrary internet sources are still refused (dropped with a `DNS dropping recursion` warn log carrying the source IP). As with the REST port, **firewall `:53`** so only the provisioning LAN can reach it — the prior BIND9 sidecar relied on host firewalling and that expectation carries over.

The deployment assumption is that bridge interfaces sit on an **isolated provisioning L2 segment**; startup logs a warning for any bound IP outside RFC1918 so an unexpected bind is visible. Recursion remains source-gated regardless.

## DHCP + config source

The DHCP server (`src/dhcp/`) is **driven entirely by the hub — there are no `DHCP_*` env vars.** Per-prefix `prefix:{id}:config:dhcp` atoms (SCAN-discovered from Redis — derived hub-side in `apps/api/src/brokkr-bridge/`) are the sole source of DHCP service policy: the engine is built from atoms (`dhcp-atom-mapper.ts` → `DhcpEngine.fromSubnets`), hot-swaps on atom change, and tears down when no atoms are present. There is no env-derived bootstrap config and no single-subnet fallback — no atoms means no DHCP (and no DNS) on that subnet.

- **Runtime tuning** (leader-poll, lease-prune, decline-backoff) comes from the zone-global `{zone}:config:dhcp` ops atom, derived from the hub's zone service-tuning settings; built-in defaults (2s/60s/600s) apply until it arrives. Lease persistence is always Redis (keyed `dhcp:lease:{ip}`) — there is no in-memory-only mode.
- **Required**: `BROKKR_ZONE_ID` (the zone UUID) must be set and non-empty. The DHCP config-atom SCAN (`prefix:*:config:dhcp`) is scoped to this zone **only** by this Redis key prefix, so the bridge **refuses to start** (`bindDhcpHoldersForOrchestrator` throws) when it is unset — an empty prefix would scan every zone's atoms on a shared Redis (cross-zone config bleed).

**Lease timers (Kea parity):** DHCP leases default to 600 seconds with standard Kea-style renewal timers (T1 at 25%, T2 at 50% of the lease). A REQUEST for an address the bridge still assigns renews the full lease, as Kea does.

### Active-passive HA (leader-elected hot-standby)

Every bridge in a zone that has at least one live atom binds the DHCP sockets, but **only the leader answers DHCP** (with no atoms a bridge binds nothing at all — see above); DNS answers independently on all bridges (read-only resolution has no split-brain risk): the packet path is gated on `isLeader() && hydrated` (`dhcp-manager.service.ts`), and a non-leader drops silently and clears its in-RAM lease state (the socket stays bound). Failover is a leader change — the new leader hydrates leases from the shared Redis store (keyed `dhcp:lease:{ip}`) and starts answering; the old leader stops. A single VRRP **VIP floats to the leader** (see the root `CLAUDE.md` "VRRP virtual-IP failover" section), so DHCP/DNS/TFTP clients keep a stable server address across failover without re-learning one.

This is deliberately **not** active-active. A single DHCP authority per subnet avoids split-brain lease allocation (two servers handing out overlapping addresses from the same pool); the shared Redis lease store plus the VIP give continuity without the servers coordinating allocations in real time. The tradeoff — all client traffic lands on one bridge at a time — is acceptable because provisioning DHCP/DNS load is low and bursty, and lease correctness matters more than horizontal spread.

## iPXE chainload & TLS trust

The iPXE binaries the bridge serves embed a chainload script (`boot/ipxe/autoexec-chainload.ipxe`) that brings up the NIC and then `chain`s to `${CHAIN_BASE_URL}/api/chain`, handing the boot decision to the spoke (which renders the kernel/initrd/cmdline server-side). `CHAIN_BASE_URL` is baked at **image build** (`ARG CHAIN_BASE_URL` in `Dockerfile`), not a runtime env:

- **Default `https://brokkr.lan`** — the nginx `:443` front door. The bridge API binds loopback (`127.0.0.1:8080`), so `:443` (nginx terminates TLS and reverse-proxies `/api/chain` to the bridge) is the only externally reachable path; a device chaining to `:8080` directly is refused.
- **The local sim overrides it** with a plaintext `http://<gateway>:<port>` endpoint (`apps/local-sim/scripts/local/ipxe_build.py` passes `--build-arg CHAIN_BASE_URL=…`) because the sim has no TLS terminator. It always passes the arg explicitly rather than inheriting the (https) Dockerfile default.
- **The boot banner and the give-up beacon use the same baked URL.** The script prints `Chain URL: ${CHAIN_BASE_URL}/api/chain` and, after `max_attempts` failed chainloads, beacons to `${CHAIN_BASE_URL}/api/chain-unreachable`; neither reads the lease's `next-server`, which on a shared segment can name another DHCP server entirely. Binaries baked before this change still beacon to `next-server` — rebake (`ipxe_build.py`, or the image build) after upgrading.

### Trusting the zone CA (no committed PEMs)

Because the chain is HTTPS, iPXE must validate nginx's `:443` cert. iPXE's trust store is **SHA-256(DER) fingerprints of trusted root CAs, computed at build time from the certs handed to `TRUST=`** — plus the upstream iPXE.org root, which the `overlay/crypto/rootcert.c` overlay always prepends so the `ca.ipxe.org` cross-sign lookup the phone-home path relies on keeps working. The build derives `TRUST=` from the `apps/bridge/ca/` directory (next section), so the embedded fingerprints track whatever CAs a deployment drops there: hosted CI stages the Hydra/Brokkr roots for all three envs (one image is deployed across dev/stg/prod, so a single binary must validate whichever env's cert it meets); self-hosters stage their own root. Nothing is committed — the directory is gitignored and the binary carries only 32-byte fingerprints, so a CA rotation is "replace the cert, rebuild". nginx presents the full chain (`leaf → Brokkr Intermediate CA → self-signed Brokkr Root CA`), so iPXE's top-of-chain fingerprint check lands on the root.

### Bridge HTTPS with your own CA (self-hosting)

Every trust surface the bridge ships is fed from one directory: drop PEM CA certs (`*.crt`/`*.pem`, gitignored) into `apps/bridge/ca/` and the image build threads them everywhere they need to be — no Dockerfile edits, no fingerprint regeneration:

| Surface              | What the build does                                                                                                                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| iPXE binaries        | Folds each cert into `TRUST=`, so chainloading validates your `:443` chain                                                                                                                     |
| brokkr-live initrd   | Installs them into the initrd trust store (applied by `init-bottom/trust` at boot) and merges them into `/etc/ssl/certs/brokkr-ca.crt`, the `--cacert` bundle the early-boot rootfs fetch uses |
| Bridge runtime image | Installs them into `/usr/local/share/ca-certificates/` + `update-ca-certificates`                                                                                                              |

The device-side agent needs no extra step: it reads the system CA bundle (`tls.ca_bundle_path` in `agent.yaml`), which the initrd trust store feeds.

End to end:

1. Create a root CA (or use your org's existing one):

   ```bash
   openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
     -keyout brokkr-root-ca.key -out brokkr-root-ca.crt -subj "/CN=Brokkr Root CA"
   ```

2. Issue the `:443` server cert for your bridge hostname from that CA (SAN must cover the name devices chain to) and install cert + key in the nginx front door.
3. Copy `brokkr-root-ca.crt` into `apps/bridge/ca/` (the key stays wherever you keep keys — only the public cert goes here).
4. Build with your chain URL: `docker build --build-arg CHAIN_BASE_URL=https://<bridge-host> -f apps/bridge/Dockerfile .`

Skipping HTTPS entirely is also supported: leave `apps/bridge/ca/` empty and build with a plaintext `CHAIN_BASE_URL=http://<bridge-host>:8080` (the local sim's default posture). That trades chainload integrity for zero cert management — reasonable only on an isolated provisioning network.

## Layout & lifecycle notes

- **Startup orchestrator**: the two-phase `StartupOrchestrator` (`runStartup`) runs before HTTP binds, gated by `BRIDGE_ORCHESTRATOR_ENABLED` (tri-state): `true` runs the orchestrator; `false` enters degraded HTTP-only mode and skips it; unset/unrecognized throws `OrchestratorGateUnsetError` and never binds HTTP. It owns only the **ordered startup tasks** (`registerStartupTasks` in `startup/startup-services.ts`); the long-lived **daemons** (leader-election, BullMQ, gRPC, SNMP, TFTP, cron, telegraf, topology-broadcaster) are Nest lifecycle modules wired in `app.module.ts`.
- **Shutdown**: the SIGTERM/SIGINT handlers in `src/startup/start-server.ts` are the sole owner of the shutdown path; `app.enableShutdownHooks()` is deliberately not called. Exit is not automatic: the process only ends once every daemon has released its handles, so each holder must be closed on its own stop path. `main.ts` arms two unref'd timers after the last shutdown `await` — a 2s handle dump (`shutdown-probe:`) and a 5s force-exit (`shutdown-watchdog:`, exit code 0). Either line in the logs means a holder leaked; the dump names it (Redis clients are labelled `redis:<owner>`).
- **Handle-leak regression case**: `src/__test__/composition-root-integration.test.ts` carries an opt-in case that `init()`s and `close()`s the real `AppModule` and diffs `process.getActiveResourcesInfo()`. It is skipped unless `BRIDGE_HANDLE_LEAK_TEST=1` because it starts every daemon for real — point `BROKKR_ZONE_ID` at a throwaway zone, never a zone with live bridges (it takes the leader key and consumes that zone's BullMQ queues).
- **Scripts**: `pnpm --filter bridge dev` (watch), `build`, `test`, `test:integration` (composition-root), `typecheck`.
- **Note**: `pnpm dev` / `pnpm dev:main` at the repo root do not start the bridge — run it explicitly per-filter.

## Local-sim runbook: deterministic device-lock loss

This destructive run verifies that lock loss during a reprovision step moves the BullMQ job to delayed without burning either the BullMQ or saga-step attempt, avoids saga recovery, and resumes on the other bridge. It is local-sim-only and assumes one sim device is already provisioned with an open deployment.

### Topology and fixed timing

Add this to the gitignored `stack.local.nix`, then reconcile the stack:

```nix
{ ... }: {
  fleet.zones."sim-zone".bridges = 2;
  stackOverrides.spoke = {
    DEVICE_LOCK_TIMEOUT_SECONDS = "60";
    DEVICE_LOCK_RENEW_INTERVAL_SECONDS = "20";
  };
}
```

```bash
set -euo pipefail
task up
curl -fsS http://127.0.0.1:3002/api/services \
  | jq '[.[] | select(.id == "spoke" or .id == "spoke-1") | {id, running, ready}]'
```

Both `spoke` and `spoke-1` must report `running: true` and `ready: true`. They have distinct HTTP/gRPC ports and hostnames, but the same zone UUID, Redis prefix, lifecycle queue, and device lock namespace.

### Select an open deployment and start reprovision

Run from the repository root in the devenv shell. Authenticate the CLI once with the seeded local account (`brokkr@brokkr.local` / `brokkr`):

```bash
set -euo pipefail
pnpm brokkr env use local
pnpm brokkr login

export BRIDGE_REDIS_URL="${BRIDGE_REDIS_URL:-redis://127.0.0.1:6379}"
export LOCAL_SIMULATION_ENABLED=true
export LOCK_TIMEOUT_SECONDS=60

read -r DEVICE_ID ZONE_ID DEPLOYMENT_ID OS_SLUG SSH_KEY_ID <<<"$(
  psql "$HUB_DATABASE_URL" -At -F ' ' -c '
    SELECT d.id, d."zoneId", dep.id, l.slug, dk."sshKeyId"
    FROM "Deployment" dep
    JOIN "Server" s ON s.id = dep."serverId"
    JOIN "Device" d ON d.id = s."deviceId"
    JOIN "Layer" l ON l.id = dep."baseLayerId"
    JOIN LATERAL (
      SELECT "sshKeyId"
      FROM "DeploymentSshKeys"
      WHERE "deploymentId" = dep.id
      ORDER BY "sshKeyId"
      LIMIT 1
    ) dk ON true
    WHERE dep."endDate" IS NULL
    ORDER BY dep."createdAt" DESC
    LIMIT 1
  '
)"
test -n "$SSH_KEY_ID"

DEVICE_RECORD_KEY="$ZONE_ID:device:$DEVICE_ID:device_record"
OLD_PLAN_ID="$(redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$DEVICE_RECORD_KEY" \
  | jq -r '.value.last_job_id // .last_job_id // empty')"

pnpm brokkr deployments:reprovision "$DEPLOYMENT_ID" \
  --name lock-loss-repro \
  --os "$OS_SLUG" \
  --ssh-keys "$SSH_KEY_ID" \
  --force \
  --json | tee /tmp/lock-loss-reprovision-response.json

while :; do
  PLAN_ID="$(redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$DEVICE_RECORD_KEY" \
    | jq -r '.value.last_job_id // .last_job_id // empty')"
  if test -n "$PLAN_ID" && test "$PLAN_ID" != "$OLD_PLAN_ID"; then break; fi
  sleep 2
done

PLAN_KEY="$ZONE_ID:bridge:jobs:plan:$PLAN_ID"
BULL_JOB_ID="$DEVICE_ID-provision-$PLAN_ID"
BULL_JOB_KEY="$ZONE_ID:lifecycle:$BULL_JOB_ID"
DELAYED_KEY="$ZONE_ID:lifecycle:delayed"
LOG_DIR="$(dirname "$(ls -t /tmp/devenv-*/processes/logs/spoke.stdout.log | sed -n '1p')")"

while :; do
  FIRST_LOG="$(rg -l "Starting saga .*${PLAN_ID}" "$LOG_DIR"/spoke*.stdout.log | sed -n '1p' || true)"
  if test -n "$FIRST_LOG"; then break; fi
  sleep 2
done
FIRST_BRIDGE="$(basename "$FIRST_LOG" .stdout.log)"
printf 'plan=%s device=%s first_bridge=%s\n' "$PLAN_ID" "$DEVICE_ID" "$FIRST_BRIDGE"
```

### Inject during the long-running step

Wait specifically for `deploy_os`; injecting while it is `running` proves lock loss does not turn the in-flight operation into a normal step failure:

```bash
set -euo pipefail
until redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$PLAN_KEY" \
  | jq -e '.steps[] | select(.step_name == "deploy_os" and .status == "running")' >/dev/null
do
  sleep 2
done

redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$PLAN_KEY" \
  | jq . | tee /tmp/lock-loss-plan-before.json
BEFORE_ATTEMPT="$(jq -r '.steps[] | select(.step_name == "deploy_os") | .attempt' /tmp/lock-loss-plan-before.json)"
BEFORE_BULL_ATTEMPTS="$(redis-cli -u "$BRIDGE_REDIS_URL" --raw HGET "$BULL_JOB_KEY" atm)"
BEFORE_BULL_ATTEMPTS="${BEFORE_BULL_ATTEMPTS:-0}"
test "$(jq -r '.metadata.rewound // false' /tmp/lock-loss-plan-before.json)" = false

INJECTED_AT_MS="$(python -c 'import time; print(time.time_ns() // 1_000_000)')"
python -m local.lock_loss replace "$DEVICE_ID" \
  --zone-id "$ZONE_ID" \
  --ttl-seconds "$LOCK_TIMEOUT_SECONDS"
```

`replace` atomically swaps the held UUID token for a foreign token with a 60-second TTL. The owner therefore fails its next 20-second renewal, while the replacement prevents another worker from acquiring the device before the original lock timeout. `delete` is available for the immediate-expiry variant:

```bash
set -euo pipefail
python -m local.lock_loss delete "$DEVICE_ID" --zone-id "$ZONE_ID"
```

Both forms refuse to run unless `LOCAL_SIMULATION_ENABLED=true`, Redis resolves to loopback, and the exact namespaced lock currently exists.

### Assert delayed handoff without recovery

Wait for the active job to enter BullMQ's delayed set, save the evidence, and verify its due time is later than the injected lock timeout:

```bash
set -euo pipefail
while :; do
  DELAY_SCORE="$(redis-cli -u "$BRIDGE_REDIS_URL" --raw ZSCORE "$DELAYED_KEY" "$BULL_JOB_ID")"
  if test -n "$DELAY_SCORE"; then break; fi
  sleep 2
done

redis-cli -u "$BRIDGE_REDIS_URL" --raw ZRANGE "$DELAYED_KEY" 0 -1 WITHSCORES \
  | tee /tmp/lock-loss-bullmq-delayed.txt

python - "$DELAY_SCORE" "$INJECTED_AT_MS" "$LOCK_TIMEOUT_SECONDS" <<'PY'
import sys

due_ms = int(float(sys.argv[1])) // 4096
minimum_ms = int(sys.argv[2]) + int(sys.argv[3]) * 1000
print(f"delayed_due_ms={due_ms} minimum_ms={minimum_ms}")
if due_ms <= minimum_ms:
    raise SystemExit("delayed job is not due beyond the device-lock timeout")
PY

redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$PLAN_KEY" \
  | jq . | tee /tmp/lock-loss-plan-delayed.json
AFTER_ATTEMPT="$(jq -r '.steps[] | select(.step_name == "deploy_os") | .attempt' /tmp/lock-loss-plan-delayed.json)"
AFTER_BULL_ATTEMPTS="$(redis-cli -u "$BRIDGE_REDIS_URL" --raw HGET "$BULL_JOB_KEY" atm)"
AFTER_BULL_ATTEMPTS="${AFTER_BULL_ATTEMPTS:-0}"

test "$AFTER_ATTEMPT" = "$BEFORE_ATTEMPT"
test "$AFTER_BULL_ATTEMPTS" = "$BEFORE_BULL_ATTEMPTS"
test "$(jq -r '.metadata.rewound // false' /tmp/lock-loss-plan-delayed.json)" = false
```

The three assertions are the invariants: no saga attempt increment, no BullMQ attempt increment, and no recovery rewind.

### Force the second bridge to claim and verify completion

BullMQ has no worker affinity, so stop the first bridge only after the delayed-state assertions. This makes the second bridge claim deterministic without changing the lock-loss path under test:

```bash
set -euo pipefail
SECOND_BRIDGE="$(test "$FIRST_BRIDGE" = spoke && printf spoke-1 || printf spoke)"
process-compose -U -u "$PC_SOCKET_PATH" process stop "$FIRST_BRIDGE"

SECOND_LOG="$LOG_DIR/$SECOND_BRIDGE.stdout.log"
until rg -q "Starting saga .*${PLAN_ID}" "$SECOND_LOG"; do sleep 2; done

until test "$(
  redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$PLAN_KEY" | jq -r '.status'
)" = complete
do
  sleep 5
done

redis-cli -u "$BRIDGE_REDIS_URL" --raw GET "$PLAN_KEY" \
  | jq . | tee /tmp/lock-loss-plan-final.json
until test "$(psql "$HUB_DATABASE_URL" -At -c \
  "SELECT \"lifecycleStatus\" FROM \"Server\" WHERE \"deviceId\" = '$DEVICE_ID'")" = PROVISIONED
do
  sleep 5
done

rg -e "$PLAN_ID" \
  -e 'Lock renewal failed' \
  -e 'lock lost' \
  -e 'rescheduled to delayed' \
  "$FIRST_LOG" "$SECOND_LOG" | tee /tmp/lock-loss-bridge-handoff.log

process-compose -U -u "$PC_SOCKET_PATH" process start "$FIRST_BRIDGE"
```

The saved plan snapshots, delayed-set dump, and two-bridge log excerpt are the review artifacts. The final plan must be `complete`, the hub lifecycle must be `PROVISIONED`, and the second bridge log must contain the resumed `Starting saga` line.

### Limitations

- The helper only mutates one exact device-lock key on loopback Redis; it is not wired into bridge runtime code or production configuration.
- Lock loss is observed at the next renewal and enforced between saga steps. It cannot cancel an already-running SSH, BMC, or agent operation.
- Replacing the token is the deterministic timeout case. Deleting it permits immediate acquisition and is useful only when timeout gating is not under test.
- Stopping the first bridge after the delayed transition controls which competing worker resumes; without that step either healthy same-zone bridge may reclaim the job.
