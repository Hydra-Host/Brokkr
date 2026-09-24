import {
  CUSTOMER_HEALTH_KEYS,
  type DeviceHealthCheck,
  type DeviceHealthSnapshot,
  type DeviceHealthSummary,
} from '@repo/api-client';
import { deriveReachability, type HealthChecks, healthReason, isIcmpFiltered } from './device-health';

export type HealthView = DeviceHealthSummary['view'];

export interface HealthSummaryInput {
  source: Exclude<DeviceHealthSummary['source'], 'none'>;
  checkedAt: string;
  checks: HealthChecks;
  ecoMode: boolean;
}

export type HealthCheckRow = HealthChecks & { id: string; testedAt: Date };

export function snapshotChecks(s: DeviceHealthSnapshot): HealthChecks {
  return {
    primaryReachable: s.primary_reachable,
    bmcIcmpReachable: s.bmc_icmp_reachable,
    bmcIpmiReachable: s.bmc_ipmi_reachable,
    bmcRedfishReachable: s.bmc_redfish_reachable,
    bmcCredsValid: s.bmc_creds_valid,
    poweredOn: s.powered_on,
    brokkrLiveRunning: s.brokkr_live_running,
  };
}

/** null input is the "nothing known" summary; the customer view hides every BMC probe and the verdict. */
export function presentHealthSummary(input: HealthSummaryInput | null, view: HealthView): DeviceHealthSummary {
  if (input === null) {
    return { view, source: 'none', checkedAt: null, checks: null, isHealthy: null, reason: null, icmpFiltered: false };
  }
  const { source, checkedAt, checks, ecoMode } = input;
  if (view === 'customer') {
    const visible = (key: keyof HealthChecks) => (CUSTOMER_HEALTH_KEYS.has(key) ? checks[key] : null);
    return {
      view,
      source,
      checkedAt,
      checks: {
        primaryReachable: visible('primaryReachable'),
        bmcIcmpReachable: visible('bmcIcmpReachable'),
        bmcIpmiReachable: visible('bmcIpmiReachable'),
        bmcRedfishReachable: visible('bmcRedfishReachable'),
        bmcCredsValid: visible('bmcCredsValid'),
        poweredOn: visible('poweredOn'),
        brokkrLiveRunning: visible('brokkrLiveRunning'),
        reachability: null,
      },
      isHealthy: null,
      reason: null,
      icmpFiltered: false,
    };
  }
  const reason = healthReason(checks, ecoMode);
  return {
    view,
    source,
    checkedAt,
    checks: {
      primaryReachable: checks.primaryReachable,
      bmcIcmpReachable: checks.bmcIcmpReachable,
      bmcIpmiReachable: checks.bmcIpmiReachable,
      bmcRedfishReachable: checks.bmcRedfishReachable,
      bmcCredsValid: checks.bmcCredsValid,
      poweredOn: checks.poweredOn,
      brokkrLiveRunning: checks.brokkrLiveRunning,
      reachability: deriveReachability(checks),
    },
    isHealthy: reason === null,
    reason,
    icmpFiltered: isIcmpFiltered(checks),
  };
}

export function toHealthCheckRow(row: HealthCheckRow): DeviceHealthCheck {
  return {
    id: row.id,
    testedAt: row.testedAt.toISOString(),
    primaryReachable: row.primaryReachable,
    bmcIcmpReachable: row.bmcIcmpReachable,
    bmcIpmiReachable: row.bmcIpmiReachable,
    bmcRedfishReachable: row.bmcRedfishReachable,
    bmcCredsValid: row.bmcCredsValid,
    poweredOn: row.poweredOn,
    brokkrLiveRunning: row.brokkrLiveRunning,
    reachability: deriveReachability(row),
  };
}
