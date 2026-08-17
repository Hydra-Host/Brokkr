import { NIL_DEVICE_ID } from '../../constants';

export type DeviceId = string;

export { NIL_DEVICE_ID };

export function deviceLookupByMac(normalizedMac: string): string {
  return `device:mac:${normalizedMac}`;
}

export function deviceLookupBySerial(serial: string): string {
  return `device:serial:${serial}`;
}

export function deviceBmcCipherByIp(ipmiIp: string): string {
  return `device:ip:${ipmiIp}:bmc:cipher`;
}

export function deviceBmcCipher(deviceId: DeviceId): string {
  return `device:${deviceId}:bmc:cipher`;
}

export function deviceSagaLock(deviceId: DeviceId): string {
  return `device:${deviceId}`;
}

export function scanSagaLock(subnet: string): string {
  return `scan:${subnet}`;
}

export function deviceNetplan(deviceId: DeviceId): string {
  return `device:${deviceId}:netplan`;
}

export function deviceNetplanPhase(deviceId: DeviceId, phase: string): string {
  return `device:${deviceId}:config:netplan:${phase}`;
}

export function netplanConfig(deviceId: DeviceId, phase: string): string {
  if (phase !== 'live' && phase !== 'deploy') {
    throw new Error(`invalid netplan phase: ${phase}`);
  }
  return deviceNetplanPhase(deviceId, phase);
}

export function deviceSshIp(deviceId: DeviceId): string {
  return `device:${deviceId}:ssh:ip`;
}

export function deviceLanChannel(deviceId: DeviceId): string {
  return `device:${deviceId}:ipmi:lan_channel`;
}

export function deviceInitrd(deviceId: DeviceId, initrdType: string): string {
  return `device:${deviceId}:initrd:${initrdType}`;
}

export function deviceRecord(deviceId: DeviceId): string {
  return `device:${deviceId}:device_record`;
}

export function deviceLookup(kind: string, value: string): string {
  return `device:lookup:${kind}:${value}`;
}

export function deviceServerToken(deviceId: DeviceId): string {
  return `device:${deviceId}:server_token`;
}

export function deviceSecret(deviceId: DeviceId, purpose: string, kind: string): string {
  return `device:${deviceId}:secrets:${purpose.toLowerCase()}:${kind.toLowerCase()}`;
}

export function deviceDataPattern(): string {
  return 'device:*:data';
}

export function rescueSshPubKeys(deviceId: DeviceId): string {
  return `device:${deviceId}:rescue:ssh_pub_keys`;
}

export function deviceIpxeUrl(deviceId: DeviceId): string {
  return `device:${deviceId}:config:ipxe_url`;
}

export function deviceInitrdBuildLock(deviceId: DeviceId, initrdType: string): string {
  return `device:${deviceId}:initrd:${initrdType}:build`;
}

export function discoveryPending(normalizedMac: string): string {
  return `discovery:pending:${normalizedMac}`;
}

export function deviceDiscoveryCollector(deviceId: DeviceId, field: string): string {
  return `device:${deviceId}:discovery:${field}`;
}

export function deviceDiscoveryPattern(deviceId: DeviceId): string {
  return `device:${deviceId}:discovery:*`;
}

export function deviceHealth(deviceId: DeviceId): string {
  return `device-health:${deviceId}`;
}

export function bridgeInstanceVersion(instanceId: string, suffix: string): string {
  return `bridge:${instanceId}:version:${suffix}`;
}

export function dhcpLease(ip: string): string {
  return `dhcp:lease:${ip}`;
}

export function dhcpLeasePattern(): string {
  return 'dhcp:lease:*';
}

export function vrrpConfigScanPattern(): string {
  return 'prefix:*:config:vrrp';
}

// Written by the hub (apps/api/src/common/redis/redis-keys.ts dhcpConfig()); the bridge only
// SCAN-discovers, never point-reads by id, so there's no unprefixed-key builder to mirror.
export function dhcpConfigScanPattern(): string {
  return 'prefix:*:config:dhcp';
}

// Zone-global DNS config key (no zone suffix — bridge Redis is already zone-prefixed).
export function dnsZoneConfigKey(): string {
  return 'config:dns';
}

// Zone-global DHCP runtime-tuning key (hub: DHCP_ZONE_CONFIG_KEY).
export function dhcpZoneConfigKey(): string {
  return 'config:dhcp';
}

export function dnsPrefixConfigScanPattern(): string {
  return 'prefix:*:config:dns';
}
