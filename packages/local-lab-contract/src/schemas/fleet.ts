import { z } from 'zod';

import { BOOT_SEVERITIES } from '@repo/utils';
import { CcBuildSchema } from './common';

export const NodeKindSchema = z
  .enum(['vm', 'baremetal'])
  .describe(
    "Which plane a fleet machine belongs to: 'vm' = a libvirt domain with a simulated BMC; 'baremetal' = a real machine with a real BMC",
  );
export type NodeKind = z.infer<typeof NodeKindSchema>;

export const BmcProbeSchema = z.object({
  reachable: z
    .enum(['ok', 'auth-failed', 'unreachable', 'unconfigured'])
    .describe(
      "Outcome of the lab's read-only Redfish probe: ok = answered and accepted the credential; auth-failed = answered 401/403; unreachable = no usable answer inside the probe timeout; unconfigured = no BMC address or credential is saved for the node",
    ),
  powerState: z.string().nullable().describe('Raw Redfish PowerState when reachable is ok; null otherwise'),
});
export type BmcProbe = z.infer<typeof BmcProbeSchema>;

export const MachineSchema = z.object({
  name: z.string().describe('Fleet node name (e.g. cpu-1)'),
  kind: NodeKindSchema.describe('Plane the row was resolved from — drives which actions the UI offers'),
  power: z
    .enum(['on', 'off', 'unknown'])
    .describe(
      "Machine power state — the libvirt domain on the vm plane, the BMC-reported chassis state on the bare-metal plane; 'unknown' when it could not be read",
    ),
  configured: z
    .boolean()
    .describe('In the active fleet config (false = a running domain not in config — rebuild to adopt)'),
  deviceId: z
    .string()
    .nullable()
    .describe('Index-derived hub Device.id; null for an unconfigured domain, which has no fleet index to derive from'),
  bmc: BmcProbeSchema.nullable().describe(
    'Live BMC probe for a bare-metal row; null for a VM row, whose power comes from libvirt',
  ),
});
export type Machine = z.infer<typeof MachineSchema>;

export const HostInfoSchema = z.object({
  os: z.string().describe("Node platform — 'linux' | 'darwin' | …"),
  arch: z.string().describe("'amd64' | 'arm64' | …"),
  passthroughSupported: z.boolean().describe('PCI passthrough possible (linux/amd64)'),
  ccBuild: CcBuildSchema.describe(
    'Build stamp of the running control-center server: the sha its dist was built from, the live checkout HEAD, and the checkout-skew flag',
  ),
});
export type HostInfo = z.infer<typeof HostInfoSchema>;

export const PciDeviceSchema = z.object({
  addr: z.string().describe('Host PCI address, e.g. 0000:01:00.0'),
  type: z.enum(['nvidia-gpu', 'amd-gpu', 'gpu', 'mellanox', 'nic']),
  label: z.string().describe('Human label incl. [vendor:device]'),
});
export type PciDevice = z.infer<typeof PciDeviceSchema>;

export const DiskSpecSchema = z.object({
  size_gb: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Extra data-disk size in GiB; the engine defaults to 40 when omitted'),
  type: z
    .enum(['ssd', 'hdd', 'nvme'])
    .optional()
    .describe("Disk backing type; the engine defaults to 'ssd' when omitted"),
});

export const NicSpecSchema = z.object({
  mac: z.string(),
  model: z.enum(['virtio', 'e1000e', 'e1000', 'rtl8139', 'vmxnet3']),
  mtu: z.number().int().min(1280).max(9000).nullable(),
  link: z.enum(['up', 'down']),
});
export type NicSpec = z.infer<typeof NicSpecSchema>;

export const BmcCredsSchema = z.object({ username: z.string(), password: z.string() });
export type BmcCreds = z.infer<typeof BmcCredsSchema>;

export const NetworkTypeSchema = z
  .enum(['nat', 'public'])
  .describe('Data-plane attachment mode, seeded onto the hub Device.networkType');

export const FleetPlanesSchema = z.object({
  vm: z.boolean().describe('True when at least one VM node is enabled — the simulated libvirt plane runs'),
  baremetal: z
    .boolean()
    .describe('True when at least one bare-metal machine is saved — the PXE plane runs on the uplink NIC'),
});
export type FleetPlanes = z.infer<typeof FleetPlanesSchema>;

export const HostNicSchema = z.object({
  name: z.string().describe('Kernel interface name, e.g. enp35s0'),
  mac: z.string().describe('Interface hardware (MAC) address'),
  ipv4: z.string().nullable().describe('Primary IPv4 with prefix, e.g. 192.168.1.42/24; null if the NIC has no IPv4'),
  up: z.boolean().describe('Link/oper state — true when the NIC is up'),
});
export type HostNic = z.infer<typeof HostNicSchema>;

export const BareMetalArchSchema = z
  .enum(['amd64', 'arm64'])
  .describe('Machine CPU architecture — drives which discovery images the bridge syncs and serves');

export const BareMetalNodeSchema = z.object({
  name: z.string().describe('Operator-chosen machine name (unique within the bare-metal fleet)'),
  bmc_ip: z.string().describe('The real BMC IPv4 the lab talks Redfish to'),
  bmc_mac: z.string().describe('BMC NIC MAC — required; seeds the IPMI Interface row on the hub'),
  pxe_mac: z.string().describe('MAC of the data NIC that firmware-PXE-boots — the DHCP proxy allowlist key'),
  arch: BareMetalArchSchema.nullable().describe('Per-node arch override; null = inherit the fleet default'),
  zone: z
    .string()
    .nullish()
    .describe(
      'Hub Zone.name this machine belongs to; absent/null = the single default zone, which stops being enough once the fleet declares more than one',
    ),
  system_id: z
    .string()
    .nullable()
    .describe('Optional Redfish System id for multi-System/blade chassis; null = use /redfish/v1/Systems Members[0]'),
  network_type: NetworkTypeSchema.nullish().describe(
    "Per-machine attachment override; absent/null = the engine default ('public', since the machine is LAN-reachable)",
  ),
});
export type BareMetalNode = z.infer<typeof BareMetalNodeSchema>;

export const BareMetalNodeWriteSchema = BareMetalNodeSchema.extend({
  bmc_user: z
    .string()
    .nullable()
    .describe('Per-node BMC username (write-only); null/blank = inherit the defaults row. Never returned by GET.'),
  bmc_pass: z
    .string()
    .nullable()
    .describe('Per-node BMC password (write-only); null/blank = inherit the defaults row. Never returned by GET.'),
});
export type BareMetalNodeWrite = z.infer<typeof BareMetalNodeWriteSchema>;

export const BareMetalConfigSchema = z.object({
  nics: z
    .array(z.string())
    .describe('Host uplink NIC name(s) the bridge binds DHCP proxy/TFTP to (v1: single-element)'),
  arch: BareMetalArchSchema.describe('Default architecture of the bare-metal machines'),
  nodes: z.array(BareMetalNodeSchema).describe('Configured bare-metal machines (no credentials)'),
});
export type BareMetalConfig = z.infer<typeof BareMetalConfigSchema>;

export const BareMetalConfigWriteSchema = z.object({
  nics: z.array(z.string()).describe('Host uplink NIC name(s) to bind DHCP proxy/TFTP to (v1: single-element)'),
  arch: BareMetalArchSchema.describe('Default architecture of the bare-metal machines'),
  bmcDefaults: BmcCredsSchema.describe(
    'Default BMC creds applied to any node that omits its own — stored in the 0600 secrets file, never the overlay',
  ),
  nodes: z.array(BareMetalNodeWriteSchema).describe('Bare-metal machines to persist, each with write-only creds'),
});
export type BareMetalConfigWrite = z.infer<typeof BareMetalConfigWriteSchema>;

export const BareMetalPowerActionSchema = z
  .enum(['on', 'off', 'reset', 'powercycle'])
  .describe('Chassis power action issued to the node BMC over Redfish ComputerSystem.Reset');
export type BareMetalPowerAction = z.infer<typeof BareMetalPowerActionSchema>;

// Mirrors the simulator loader (local/schema.py, local/derived.py): a console_port outside this
// range, or one whose effective value collides with another node's, is rejected there at apply time.
export const CONSOLE_PORT_MIN = 1024;
export const CONSOLE_PORT_MAX = 65535;
export const CONSOLE_PORT_BASE = 9300;

export const FleetNodeSchema = z.object({
  name: z.string(),
  zone: z.string().describe('Hub Zone.name this node belongs to (e.g. sim-zone1) — drives the per-node zone selector'),
  ipmi_mac: z.string(),
  data_mac: z.string(),
  cpus: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('Per-node vCPU override; null inherits fleet defaults.cpus. A written value pins this node'),
  memory_mb: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('Per-node RAM override in MiB; null inherits fleet defaults.memory_mb'),
  disk_gb: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('Per-node OS-disk override in GB; null inherits fleet defaults.disk_gb'),
  arch: z
    .string()
    .nullable()
    .describe(
      'Per-node CPU architecture override (amd64 / arm64); null inherits fleet defaults.arch. Free-form because the engine types it as a plain string and derives its own default from the host',
    ),
  disks: z.array(DiskSpecSchema),
  passthrough: z.array(z.string()),
  nics: z.array(NicSpecSchema),
  data_mtu: z.number().int().min(1280).max(9000).nullable(),
  network_type: NetworkTypeSchema.nullable().describe(
    "Data-plane attachment: 'nat' puts the node behind the host bridge, 'public' places it on the LAN. Null leaves the engine default",
  ),
  ip: z.string().nullable().describe('Static data-plane IP override; null = index-derived (.10, .11, …)'),
  bmc_ip: z
    .string()
    .nullable()
    .describe('Static BMC-plane IP override; null = index-derived. Applies on rebuild (vbmc re-register)'),
  bmc: BmcCredsSchema.nullable().describe('Per-node BMC creds override; null = inherit defaults.bmc'),
  console_port: z
    .number()
    .int()
    .min(CONSOLE_PORT_MIN)
    .max(CONSOLE_PORT_MAX)
    .nullish()
    .describe(
      `Slot-derived serial-console telnet port stamped by the Nix topology for stack slots >= 1, bounded to ${CONSOLE_PORT_MIN}..${CONSOLE_PORT_MAX} (the range the simulator's loader accepts); absent/null on slot 0, which derives ${CONSOLE_PORT_BASE} + index. Must survive a save — dropping it collapses this console onto the slot-0 ${CONSOLE_PORT_BASE} band.`,
    ),
  seed_as_server: z
    .boolean()
    .optional()
    .describe(
      'false → seed this node as a role=NULL commissioning candidate (IPMI-only, DHCP, no server row / static OS) so it can be discovered + commissioned; omitted/true = a normal provisioned server.',
    ),
});
export type FleetNode = z.infer<typeof FleetNodeSchema>;

export const FleetNodeEffectiveSchema = FleetNodeSchema.extend({
  effective_ip: z
    .string()
    .nullable()
    .describe(
      'Effective data-plane IP the node will get: the static `ip` override when set, else index-derived from network.cidr (network base + 10 + index) — the same rule as Python derived.effective_node_ip. Null when network.cidr is missing or malformed.',
    ),
  effective_bmc_ip: z
    .string()
    .nullable()
    .describe(
      'Effective BMC-plane IP: the static `bmc_ip` override when set, else index-derived from network.bmcCidr with the same base+10+index rule (derived.effective_bmc_ip). Null when network.bmcCidr is missing or malformed.',
    ),
  effective_cpus: z
    .number()
    .int()
    .positive()
    .describe('vCPUs this node actually gets: its own value, else the fleet default'),
  effective_memory_mb: z.number().int().positive().describe('RAM in MiB this node actually gets'),
  effective_disk_gb: z.number().int().positive().describe('OS-disk GB this node actually gets'),
});
export type FleetNodeEffective = z.infer<typeof FleetNodeEffectiveSchema>;

export const FleetDriftFieldSchema = z.object({
  field: z.string().describe('Changed node field name (resolved/effective value)'),
  from: z.string().describe('Applied value, JSON-stringified for display'),
  to: z.string().describe('Desired value, JSON-stringified for display'),
});

export const FleetPendingSchema = z.object({
  inSync: z.boolean().describe('True when the desired topology matches what is instantiated'),
  severity: z
    .enum(['in-sync', 'hot-appliable', 'needs-full-rebuild', 'planes-change', 'stale-bake'])
    .describe(
      'Coarse apply class; the apply planner refines it. `planes-change` means the desired plane set differs from the applied one — the fleet-planes-apply op, not an incremental or full topology apply. `stale-bake` means the topology matches but the boot binaries carry a chain URL that no longer resolves to this stack, so they need a re-bake rather than an apply.',
    ),
  desiredDigest: z.string().describe('sha256 of the desired canonical topology'),
  appliedDigest: z.string().nullable().describe('sha256 of the last-applied topology; null if never applied'),
  appliedAt: z.number().nullable().describe('Epoch seconds of the last successful bring-up; null if never applied'),
  summary: z
    .object({
      added: z.number().int().describe('Nodes desired but not yet instantiated'),
      removed: z.number().int().describe('Nodes instantiated but no longer desired'),
      changed: z.number().int().describe('Nodes whose instantiation-shaping fields changed'),
      unchanged: z.number().int().describe('Nodes identical between desired and applied'),
    })
    .describe('Counts driving the banner headline'),
  nodes: z
    .object({
      added: z
        .array(
          z.object({
            name: z.string().describe('Node name'),
            zone: z.string().describe('Hub Zone.name the node belongs to'),
          }),
        )
        .describe('Pending-add nodes'),
      removed: z
        .array(
          z.object({
            name: z.string().describe('Node name'),
            zone: z.string().describe('Hub Zone.name the node belonged to'),
          }),
        )
        .describe('Nodes that will drop on apply'),
      changed: z
        .array(
          z.object({
            name: z.string().describe('Node name'),
            fields: z.array(FleetDriftFieldSchema).describe('Per-field changes for this node'),
          }),
        )
        .describe('Per-node field-level changes'),
    })
    .describe('Per-node drift detail for the expandable view'),
  network: z
    .object({
      changed: z.boolean().describe('Data/BMC CIDR changed — forces a full rebuild'),
      fields: z.array(z.string()).describe('Which CIDR fields changed'),
    })
    .describe('Network-level drift'),
  note: z.string().nullable().describe('Degraded-mode note, e.g. no applied manifest yet'),
});
export type FleetPending = z.infer<typeof FleetPendingSchema>;

export const ApplyActionSchema = z.enum([
  'noop',
  'hot-node',
  'node-disk',
  'add-node',
  'remove-terminal-node',
  'full-rebuild-required',
]);

export const ApplyPlanSchema = z.object({
  fallbackFullRebuild: z
    .boolean()
    .describe('True when a change shifts node identity; apply collapses to a full nuke→rebuild'),
  reason: z.string().nullable().describe('Why a full rebuild is forced, when fallbackFullRebuild'),
  dataLoss: z.boolean().describe('Any item recreates a node disk (wipes that node only)'),
  etaSec: z.number().describe('Rough total ETA in seconds'),
  items: z
    .array(
      z.object({
        name: z.string().describe('Node name (or "network")'),
        action: ApplyActionSchema.describe('Cheapest safe action for this node'),
        reason: z.string().describe('Why this action / what changed'),
        fields: z.array(z.string()).describe('Changed field names'),
        etaSec: z.number().describe('Rough ETA for this item'),
        dataLoss: z.boolean().describe('This item wipes the node disk'),
      }),
    )
    .describe('Per-node plan items'),
});
export type ApplyPlan = z.infer<typeof ApplyPlanSchema>;

export const VerifyStatusSchema = z
  .enum(['healthy', 'findings', 'no-manifest'])
  .describe(
    'Overall fleet-verify outcome: healthy = every applied node checks out; findings = one or more issues; no-manifest = nothing applied yet.',
  );
export type VerifyStatus = z.infer<typeof VerifyStatusSchema>;

export const VerifyFindingKindSchema = z
  .enum([
    'no-manifest',
    'domain-undefined',
    'domain-not-running',
    'ipmi-sim-down',
    'sushy-down',
    'lo-alias-missing',
    'vmnet-socket-missing',
    'bootptab-missing',
    'orphan-domain',
    'bmc-unreachable',
    'bmc-auth-failed',
    'no-hub-device',
    'identity-split',
    'boot-readiness',
  ])
  .describe(
    'What a verify finding flags. domain-undefined and orphan-domain need an apply/adopt, and the four bare-metal kinds (bmc-unreachable, bmc-auth-failed, no-hub-device, identity-split) need an off-box fix — cabling, credentials, or a re-seed; the rest are daemon/binding repairs verify --heal can perform. boot-readiness carries a bridge or hub PXE-nnn code and leads its detail with that code and severity.',
  );
export type VerifyFindingKind = z.infer<typeof VerifyFindingKindSchema>;

export const VerifyFindingSchema = z.object({
  node: z
    .string()
    .nullable()
    .describe('Fleet node the finding is about; null for fleet-level findings (e.g. a missing bootptab)'),
  kind: VerifyFindingKindSchema.describe('Which check failed'),
  healable: z.boolean().describe('True when verify --heal can repair it in place (vs. needing a rebuild/apply)'),
  detail: z.string().describe('Human-readable explanation of the finding and its remedy'),
  code: z
    .string()
    .nullish()
    .describe('Boot diagnostic code (PXE-nnn) when the finding came from a readiness route; absent on engine findings'),
  ref: z
    .string()
    .nullish()
    .describe('Opaque id a UI can link on — the hub prefix id for a prefix readiness finding; absent otherwise'),
});
export type VerifyFinding = z.infer<typeof VerifyFindingSchema>;

export const FleetVerifyReportSchema = z.object({
  status: VerifyStatusSchema.describe('Overall verify outcome'),
  planes: FleetPlanesSchema.nullable()
    .default(null)
    .describe('Planes the applied manifest carries; null when the manifest is absent or the report predates planes'),
  findings: z.array(VerifyFindingSchema).describe('Every issue found, most useful first (node-level then fleet-level)'),
  summary: z
    .object({
      checked: z.number().int().describe('Number of nodes actually probed; zero when no per-node check ran'),
      ok: z.number().int().describe('Probed nodes with no node-level findings; a node never probed is not ok'),
      findings: z.number().int().describe('Total finding count (node-level plus fleet-level)'),
    })
    .describe('Counts driving the verify headline'),
});
export type FleetVerifyReport = z.infer<typeof FleetVerifyReportSchema>;

export const BootReadinessFindingSchema = z.object({
  code: z
    .string()
    .describe(
      'Boot diagnostic code (e.g. PXE-102) from the bridge registry — the vocabulary hub and lab findings share',
    ),
  severity: z.enum(BOOT_SEVERITIES).describe("'error' stops a machine booting; 'warn' and 'info' do not"),
});
export type BootReadinessFinding = z.infer<typeof BootReadinessFindingSchema>;

export { PREFIX_FINDING_CODES } from '@repo/utils';

export const BootReadinessReportSchema = z.object({
  findings: z
    .array(BootReadinessFindingSchema)
    .describe('Every check that did not pass — codes and severities only, never a MAC, address or credential'),
  counts: z
    .object({
      error: z.number().int().describe("'error' findings, which block a boot"),
      warn: z
        .number()
        .int()
        .describe(
          "'warn' findings, which do not block a boot; 'info' findings are listed but not counted, as on the bridge",
        ),
      unevaluated: z
        .number()
        .int()
        .describe('Checks whose subject was unreachable, so their result is unknown rather than passing'),
    })
    .describe(
      'Blocking, advisory and unevaluated totals, so a caller can headline the result without walking findings',
    ),
});
export type BootReadinessReport = z.infer<typeof BootReadinessReportSchema>;

export const BootTrailSchema = z.object({
  pxe: z
    .object({
      outcome: z
        .enum(['offered', 'refused-allowlist', 'no-subnet'])
        .describe('Last proxy-DHCP decision the bridge made for this MAC'),
      atMs: z.number().int().describe('Epoch ms of that decision'),
    })
    .nullable()
    .describe('Null when no PXE request from this MAC has reached the bridge inside the record window'),
  chainReached: z
    .boolean()
    .nullable()
    .describe(
      'True when iPXE from this MAC reached POST /api/chain — the bridge records every hit, known device or not, and mints discovery:pending for an unknown one; null when the bridge Redis could not be read (readError set)',
    ),
  chainAtMs: z
    .number()
    .int()
    .nullable()
    .describe(
      'Epoch ms of the last chain hit from this MAC. Null when no hit is recorded, when only the older discovery:pending marker proves the chain was reached, or when the bridge Redis could not be read',
    ),
  readError: z
    .string()
    .nullable()
    .describe('Set when the bridge Redis could not be read; the two fields above are then unknown, not false'),
});
export type BootTrail = z.infer<typeof BootTrailSchema>;

export const FleetDefaultsSchema = z.object({
  cpus: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('vCPUs every node with no own value inherits; null = the engine default (2)'),
  memory_mb: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('RAM in MiB inherited the same way; null = the engine default (4096)'),
  disk_gb: z
    .number()
    .int()
    .positive()
    .nullable()
    .describe('OS-disk GB inherited the same way; null = the engine default (40)'),
  arch: z
    .string()
    .nullable()
    .describe('CPU architecture inherited the same way; null = the engine default, which is the host architecture'),
});
export type FleetDefaults = z.infer<typeof FleetDefaultsSchema>;

export const FleetNetworkSchema = z.object({
  name: z.string().describe('libvirt network name the data plane is defined as (engine network.name)'),
  cidr: z.string().describe('Data-plane CIDR. Per-node IPs derive from it as the network base + 10 + index'),
  bmcCidr: z.string().describe('BMC out-of-band CIDR — the host loopback aliases ipmi_sim and sushy bind'),
  domain: z.string().describe('DNS search domain the fleet hands to its guests (engine network.domain)'),
  dhcp: z.boolean().describe('Seeded-prefix DHCP. Off by default, and macOS 26 and later disables vmnet DHCP outright'),
  renderedNetplan: z
    .boolean()
    .describe(
      "Make the fleet exercise the hub's netplan renderer instead of the override the seed writes. The engine refuses it on a multi-zone fleet and alongside dhcp, because both render the wildcard DHCP fallback and so prove nothing",
    ),
});
export type FleetNetwork = z.infer<typeof FleetNetworkSchema>;

export const FleetTombstoneSchema = z.object({
  name: z.string().describe('Node name an `enable = false` line in the overlay holds out of the fleet'),
  zone: z.string().describe('Zone the tombstone sits under, so a prune targets the right attribute path'),
  baseDeclared: z
    .boolean()
    .describe(
      'The committed base topology still declares this node, so the tombstone is what holds it out. A prune would restore the node on the next eval, so the write path refuses it',
    ),
});
export type FleetTombstone = z.infer<typeof FleetTombstoneSchema>;

export const FleetConfigSchema = z.object({
  source: z
    .enum(['local', 'default'])
    .describe("'local' = the stack overlay customizes the fleet; 'default' = the committed base"),
  planes: FleetPlanesSchema.describe(
    'Derived from the two rosters; read-only — remove every node of a plane to turn it off',
  ),
  baremetal: BareMetalConfigSchema.describe(
    'Persisted bare-metal config (returned even when the plane is off; empty defaults when never configured). Never carries credentials.',
  ),
  bakedChainUrl: z
    .string()
    .nullable()
    .describe('The iPXE chain URL baked into the boot binaries; null when unknown. Drives the stale-bake chip.'),
  nodes: z.array(FleetNodeEffectiveSchema),
  zones: z
    .array(z.string())
    .describe('Available zone names (Hub Zone.name) in render order — populates the per-node zone selector'),
  network: FleetNetworkSchema.describe(
    'Both network planes. cidr and bmcCidr drive the derived per-node IPs (base + 10 + index)',
  ),
  tombstones: z
    .array(FleetTombstoneSchema)
    .describe('Removed nodes the overlay still carries as `enable = false`. Nothing prunes them, so they accumulate'),
  bmcDefaults: BmcCredsSchema.describe(
    'Default BMC creds (fleet defaults.bmc) — applied to the fleet on rebuild/re-seed',
  ),
  pending: FleetPendingSchema.optional().describe(
    'Desired-vs-applied drift for this fleet (drives the pending banner)',
  ),
  defaults: FleetDefaultsSchema.describe(
    'Fleet-wide fallbacks. A node leaves a field null to inherit one; before this existed the read path folded them into every node and the write path wrote the folded value back, so changing a default changed nothing',
  ),
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

export const ExecResultSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
  exit_code: z.number().int().describe('255 = ssh transport failure, 124 = lab-side timeout, else remote exit status'),
  duration_ms: z.number().int(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const ConsoleLogSchema = z.object({
  content: z.string().describe('Serial-console log slice; tail_bytes-bounded'),
  bytes: z.number().int().describe('Total file size at read time'),
  truncated: z.boolean().describe('True if content is the tail of a larger file'),
});

export const LayersManifestRequireSchema = z
  .object({
    group: z.string().describe('Group slug the dependency lives in'),
    layers: z.array(z.string()).describe('Dependency layer names — any one satisfies the requirement'),
  })
  .passthrough();
export type LayersManifestRequire = z.infer<typeof LayersManifestRequireSchema>;

export const LayersManifestLayerSchema = z
  .object({
    name: z.string().describe('Layer name — unique within its group; the dependency-graph node id'),
    kind: z.string().describe("Layer kind (e.g. 'base' | 'component' | 'legacy') — drives the viewer's kind dot"),
    group: z.string().describe('Slug of the group this layer belongs to'),
    arch: z.string().describe('CPU architecture this artifact targets (e.g. amd64, arm64)'),
    display_name: z.string().optional().describe('Human-friendly label; falls back to name when absent'),
    version: z.string().nullish().describe('Layer version string; null/absent when unversioned'),
    os_distro: z.string().optional().describe('OS distro this artifact is built for (e.g. ubuntu)'),
    os_codename: z.string().optional().describe('OS codename this artifact is built for (e.g. jammy)'),
    variant: z.string().nullish().describe('Optional build variant tag; null/absent when none'),
    sha256: z.string().optional().describe('Artifact blob sha256 — the prime/nuke cache key'),
    size: z.number().optional().describe('Artifact blob size in bytes'),
    built_at: z.string().optional().describe('Build timestamp of the artifact'),
    source_version: z
      .string()
      .nullish()
      .describe('Upstream source version the artifact was built from; null/absent when unknown'),
    requires: z
      .array(LayersManifestRequireSchema)
      .optional()
      .describe('Cross-group dependencies this artifact declares'),
  })
  .passthrough();
export type LayersManifestLayer = z.infer<typeof LayersManifestLayerSchema>;

export const LayersManifestGroupSchema = z
  .object({
    slug: z.string().describe('Stable group identifier referenced by layers[].group and requires[].group'),
    name: z.string().describe('Human-friendly group name shown as the section header'),
    selection_type: z
      .string()
      .describe('How many layers may be chosen from this group (e.g. SINGLE_SELECT | MULTI_SELECT)'),
  })
  .passthrough();
export type LayersManifestGroup = z.infer<typeof LayersManifestGroupSchema>;

export const LayersManifestSchema = z
  .object({
    groups: z.array(LayersManifestGroupSchema).describe('Layer groups (dependency-graph partitions) in the release'),
    layers: z.array(LayersManifestLayerSchema).describe('Every layer artifact in the release'),
    schema_version: z.number().optional().describe('Manifest schema version'),
    version: z.string().optional().describe('Release version string'),
    env: z.string().optional().describe('Environment the release was built for (e.g. dev, prod)'),
    generated_at: z.string().optional().describe('When the manifest was generated (ISO timestamp)'),
    pipeline_id: z.number().optional().describe('CI pipeline id that produced the release'),
  })
  .passthrough()
  .describe(
    'OS-layers release manifest — external pipeline-owned data; only the fields the control center dereferences are typed, everything else passes through',
  );
export type LayersManifest = z.infer<typeof LayersManifestSchema>;
