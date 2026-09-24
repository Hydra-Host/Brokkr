export interface HealthChecks {
  primaryReachable: boolean | null;
  bmcIcmpReachable: boolean | null;
  bmcIpmiReachable: boolean | null;
  bmcRedfishReachable: boolean | null;
  bmcCredsValid: boolean | null;
  poweredOn: boolean | null;
  brokkrLiveRunning: boolean | null;
}

export type DeviceReachability = 'ok' | 'auth-failed' | 'unreachable' | 'unconfigured' | 'unknown';

/** null is ambiguous on the hub because the bridge swallows a per-probe error to null, hence the fifth value. */
export function deriveReachability(checks: HealthChecks): DeviceReachability {
  const probes = [checks.bmcIcmpReachable, checks.bmcIpmiReachable, checks.bmcRedfishReachable];
  if (probes.every((p) => p === null)) return 'unconfigured';
  if (!probes.some((p) => p === true)) return 'unreachable';
  if (checks.bmcCredsValid === false) return 'auth-failed';
  if (checks.bmcCredsValid === true) return 'ok';
  return 'unknown';
}

/** ping is advisory: a BMC that answers IPMI or Redfish is reachable even when ICMP is filtered */
export function isIcmpFiltered(checks: HealthChecks): boolean {
  return checks.bmcIcmpReachable !== true && (checks.bmcIpmiReachable === true || checks.bmcRedfishReachable === true);
}

/** The ladder the hub applies; the first failing probe names the reason. Null means healthy. */
export function healthReason(checks: HealthChecks, ecoMode: boolean): string | null {
  if (checks.bmcIcmpReachable !== true && !isIcmpFiltered(checks)) return 'BMC interface not reachable via ICMP';
  if (checks.bmcIpmiReachable !== true) return 'BMC not accessible via IPMI';
  if (checks.bmcRedfishReachable !== true) return 'BMC not accessible via Redfish API';
  if (checks.bmcCredsValid !== true) return 'BMC credentials are invalid';
  if (!ecoMode && checks.poweredOn !== true) return 'Device is not powered on';
  return null;
}
