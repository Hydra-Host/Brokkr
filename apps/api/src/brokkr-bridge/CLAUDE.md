# Brokkr Bridge Module

## What is the Bridge?

Brokkr uses a **hub-and-spoke architecture** for managing bare-metal hardware across data center zones.

- **Hub** (this API) is the central control plane. It decides what operations to perform and tracks their progress.
- **Bridges** are remote agents deployed in each data center zone. They sit on the local network and execute physical operations on hardware: provisioning OSes, power cycling servers, running benchmarks, discovering hardware specs, and monitoring health.

Communication between hub and bridges is **asynchronous via BullMQ over a shared Redis instance**. The hub never talks to bridges directly -- it enqueues jobs, and bridges enqueue results back.

## Hub-to-Bridge Communication

The hub sends work to bridges via `BridgeQueueService.enqueueSagaJob()`. Each zone has its own isolated BullMQ queue whose prefix is the **Zone UUID** (`Zone.id`), which must match the bridge's `BROKKR_ZONE_ID` / `REDIS_PREFIX` (see `queue/bridge-queue.service.ts`). The same `{Zone.id}:` namespace prefixes the Redis config atoms the bridge reads.

Jobs are enqueued as `saga.run` messages to the zone's `lifecycle` queue. Each job contains:

- **`saga_name`** -- which workflow to run (see Saga Pattern below)
- **`plan_id`** -- a UUID that tracks this job across both directions
- **`device_id`** -- target device
- **`payload`** -- saga-specific configuration (credentials, OS image, etc.)

## Bridge-to-Hub Communication

All bridges write results to a single shared `results:inbox` queue. `BridgeResultsConsumer` listens on this queue and dispatches by job name:

| Job Name             | Meaning                                            | Hub Reaction                                              |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------- |
| `job.result`         | Step-level progress (a saga step completed/failed) | Updates device status, stores step results                |
| `job.completed`      | Entire saga finished                               | Final device status update, triggers downstream workflows |
| `discovery.complete` | Hardware collection finished for a zone            | Runs discovery processor pipeline to sync device data     |
| `heartbeat`          | Periodic zone health check with per-device status  | Stores heartbeat records, updates zone online/offline     |
| `device_health`      | Individual device health check result              | Stores DeviceHealthCheck record                           |

## Bridge Presence Auto-Provisioning

`BridgePresenceReconcilerService` (30s cron) reads `*:bridge:instance:*` Redis hashes published by each spoke and provisions zone networking in the hub DB: `Device` (role=Bridge) + `Bridge` rows, `Interface` + `IpAddress` rows per NIC, roleless `Prefix` rows for each interface's subnet, and `Gateway` + gateway `IpAddress` rows when the bridge reports a default-route gateway. All upserts run inside a Prisma transaction with advisory locks (`pg_advisory_xact_lock`) scoped per org/zone to serialize concurrent reconcile ticks.

The optional `InterfaceEntry.gateway` field (added to the wire format) carries the parsed default-route gateway IP per NIC from `/proc/net/route`. `ensureGateways()` selects the most-specific (longest-mask) containing Prefix via `ORDER BY masklen(prefix) DESC LIMIT 1`, then finds or creates an `IpAddress` (scoped to the prefix's VRF to prevent cross-zone/VRF IP collision) and a `Gateway` row with `routingPriority=100`. `Prefix.gatewayIpId` is set atomically (WHERE guard) only when null -- operator-entered gateways always win.

Old bridges that omit the `gateway` field are backward-compatible: the reconciler skips gateway provisioning for those entries.

## Saga Pattern

A **saga** is a named multi-step workflow dispatched to a bridge. The hub tells the bridge what to do, the bridge executes each step, and reports progress back step-by-step.

Available sagas:
`provision`, `deprovision`, `commission`, `benchmarks`, `redfish`, `network_scan`, `inventory_collection`, `ipxe_build`, `sync`, `reboot`, `power_on`, `power_off`, `power_status`, `device_health_check`, `bmc_reset`

Each step result includes the `plan_id` so the hub can correlate results to the original job.

## Heartbeat Flow

Bridges send periodic `heartbeat` messages containing zone identity and an array of per-device health checks (reachability, BMC status, power state). The hub:

1. Stores a `BridgeHeartbeat` record
2. Updates `ZoneStatus` (online/offline tracking)
3. Stores individual `DeviceHealthCheck` records per device
4. Opens a support ticket via the configured alerting/helpdesk integration if a zone misses heartbeats

## Submodules

### `queue/`

BullMQ integration. `BridgeQueueService` creates and manages per-zone queues for sending jobs. `BridgeResultsConsumer` runs a shared worker that processes all incoming results from bridges.

### `lifecycle/`

Device lifecycle operations that prepare and dispatch saga jobs. Each service handles a specific workflow:

- **Commissioning** -- register a new device with a bridge
- **Provisioning** -- deploy an OS to a server
- **Deprovisioning** -- wipe and reset a device
- **Power control** -- power on/off/cycle/reboot/status
- **Qualify orchestration** -- validate hardware meets expected specs
- **Network scan** -- scan the zone network
- **Lifecycle preparation** -- shared setup logic (resolve device context, build payloads)

### `discovery/`

Processes hardware discovery data that bridges collect from devices. When a bridge finishes scanning its zone, it sends a `discovery.complete` result. The hub then runs a pipeline of **processors** (one per data domain) to sync the collected data into the database:

- Device metadata, CPU/GPU/memory/disk info, network interfaces, BMC config, tags, storage layouts, primary IPs, OS availability, OEM info, VRF, monitoring config, custom fields, version info, and associated bridge records.

`DiscoveryIngressService` buffers partial discovery data. `DiscoveryDeviceSyncService` handles creating/updating device records. `DiscoveryS3UploadService` archives raw discovery payloads to S3 object storage.

### `benchmarks/`

GPU and hardware benchmark test runs. Stores benchmark results from bridge-reported saga steps and manages test run records.

### `constants/`

Queue names, discovery constants, and lifecycle constants.

### `types/`

Shared TypeScript types and Zod schemas for queue messages, discovery data, BIND DNS config, and lifecycle operations.

## Render Requests

A `render.request` is a bridge → hub job pushed onto the shared `results:inbox` queue when a bridge needs an atom that's missing from its Redis view. The hub resolves the entity, produces the atom, and writes it back to the zone-prefixed Redis key the bridge polls.

The envelope is defined in `types/render-request.types.ts`:

| Field        | Required | Notes                                                                                                                   |
| ------------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `request_id` | yes      | UUID — idempotency / log correlation token chosen by the bridge.                                                        |
| `zone_id`    | yes      | UUID — atom-key prefix the bridge polls.                                                                                |
| `bridge_id`  | yes      | Identifier of the bridge instance enqueueing the request.                                                               |
| `domain`     | yes      | Closed enum: `device_record` / `server_token` / `netplan`. Variant-specific param validation is done in the dispatcher. |
| `reason`     | no       | One of `missing` / `stale` / `explicit`.                                                                                |
| `params`     | no       | Arbitrary `record` — schema is enforced by the dispatcher branch for the domain.                                        |

`BridgeResultsConsumer.handleRenderRequest()` parses the envelope and forwards to `RenderRequestDispatcher.dispatch()`. The dispatcher throws `NotImplementedException` for any unhandled domain; the consumer catches that and acks the job. Malformed payloads also ack — a retry loop on bad data is worse than a logged drop. Any other dispatcher error re-throws so BullMQ retries.

**Adding a render domain**: convert `dispatch()` into a switch on `req.domain`, validate `req.params` against the variant schema, resolve the entity, build the atom, and write it via `ConfigAtomWriter`.

## Atom Envelope

Every atom the hub writes to Redis is wrapped in a canonical envelope (defined in `common/redis/atom-envelope.types.ts`):

```json
{
  "status": "ok" | "failed",
  "value":  <variant-specific>,    // present iff status === 'ok'
  "reason": "<short-string>",        // present iff status === 'failed'
  "written_at": 1730000000123,       // unix ms timestamp (capture on write)
  "request_id": "<uuid>" | null      // correlates back to render.request; null for unsolicited writes
}
```

Discriminated on `status`, `extra: strict` — no unknown fields.

- **Success**: `ConfigAtomWriter.writeAtomJson()` / `writeAtomString()` wrap the value as `status: 'ok'`.
- **Failure**: `ConfigAtomWriter.writeAtomError(reason, shortTtl)` writes `status: 'failed'` at the **same** atom key with a SHORT TTL. This is a negative-cache pattern (DNS-style NXDOMAIN) — the bridge reader sees the marker and short-circuits its polling without needing a separate fail-marker key (no TOCTOU between "absent" and "failed").
- **Read**: `ConfigAtomWriter.readAtom(zoneId, key, valueSchema)` returns `null` on absent / `status: 'failed'`, throws on malformed JSON or envelope/value schema mismatch, or returns the typed unwrapped `value` on `status: 'ok'`. One Redis GET per poll cycle on the bridge side.

`writeStringNx` and `writeMulti` are **not** envelope-aware — they back inflight dedup and transactional multi-key writes respectively. Callers writing atom payloads through `writeMulti` are responsible for pre-wrapping with the envelope.

The shape is mirrored exactly on the spoke side. Do not diverge without coordinating both repos.

### Device atom key paths

Per-device atoms are keyed `device:{deviceId}:<segment>` (the zone UUID prefix is prepended by `ConfigAtomWriter`). The unprefixed key builders live in `common/redis/redis-keys.ts`:

| Atom                     | Unprefixed key                               | Envelope?  | TTL                     |
| ------------------------ | -------------------------------------------- | ---------- | ----------------------- |
| Device record            | `device:{deviceId}:device_record`            | yes        | none (placeholder: 24h) |
| Server token             | `device:{deviceId}:server_token`             | yes        | —                       |
| Netplan                  | `device:{deviceId}:config:netplan:{phase}`   | yes        | 20m (live)              |
| iPXE url                 | `device:{deviceId}:config:ipxe_url`          | no (plain) | 1h                      |
| Rescue ssh keys          | `device:{deviceId}:rescue:ssh_pub_keys`      | no (plain) | 24h                     |
| **Sealed device secret** | `device:{deviceId}:secrets:{purpose}:{kind}` | yes        | none                    |

### Per-prefix atom key paths

Not every atom is per-device. Two atoms are keyed **per-prefix** and live in their own namespace:

| Atom        | Unprefixed key                  | Envelope? | TTL  |
| ----------- | ------------------------------- | --------- | ---- |
| VRRP VIP    | `prefix:{prefixId}:config:vrrp` | yes       | none |
| DHCP config | `prefix:{prefixId}:config:dhcp` | yes       | none |

Unlike device atoms (point-read by id, with render-on-miss backstop via `RenderRequestDispatcher`), the bridge discovers the full VIP set by **SCAN**ning `{zoneUuid}:prefix:*:config:vrrp` and reconciles each tick — so there is no per-key render-on-miss. The hub is authoritative: `VrrpRedisWriterService.set` publishes `{ vip, ifaceByBridge }` (host/mask CIDR + a per-bridge NIC map keyed by `Device.name`), `clear` DELs. The iface is per-bridge because a zone's bridges can name the VIP-facing NIC differently; the map is composed from the `PrefixVrrpBinding` table (prefix + bridge FK + iface), and a bridge whose `Device.name` isn't in the map never binds the VIP (no silent name-mismatch black hole). Value schema: `brokkr-bridge/vrrp/vrrp-atom.schema.ts`. The hub writer fires from `PrefixService.setPrefixVrrpVip`/`clearPrefixVrrpVip` (and archive teardown).

Because the write is post-commit and non-transactional, `VrrpReconcilerService` (`brokkr-bridge/vrrp/vrrp-reconciler.service.ts`) runs every minute as the eventual-consistency backstop: it re-derives the full desired VIP set from `PrefixRepository.listAllVrrpVipBearingPrefixes` (cross-tenant, no request context), SCANs the published atoms, and converges Redis to match — republishing anything missing/stale, clearing anything orphaned (including atoms left under a prefix's old zone after a relocation). **Bridge-side reader: `apps/bridge/src/vrrp/`** — see the root `CLAUDE.md`'s "VRRP virtual-IP failover" section for the reconcile/GARP mechanics and the safety-critical shutdown-ordering requirement.

The **DHCP config** atom is the **sole source** of the bridge's DHCP (and DNS) service configuration — the bridge reads no DHCP service policy from env vars. It follows the same SCAN-discovered, hub-authoritative pattern as VRRP: `DhcpConfigRedisWriterService` publishes per-prefix, and `DhcpConfigReconcilerService` (`brokkr-bridge/dhcp/`) runs on a cron as the eventual-consistency backstop — it re-derives the desired set from every DHCP-enabled prefix (`PrefixRepository`), SCANs `{zoneUuid}:prefix:*:config:dhcp`, converges Redis, and clears orphans. The value is derived by `DhcpDerivationService` from the `Prefix` (`dhcpMode`, `dhcpLeaseTtlSeconds` — defaulting to 600 when unset, `dhcpOptions`, `ipxeBuildTarget`) plus its `IpRange` pools, gateway (routers), device-interface reservations, and relay — there is no separate DHCP table (derive-minimal). `nextServer` and `dnsServers` are emitted as null/empty in the atom for directly-attached prefixes (the bridge self-derives both from its own IP and peers); for relayed prefixes the hub derives them from the bridge-device IPs inside the prefix's `associatedPrefix` (`nextServer` only when `ipxeBuildTarget` is set), since the bridge cannot self-derive a cross-subnet address. Relayed `dnsServers` are one IP per bridge (inet-ascending, VIP rows excluded), zone-global rather than serving-bridge-first, and emitted only when the associated prefix is itself DHCP-served (same NAT role/slug/tag exclusions as the served-prefix query; bridge IPs materialized by presence carry a NULL vrfId, so the relay join tolerates NULL-vrf rows inside a VRF-scoped associated prefix). Value schema: `dhcp-atom.schema.ts`, mirrored on the spoke as `dhcp-atom-value.schema.ts` (agreement asserted by `dhcp-schema-agreement.spec.ts`). Shape: `{ mode: AUTHORITATIVE|PROXY|OFF, subnet, pools[], routers[], dnsServers[], leaseTtlSeconds, reservations[], dhcpOptions[], nextServer, ipxeBuildTarget, relay }`. **Bridge-side:** `apps/bridge/src/dhcp/` — `dhcp-config-reader.service.ts` SCANs+parses, `dhcp-atom-mapper.ts` maps atoms to shared-network subnets, `dhcp-manager.service.ts` builds/hot-swaps the engine (rebuild on change, tear down when no atoms). The **same** atom set drives the bridge DNS bind list via `atomServedInterfaceIps` — DNS listens on exactly the interfaces that host a DHCP subnet. See the root `CLAUDE.md`'s "DHCP hub control" section for the higher-level pattern and reconciliation strategy, and `apps/bridge/README.md` for the engine / DNS / HA details.

The **sealed device secret** atom carries the zone-SEALED credential blob (auth-DH ciphertext — never plaintext; the username/password live inside `ciphertext`). `purpose`/`kind` are lowercased in the key (e.g. `secrets:bmc:user`) to match the all-lowercase key convention, mirroring the `DeviceSecret @@index([deviceId, purpose, kind])`. The hub writer is `DeviceSecretAtomPublisher.publishCurrent(deviceId, purpose, kind)` (`apps/api/src/device-secret/`): it pulls the narrowest live, openable, current-generation seal via `DeviceSecretService.getCurrentSealedByKind` — an invalidated or stale-key secret is never published — and writes the envelope value validated against `DeviceSecretAtomSchema` (`device-secret-atom.schema.ts`). The hub cannot open the blob; only the zone's bridge (holder of `zone_priv`) can. **No bridge-side consumer is wired yet (deferred)** — this is the hub writer + atom contract (path/schema) only.

## Top-Level Services

- **`bind-config.service.ts`** -- Generates BIND DNS zone configuration for bridges.
