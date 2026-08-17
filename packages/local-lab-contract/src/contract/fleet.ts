import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import {
  ApplyPlanSchema,
  BareMetalConfigWriteSchema,
  BareMetalPowerActionSchema,
  BmcCredsSchema,
  ConsoleLogSchema,
  ExecResultSchema,
  FleetConfigSchema,
  FleetModeSchema,
  FleetNodeSchema,
  FleetVerifyReportSchema,
  HostInfoSchema,
  HostNicSchema,
  LayersManifestSchema,
  MachineSchema,
  PciDeviceSchema,
} from '../schemas/fleet';

export const fleetRoutes = {
  listMachines: {
    method: 'GET',
    path: '/api/fleet/machines',
    responses: { 200: z.array(MachineSchema) },
    summary: 'List fleet VMs with power state',
    description:
      'Read-only roster of simulated fleet VMs with current power state, used to render the fleet panel; interactive console access is a separate WebSocket at /api/fleet/shell?node=.',
  },
  powerMachine: {
    method: 'POST',
    path: '/api/fleet/machines/power',
    body: z.object({ name: z.string(), action: z.enum(['on', 'off', 'cycle']) }),
    responses: { 200: z.object({ runId: z.string() }), 404: ErrorBodySchema, 409: ErrorBodySchema },
    summary: 'Power a VM on/off/cycle',
    description:
      'Drives the power action through the simulated Redfish BMC (exercising the real provisioning path) and returns a runId whose progress streams over SSE. Returns 404 for an unknown VM. Returns 409 while another power/discover op holds this node or a reset/stack fleet op is running. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  discoverMachine: {
    method: 'POST',
    path: '/api/fleet/machines/discover',
    body: z.object({ name: z.string() }),
    responses: { 200: z.object({ runId: z.string() }), 404: ErrorBodySchema, 409: ErrorBodySchema },
    summary: 'Force hardware rediscovery on a node',
    description:
      'Forces inventory_collection on the node so discovery recomposes storageLayouts from its real disks, reflecting the VM as currently configured; returns a runId that streams over SSE. Use after changing a node disk topology. Returns 404 for an unknown VM. Returns 409 while another power/discover op holds this node or a reset/stack fleet op is running. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  resetMachine: {
    method: 'POST',
    path: '/api/fleet/machines/reset',
    body: z.object({ name: z.string() }),
    responses: { 200: z.object({ runId: z.string() }), 404: ErrorBodySchema, 409: ErrorBodySchema },
    summary: 'Reset a node to clean INVENTORY',
    description:
      'Destructive: tears the node back to INVENTORY by closing active Reservations + Deployments, setting Server.lifecycleStatus=INVENTORY, deleting Job history, and DEL-ing spoke Redis atoms + BullMQ device-status-effects. Returns a runId that streams progress over SSE. Returns 404 for an unknown VM. Returns 409 while any power/discover/reset op or a fleet-mutating stack op is running (reset is fleet-wide exclusive; independent layer cache/seed runs are not gated). Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  execMachine: {
    method: 'POST',
    path: '/api/fleet/machines/exec',
    body: z.object({
      name: z.string().describe('Fleet node name (e.g. cpu-1)'),
      command: z.string().min(1).describe('Shell command to run on the VM via SSH'),
      user: z
        .string()
        .optional()
        .describe("SSH user; default 'root' (brokkr-live), pass 'ubuntu'/'debian' for the deployed OS"),
      timeout_s: z.number().int().min(1).max(300).optional().describe('SSH timeout (default 30s, max 300s)'),
    }),
    responses: { 200: ExecResultSchema, 404: ErrorBodySchema, 400: ErrorBodySchema },
    summary: 'Run a one-shot SSH command on a VM',
    description:
      'Opens an SSH session with the operator key ($BRIDGE_SSH_PRIVKEY_PATH), runs the command, and returns its stdout/stderr/exit code, for programmatic post-provision inspection. Blocks until the command finishes or the timeout elapses. Returns 404 for an unknown VM and 400 for an invalid request. Loopback-only (this is a root shell on the VM): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getMachineConsoleLog: {
    method: 'GET',
    path: '/api/fleet/machines/:name/console-log',
    query: z.object({
      tail_bytes: z.coerce
        .number()
        .int()
        .min(1024)
        .max(8 * 1024 * 1024)
        .optional()
        .describe('Tail size in bytes (default 65536, max 8 MiB)'),
    }),
    responses: { 200: ConsoleLogSchema, 404: ErrorBodySchema },
    summary: "Read a VM's serial-console log",
    description:
      'Read-only: returns the tail of the node serial-console log (the same file `task node:console` tails) so you can watch boot/provision output before the network is up. Returns 404 for an unknown VM.',
  },
  getHost: {
    method: 'GET',
    path: '/api/host',
    responses: { 200: HostInfoSchema },
    summary: 'Host OS/arch + whether PCI passthrough is possible',
    description:
      'Read-only host facts the UI uses to decide whether to surface PCI-passthrough controls (e.g. hidden on non-Linux hosts), plus the build stamp of the running control-center server (built-from sha, live checkout HEAD, and the checkout-skew flag).',
  },
  listPci: {
    method: 'GET',
    path: '/api/host/pci',
    responses: { 200: z.array(PciDeviceSchema) },
    summary: 'Host PCI devices worth passing through (GPUs + Mellanox/NICs)',
    description:
      'Read-only: enumerates the host PCI devices eligible for VFIO passthrough so the fleet editor can offer them per node. Empty when passthrough is unavailable.',
  },
  listHostNics: {
    method: 'GET',
    path: '/api/host/nics',
    responses: { 200: z.array(HostNicSchema) },
    summary: 'Host network interfaces eligible as a bare-metal uplink',
    description:
      'Read-only: enumerates physical-ish host NICs (excluding loopback, bridges, virbr/docker/veth/tun) so the bare-metal editor can offer an uplink to bind DHCP proxy/TFTP to. Empty on non-Linux hosts.',
  },
  baremetalPower: {
    method: 'POST',
    path: '/api/baremetal/:name/power',
    body: z.object({
      action: BareMetalPowerActionSchema,
    }),
    responses: {
      200: z.object({
        powerState: z.string().describe('Redfish PowerState reported after the action'),
        action: BareMetalPowerActionSchema,
        resetType: z.string().describe('The Redfish ResetType actually sent to ComputerSystem.Reset'),
      }),
      400: z.object({ error: z.string() }),
      404: z.object({ error: z.string() }),
      502: z.object({ error: z.string() }),
    },
    summary: 'Power a bare-metal machine via its BMC (Redfish)',
    description:
      "Issues a chassis power action directly to the node's real BMC over Redfish (credentials resolved server-side from the 0600 secrets file, never sent from the browser). Linux-only and baremetal-mode-only (400 otherwise); 404 for an unknown machine; 502 for a BMC/Redfish error. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.",
  },
  getFleetConfig: {
    method: 'GET',
    path: '/api/fleet/config',
    responses: { 200: FleetConfigSchema },
    summary: 'Get the active fleet config',
    description:
      'Read-only: returns whichever fleet topology is currently in effect — the stack.local.nix overlay when customized, otherwise the committed base — to seed the fleet editor.',
  },
  getFleetApplyPlan: {
    method: 'GET',
    path: '/api/fleet/apply-plan',
    responses: { 200: ApplyPlanSchema },
    summary: 'Preview the fleet apply plan',
    description:
      'Read-only: classifies the desired-vs-applied drift into the minimal per-node ops (or a full rebuild) and returns the plan + ETA so the UI can confirm before applying. Changes nothing.',
  },
  getFleetVerify: {
    method: 'GET',
    path: '/api/fleet/verify',
    responses: { 200: FleetVerifyReportSchema, 500: ErrorBodySchema },
    summary: 'Verify the applied fleet against its live state',
    description:
      "Read-only: shells the engine (`python -m local.fleet verify --json`) to check every applied VM node's libvirt domain and BMC daemons (ipmi_sim/sushy) plus fleet-level bindings (loopback aliases, socket_vmnet, bootptab) and orphan domains. A healthy fleet (engine exit 0) and one with findings (exit 2) both map to 200; only a genuine engine failure is 500. Changes nothing.",
  },
  healFleet: {
    method: 'POST',
    path: '/api/fleet/heal',
    body: z.object({}),
    responses: {
      200: z.object({ runId: z.string().describe('Fleet run id whose heal progress streams over SSE') }),
      409: ErrorBodySchema,
    },
    summary: 'Heal the applied fleet in place',
    description:
      'Runs `local.fleet verify --heal` to repair every healable finding (restart a down ipmi_sim/sushy, re-add a missing loopback alias, rewrite the bootptab, power a stopped domain on) for the applied topology, returning a runId whose progress streams over SSE. Not an apply — findings that need a rebuild (undefined/orphan domains) are left for the fleet-apply op. Takes the fleet-wide lease, so it returns 409 while any power/discover/reset op or a fleet-mutating stack op is running. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getDevPubkey: {
    method: 'GET',
    path: '/api/host/dev-pubkey',
    responses: { 200: z.object({ pubkey: z.string().nullable() }) },
    summary: "Get the operator's SSH pubkey",
    description:
      'Read-only: returns the operator public key (or null if absent), matching BRIDGE_SSH_PRIVKEY_PATH .pub, so the cloud-init picker can embed it in customer users[] and keep SSH-as-user reachable after a verbatim provision.',
  },
  putFleetConfig: {
    method: 'PUT',
    path: '/api/fleet/config',
    body: z.object({
      mode: FleetModeSchema.describe('Which fleet mode to persist as active'),
      nodes: z
        .array(FleetNodeSchema)
        .describe('Full current VM topology (always sent; preserved when saving bare-metal)'),
      bmcDefaults: BmcCredsSchema.optional().describe('Default VM BMC creds'),
      baremetal: BareMetalConfigWriteSchema.describe(
        'Full current bare-metal config incl. write-only per-node + default BMC creds; creds are split into the 0600 secrets file, never the overlay.',
      ),
    }),
    responses: {
      200: z.object({
        ok: z.boolean(),
        pending: FleetConfigSchema.shape.pending,
      }),
      400: ErrorBodySchema,
    },
    summary: 'Write the fleet topology overlay',
    description:
      'Persists both the VM and bare-metal topologies plus the active mode to the gitignored stack.local.nix overlay (BMC creds go to a separate 0600 secrets file). The client always sends its full view of both sections; the server preserves whichever is absent. Inert until applied. Returns 400 for an invalid topology. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getLayersDefaultUrl: {
    method: 'GET',
    path: '/api/layers/default-url',
    responses: {
      200: z.object({
        url: z
          .string()
          .describe(
            'Default OS-layers manifest/index URL the Layers tab pre-fills; derived from the effective data-center asset origin host (overridable in Stack Settings), or SIM_OS_LAYERS_MANIFEST_INDEX_URL when standalone. May be empty if no asset origin is configured',
          ),
      }),
    },
    summary: 'Get the default OS-layers manifest URL',
    description:
      'Read-only: returns the manifest/release-index URL the Layers tab pre-fills. Derived from the effective data-center asset origin host (the stack osLayerCache.originHost, overridable in Stack Settings); a SIM_OS_LAYERS_MANIFEST_INDEX_URL env override wins when running standalone. May be empty when no asset origin is configured.',
  },
  seedManifest: {
    method: 'POST',
    path: '/api/layers/seed',
    body: z.object({ url: z.string() }),
    responses: { 200: z.object({ runId: z.string() }), 400: ErrorBodySchema },
    summary: 'Seed the hub catalog from a manifest URL',
    description:
      'Runs the hub seed-from-manifest script against the given manifest URL to reconcile the OS-layer catalog, returning a runId that streams over SSE. The URL must pass the same https + allowlist gate as getLayersManifest (400 otherwise). Re-importing the same (version, env) pair is rejected unless the previous attempt was IMPORTING or FAILED — bump the version in the upstream pipeline to re-import a corrected manifest.',
  },
  getLayerCache: {
    method: 'GET',
    path: '/api/layers/cache',
    responses: { 200: z.object({ shas: z.array(z.string()) }) },
    summary: 'List cached OS-layer blob sha256s',
    description:
      'Read-only: lists the sha256 digests of layer blobs already warm in the nginx cache so the UI can show which artifacts are primed.',
  },
  primeBlob: {
    method: 'POST',
    path: '/api/layers/cache/prime',
    body: z.object({ sha: z.string() }),
    responses: { 200: z.object({ runId: z.string() }), 400: ErrorBodySchema },
    summary: 'Prime one blob into the nginx cache',
    description:
      'Pre-fetches the named layer blob (by its artifact sha256) into the nginx cache so a later provision serves it locally; returns a runId that streams over SSE. Returns 400 for a bad sha. Loopback-only (it writes into the host layer cache): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  nukeBlob: {
    method: 'POST',
    path: '/api/layers/cache/nuke',
    body: z.object({ sha: z.string() }),
    responses: { 200: z.object({ ok: z.boolean() }), 400: ErrorBodySchema },
    summary: 'Evict one blob from the nginx cache',
    description:
      'Removes the named layer blob from the nginx cache so the next request re-fetches it from origin; use to test a cold provision. Returns 400 for a bad sha. Loopback-only (it unlinks files in the host layer cache): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  getLayersManifest: {
    method: 'GET',
    path: '/api/layers/manifest',
    query: z.object({
      url: z
        .string()
        .optional()
        .describe(
          'Manifest or release-index URL; omitted = the configured default (getLayersDefaultUrl). Must be https on an allowlisted host — the asset origin host, the SIM_OS_LAYERS_MANIFEST_INDEX_URL host, or LAB_LAYERS_ALLOWED_HOSTS.',
        ),
    }),
    responses: {
      200: z.object({
        resolvedUrl: z
          .string()
          .describe(
            "The manifest URL actually fetched — the input URL, or the versioned manifest a release index's {url} field pointed at",
          ),
        doc: LayersManifestSchema,
      }),
      400: ErrorBodySchema,
    },
    summary: 'Fetch an OS-layers manifest server-side (follows a release index)',
    description:
      'Fetches the manifest with the asset-host UA, following one {url} index indirection, and returns the resolved URL + parsed document. Rejects non-https URLs and hosts outside the allowlist (asset origin / SIM_OS_LAYERS_MANIFEST_INDEX_URL / LAB_LAYERS_ALLOWED_HOSTS) with 400.',
  },
} as const;
