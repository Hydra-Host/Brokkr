import { z } from 'zod';

import { BootTrailSchema } from '../contract';

/** The bridge's redis client prefixes every key it writes with the zone uuid, so an observer that
 *  wants one zone's runtime state addresses these unprefixed shapes under `{zoneId}:`. */
const zoneKey = (zoneId: string, key: string): string => `${zoneId}:${key}`;

export const leaderKey = (zoneId: string): string => zoneKey(zoneId, 'bridge:leader');
export const instanceScanPattern = (zoneId: string): string => zoneKey(zoneId, 'bridge:instance:*');
export const vrrpScanPattern = (zoneId: string): string => zoneKey(zoneId, 'prefix:*:config:vrrp');
export const zoneCryptoKey = (zoneId: string): string => zoneKey(zoneId, 'zone_crypto');
export const bootstrapLockKey = (zoneId: string): string => zoneKey(zoneId, 'lock:zone_crypto:bootstrap_lock');
export const workDispatchPattern = (zoneId: string): string => zoneKey(zoneId, 'work:dispatch:*');
export const workProgressPattern = (zoneId: string): string => zoneKey(zoneId, 'work:progress:*');

/** The bridge keys a machine's boot trail by the mac it saw on the wire: lowercase, colon-separated. A mac
 *  is unique across zones, so these match under any zone prefix rather than looking the zone up first. */
const trailMac = (mac: string): string => mac.trim().replace(/-/g, ':').toLowerCase();
export const dhcpPxeScanPattern = (mac: string): string => `*:dhcp:pxe:${trailMac(mac)}`;
export const discoveryPendingScanPattern = (mac: string): string => `*:discovery:pending:${trailMac(mac)}`;
export const ipxeChainHitScanPattern = (mac: string): string => `*:ipxe:chain:${trailMac(mac)}`;

/** The spoke's discovery sync version keys — the legacy single key and the per-flavor ones. The
 *  instance id names one spoke, so this matches them under any zone prefix. */
export const syncVersionScanPattern = (instance: string): string => `*:bridge:${instance}:version:brokkr-live-https*`;

// the bridge writes `at` as epoch ms in a string field; the outcome vocabulary is the contract's
export const PxeDecisionHashSchema = z.object({
  outcome: BootTrailSchema.shape.pxe.unwrap().shape.outcome,
  at: z.string().regex(/^\d+$/),
});

// mirrors the bridge's ipxe chain marker write: a plain string holding json, not a hash like the pxe decision
export const ChainHitValueSchema = z.object({
  atMs: z.number().int().nonnegative().describe('Epoch ms when the machine fetched the ipxe chain script'),
  deviceId: z.string().nullable().describe('Device the bridge matched the mac to; null when it knew none'),
});

const INSTANCE_SEGMENT = ':bridge:instance:';
export function instanceIdFromKey(key: string): string | null {
  const at = key.indexOf(INSTANCE_SEGMENT);
  if (at === -1) return null;
  const id = key.slice(at + INSTANCE_SEGMENT.length);
  return id.length > 0 ? id : null;
}

const VRRP_PREFIX_RE = /:prefix:(.+):config:vrrp$/;
export function prefixIdFromVrrpKey(key: string): string | null {
  return VRRP_PREFIX_RE.exec(key)?.[1] ?? null;
}

/** The bridge presence record is a python-parity hash: booleans are the strings 'True'/'False' and
 *  timestamps are float SECONDS, so a lowercase compare or a millisecond read is silently wrong. */
export const BridgePresenceHashSchema = z.object({
  instance_id: z.string().min(1),
  is_leader: z.string().optional(),
  brokkr_worker_version: z.string().optional(),
  brokkr_live_version: z.string().optional(),
  registered_at: z.string().optional(),
  interfaces_json: z.string().optional(),
  active_plugins_json: z.string().optional(),
});
export type BridgePresenceHash = z.infer<typeof BridgePresenceHashSchema>;

export const isLeaderFlag = (raw: string | undefined): boolean | null => {
  if (raw === 'True') return true;
  if (raw === 'False') return false;
  return null;
};

export function epochMsFromFloatSeconds(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const seconds = Number.parseFloat(raw);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

/** The presence key outlives the heartbeat that proves liveness (120s TTL against a 10s renew), so a
 *  record still in redis is only evidence of an online bridge inside this window. Matches the hub. */
export const PRESENCE_FRESH_SECONDS = 25;

export const isPresenceFresh = (registeredAtMs: number | null, nowMs: number): boolean | null =>
  registeredAtMs === null ? null : nowMs - registeredAtMs < PRESENCE_FRESH_SECONDS * 1000;

const InterfaceSchema = z.object({
  iface: z.string(),
  mac: z.string(),
  subnet: z.string(),
  ip: z.string(),
  gateway: z.string().optional(),
  routed: z.boolean().optional(),
});
const PluginSchema = z.object({ id: z.string(), version: z.string() });

function parseJsonArray<T>(raw: string | undefined, schema: z.ZodType<T>): T[] | null {
  if (raw === undefined) return null;
  try {
    const parsed = z.array(schema).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export const parseInterfaces = (raw: string | undefined): z.infer<typeof InterfaceSchema>[] | null =>
  parseJsonArray(raw, InterfaceSchema);

export const parsePlugins = (raw: string | undefined): z.infer<typeof PluginSchema>[] | null =>
  parseJsonArray(raw, PluginSchema);
