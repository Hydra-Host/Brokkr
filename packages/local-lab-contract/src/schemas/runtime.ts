import { z } from 'zod';

export const BridgeInterfaceSchema = z.object({
  iface: z.string().describe('NIC name as the bridge host sees it (eth0, en0, …)'),
  mac: z.string().describe('Hardware address of that NIC'),
  subnet: z.string().describe('CIDR of the network the NIC sits on'),
  ip: z.string().describe('Address the bridge holds on that NIC'),
  gateway: z.string().optional().describe('Next hop for this subnet, when the bridge reported one'),
  routed: z
    .boolean()
    .optional()
    .describe('True when the subnet is L3-routed, so "gateway" is a next hop toward it rather than a default gateway'),
});
export type BridgeInterface = z.infer<typeof BridgeInterfaceSchema>;

export const BridgePluginSchema = z.object({
  id: z.string().describe('Plugin id as registered on the bridge'),
  version: z.string().describe('Version the bridge reported for that plugin'),
});
export type BridgePlugin = z.infer<typeof BridgePluginSchema>;

export const ZoneLeaderSchema = z.object({
  holder: z
    .string()
    .nullable()
    .describe(
      'Instance id (the bridge hostname) currently holding the zone leader lease, read from the leader key itself — the authoritative answer. Null when no bridge holds the lease, which is a real unheld state and not a failed read; a failure sets readError instead',
    ),
  ttlSeconds: z
    .number()
    .int()
    .nullable()
    .describe(
      'Seconds left on the leader lease before it expires unless renewed. Null when the key is unheld or its TTL could not be determined',
    ),
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when the leader key was read successfully. Otherwise why it failed, in which case holder is unknown rather than unheld',
    ),
});
export type ZoneLeader = z.infer<typeof ZoneLeaderSchema>;

export const ZoneBridgeSchema = z.object({
  instanceId: z
    .string()
    .describe(
      'The bridge hostname, which is simultaneously its process name, its BRIDGE_HOSTNAME and its presence key',
    ),
  expected: z
    .boolean()
    .describe(
      'True when the local stack config declares this bridge for this zone. False means it registered without being configured here — kept visible rather than filtered out',
    ),
  registered: z
    .boolean()
    .describe(
      'True when the bridge has a presence record in Redis. False on a configured bridge means it never registered or its record expired',
    ),
  isLeader: z
    .boolean()
    .nullable()
    .describe(
      'What the bridge itself claims about holding the lease, refreshed on its own heartbeat and therefore up to one renew interval stale. Null when unregistered or unparseable. Disagreement with the zone leader holder is reported, not reconciled — it usually means a failover in flight',
    ),
  online: z
    .boolean()
    .nullable()
    .describe(
      'True when the presence record was refreshed inside the freshness window. A record that still exists but is older than that window is offline, because the key outlives the heartbeat that proves liveness. Null when unregistered',
    ),
  registeredAtMs: z
    .number()
    .nullable()
    .describe(
      'Unix milliseconds when the bridge last refreshed its presence record. Null when unregistered or the timestamp was unparseable',
    ),
  workerVersion: z.string().nullable().describe('Bridge worker version the presence record reported. Null when absent'),
  liveVersion: z
    .string()
    .nullable()
    .describe('Discovery-OS (brokkr-live) version the presence record reported. Null when absent'),
  interfaces: z
    .array(BridgeInterfaceSchema)
    .nullable()
    .describe(
      'Real host NICs the bridge reported, which are what a VIP can be bound on top of. Null when the record carried none or it could not be parsed — which is not the same as a bridge with no interfaces',
    ),
  plugins: z
    .array(BridgePluginSchema)
    .nullable()
    .describe(
      'Bridge plugins the record reported. Null when absent or unparseable, which is not the same as no plugins',
    ),
  port: z
    .number()
    .int()
    .nullable()
    .describe('HTTP port this bridge listens on locally. Null when the stack config does not declare it'),
  grpcPort: z
    .number()
    .int()
    .nullable()
    .describe('gRPC port agents dial back on. Null when the stack config does not declare it'),
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when this row was assembled successfully. Otherwise why reading its presence record failed, in which case every field above is unknown rather than absent',
    ),
});
export type ZoneBridge = z.infer<typeof ZoneBridgeSchema>;

export const VrrpObservabilitySchema = z
  .enum(['shim', 'unavailable'])
  .describe(
    'How actual VIP bind state was observed: "shim" means the local VRRP sim is writing per-bridge binding state and observedHolders is a measurement; "unavailable" means nothing observable is present (the sim is off, or this is a real host whose binds live only in its kernel) and every observedHolders is null',
  );
export type VrrpObservability = z.infer<typeof VrrpObservabilitySchema>;

export const ZoneVipSchema = z.object({
  prefixId: z.string().describe('IPAM prefix id the VIP atom belongs to, taken from the atom key'),
  vip: z
    .string()
    .nullable()
    .describe(
      'The floating address in host/mask CIDR form, e.g. 10.0.1.1/24. Null when atomError is set and the address could not be read — never an empty string, which would read as a configured blank address',
    ),
  ifaceByBridge: z
    .record(z.string())
    .describe(
      'Per-bridge NIC the VIP attaches to, keyed by bridge hostname. A bridge absent from this map never binds this VIP, even as leader',
    ),
  garpCount: z
    .number()
    .int()
    .nullable()
    .describe('Gratuitous ARPs the holder sends on a fresh bind. Null when the atom left it to the bridge default'),
  writtenAtMs: z
    .number()
    .nullable()
    .describe(
      'Unix milliseconds stamped on the atom by the hub. It also orders writes, so it moves forward monotonically. Null when the atom carried no readable stamp — never zero, which would read as the epoch',
    ),
  requestId: z
    .string()
    .nullable()
    .describe('Correlation token of the hub write that produced this atom; null for an unsolicited write'),
  desiredHolder: z
    .string()
    .nullable()
    .describe(
      'Which bridge should hold this VIP: the zone leader, but only when it is also named in ifaceByBridge. Null when no bridge satisfies both — intent, never a measurement of what is actually bound',
    ),
  observedHolders: z
    .array(z.string())
    .nullable()
    .describe(
      'Bridges actually observed holding this VIP. Null when bind state could not be observed at all, which is not the same as no bridge holding it — an empty array is a measurement that nobody holds it, and must never be produced from an absent observation source',
    ),
  atomError: z
    .string()
    .nullable()
    .describe(
      'Null when the atom parsed cleanly. Otherwise why it did not, so a malformed or hub-failed atom stays visible instead of vanishing from the list',
    ),
});
export type ZoneVip = z.infer<typeof ZoneVipSchema>;

export const ZoneVrrpSchema = z.object({
  observability: VrrpObservabilitySchema,
  vips: z.array(ZoneVipSchema).describe('Every VIP atom the hub has published for this zone, in prefix-id order'),
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when the VIP atoms were discovered successfully. Otherwise why the discovery failed, in which case an empty vips list means unknown rather than none configured',
    ),
});
export type ZoneVrrp = z.infer<typeof ZoneVrrpSchema>;

export const ZoneCryptoStateSchema = z
  .enum(['enrolled', 'bootstrapping', 'not-enrolled', 'unknown'])
  .describe(
    'Zone-crypto enrollment, derived from key presence only — the zone key itself is never read, since it wraps the zone private key. "enrolled" the material exists; "bootstrapping" a bridge holds the enrollment lock; "not-enrolled" neither is present; "unknown" the probe failed',
  );
export type ZoneCryptoState = z.infer<typeof ZoneCryptoStateSchema>;

export const ZoneCryptoSchema = z.object({
  state: ZoneCryptoStateSchema,
  bootstrapLockTtlSeconds: z
    .number()
    .int()
    .nullable()
    .describe(
      'Seconds left on the enrollment lock, which bounds how long a stuck bootstrap can block the zone. Null when no lock is held or its TTL could not be determined',
    ),
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when both presence probes succeeded. Otherwise why they did not, which is why state reads "unknown"',
    ),
});
export type ZoneCrypto = z.infer<typeof ZoneCryptoSchema>;

export const ZoneAgentWorkSchema = z.object({
  dispatchesInFlight: z
    .number()
    .int()
    .nullable()
    .describe(
      'Agent operation dispatches still within their retention window, i.e. roughly what the bridges have handed to agents recently. Null when the scan failed, which is not the same as none',
    ),
  lastActivityAtMs: z
    .number()
    .nullable()
    .describe(
      'Unix milliseconds of the most recent agent progress report in this zone. Null when no agent work has been seen at all, or when it could not be determined — the two are told apart by readError',
    ),
  scanCapped: z
    .boolean()
    .nullable()
    .describe(
      'True when the key scan hit its cap, so these numbers are a floor rather than a complete count. Null when the scan failed and whether it would have capped is itself undetermined — never false, which would assert a complete count',
    ),
  readError: z
    .string()
    .nullable()
    .describe('Null when the agent work keys were scanned successfully. Otherwise why they were not'),
});
export type ZoneAgentWork = z.infer<typeof ZoneAgentWorkSchema>;

export const ZoneBridgesSchema = z.object({
  rows: z
    .array(ZoneBridgeSchema)
    .describe(
      'Every bridge this zone knows about — those the stack config declares and those that registered without being declared, so an orphan bridge stays visible. Empty is a measurement that the zone has none only when readError is null',
    ),
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when the presence records were read successfully. Otherwise why they were not, in which case an empty rows list means unknown rather than no bridges',
    ),
});
export type ZoneBridges = z.infer<typeof ZoneBridgesSchema>;

export const ZoneRuntimeSchema = z.object({
  zoneId: z.string().describe("Hub Zone.id — the UUID that is also this zone's Redis key prefix"),
  zoneName: z.string().nullable().describe('Hub Zone.name for display. Null when the zone row carried no usable name'),
  leader: ZoneLeaderSchema,
  bridges: ZoneBridgesSchema,
  vrrp: ZoneVrrpSchema,
  zoneCrypto: ZoneCryptoSchema,
  agentWork: ZoneAgentWorkSchema,
  readError: z
    .string()
    .nullable()
    .describe(
      'Null when this zone was assembled successfully. Otherwise the whole-zone read failed and every section below is a placeholder rather than a measurement. A failure confined to one section stays on that section, in its own readError, and leaves this null',
    ),
});
export type ZoneRuntime = z.infer<typeof ZoneRuntimeSchema>;
