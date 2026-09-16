export const REDIS_KEYS = {
  bridgeInstance: (zoneId: string, instanceId?: string) => `${zoneId}:bridge:instance:${instanceId ?? '*'}`,

  bridgeInstanceScanAll: '*:bridge:instance:*',

  discoveryPending: (prefix?: string) => `${prefix ?? '*'}:discovery:pending:*`,

  deviceTokenLastUsed: (tokenId: string) => `device-token:${tokenId}:last-used`,

  sagaPlan: (zoneUuid: string) => `${zoneUuid}:bridge:jobs:plan:*`,

  sagaPlanById: (zoneUuid: string, planId: string) => `${zoneUuid}:bridge:jobs:plan:${planId}`,

  solLogs: (zonePrefix: string, planId: string) => `${zonePrefix}:sol:logs:${planId}`,

  jobLogs: (zonePrefix: string, planId: string) => `${zonePrefix}:job:logs:${planId}`,
};

export const serverToken = (deviceId: string): string => `device:${deviceId}:server_token`;

export const ipxeUrl = (deviceId: string): string => `device:${deviceId}:config:ipxe_url`;

export const TTL_IPXE_URL_SECONDS = 60 * 60;

export type DeviceLookupKind = 'mac' | 'ipmi_mac' | 'system_uuid' | 'serial' | 'chassis_serial' | 'board_serial';

export const deviceRecord = (id: string): string => `device:${id}:device_record`;

export const deviceData = (id: string): string => `device:${id}:data`;

export const devicePointers = (id: string): string => `device:${id}:pointers`;

export const deviceLookup = (kind: DeviceLookupKind, value: string): string =>
  `device:lookup:${kind}:${normalizeLookupValue(kind, value)}`;

function normalizeLookupValue(kind: DeviceLookupKind, value: string): string {
  const lower = value.toLowerCase();
  if (kind === 'mac' || kind === 'ipmi_mac') {
    return lower.replace(/:/g, '-');
  }
  return lower;
}

export type NetplanPhase = 'live' | 'deploy';

export const netplanConfig = (deviceId: string, phase: NetplanPhase): string =>
  `device:${deviceId}:config:netplan:${phase}`;

export const NETPLAN_LIVE_TTL_SECONDS = 20 * 60;

export const NETPLAN_LOCK_CONTENDED_TTL_SECONDS = 5;

export const rescueSshKeys = (deviceId: string): string => `device:${deviceId}:rescue:ssh_pub_keys`;

export const TTL_RESCUE_SSH_KEYS_SECONDS = 24 * 60 * 60;

/** `purpose`/`kind` are lowercased — the bridge consumer MUST lowercase the same way; value is zone-sealed ciphertext, never plaintext. */
export const deviceSecret = (deviceId: string, purpose: string, kind: string): string =>
  `device:${deviceId}:secrets:${purpose.toLowerCase()}:${kind.toLowerCase()}`;

// No TTL (0 = persist): a BMC credential is durable device state; a fresh seal overwrites the atom under last-newer-wins.
export const TTL_DEVICE_SECRET_SECONDS = 0;

export const vrrpConfig = (prefixId: string): string => `prefix:${prefixId}:config:vrrp`;

// No TTL (0 = persist): no render-on-miss backstop exists (bridges discover by SCAN), so the atom must persist; cleared VIPs are removed via explicit DEL.
export const TTL_VRRP_VIP_SECONDS = 0;

// Bridges discover the zone's DHCP config set by SCANning `{zoneUuid}:prefix:*:config:dhcp` —
// the key shape is a bridge wire contract. Value shape: `dhcp-atom.schema.ts`.
export const dhcpConfig = (prefixId: string): string => `prefix:${prefixId}:config:dhcp`;

// No TTL (0 = persist): no render-on-miss backstop exists (bridges discover by SCAN), so the atom
// must survive hub outages; a cleared prefix is removed via explicit DEL.
export const TTL_DHCP_CONFIG_SECONDS = 0;

// Zone-global DHCP runtime-tuning atom, point-read by bridges as `{zoneUuid}:config:dhcp`.
// Value shape: `dhcp-atom.schema.ts` (DhcpZoneOpsAtomSchema).
export const DHCP_ZONE_CONFIG_KEY = 'config:dhcp';

/** Matches both zone-global (`config:dhcp`) and per-prefix (`prefix:*:config:dhcp`) keys.
 *  Callers that need only zone keys must post-filter with a `/^([^:]+):config:dhcp$/` regex. */
export const DHCP_CONFIG_SCAN_PATTERN = '*:config:dhcp';

// Zone-global DNS config atom key — no zone suffix (ConfigAtomWriter prepends the zone UUID).
export const DNS_CONFIG_KEY = 'config:dns';

// Per-prefix DNS override atom key. The bridge SCANs `prefix:*:config:dns`.
export const dnsPrefixConfig = (prefixId: string): string => `prefix:${prefixId}:config:dns`;

export const TTL_DNS_CONFIG_SECONDS = 0;

/** Matches both zone-global (`config:dns`) and prefix-override (`prefix:*:config:dns`) keys.
 *  Callers that need only zone keys must post-filter with a `/^([^:]+):config:dns$/` regex. */
export const DNS_CONFIG_SCAN_PATTERN = '*:config:dns';

export const DNS_PREFIX_CONFIG_SCAN_PATTERN = '*:prefix:*:config:dns';

// Bridges discover the zone's DNS records by reading `{zoneUuid}:config:dns-records`.
// Value shape: `brokkr-bridge/dns/dns-records-atom.schema.ts`.
export const DNS_RECORDS_KEY = 'config:dns-records';

export const TTL_DNS_RECORDS_SECONDS = 0;
