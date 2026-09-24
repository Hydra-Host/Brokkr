import type { HealthChecks } from '@repo/api-client';
import { Check, Minus, X } from 'lucide-react';

// every probe needs a label, so a new HealthChecks field is a compile error here; key order is the column order
const HEALTH_CHECK_LABELS: Record<keyof HealthChecks, string> = {
  primaryReachable: 'primary',
  bmcIcmpReachable: 'bmc icmp',
  bmcIpmiReachable: 'ipmi',
  bmcRedfishReachable: 'redfish',
  bmcCredsValid: 'creds',
  poweredOn: 'power',
  brokkrLiveRunning: 'discovery OS',
};

const DEPLOYED_OS_DORMANT_TITLE = 'not expected while the deployed OS runs';

function isHealthCheckKey(key: string): key is keyof HealthChecks {
  return key in HEALTH_CHECK_LABELS;
}

export const HEALTH_CHECK_COLUMNS: ReadonlyArray<{ key: keyof HealthChecks; label: string }> = Object.keys(
  HEALTH_CHECK_LABELS,
)
  .filter(isHealthCheckKey)
  .map((key) => ({ key, label: HEALTH_CHECK_LABELS[key] }));

// the discovery agent only answers under the discovery OS, so its silence is expected once the deployed OS is up
export function isDormantCheck(key: keyof HealthChecks, deployedOs: boolean): boolean {
  return deployedOs && key === 'brokkrLiveRunning';
}

export function HealthCheckStatusIcon({
  value,
  label,
  dormant = false,
}: {
  value: boolean | null;
  label: string;
  dormant?: boolean;
}) {
  if (value) return <Check className="h-4 w-4 text-green-600" aria-label={`${label}: passed`} />;
  if (dormant) {
    return (
      <Minus className="text-muted-foreground h-4 w-4" aria-label={`${label}: ${DEPLOYED_OS_DORMANT_TITLE}`}>
        <title>{DEPLOYED_OS_DORMANT_TITLE}</title>
      </Minus>
    );
  }
  if (value === null) return <Minus className="text-muted-foreground h-4 w-4" aria-label={`${label}: not tested`} />;
  return <X className="text-destructive h-4 w-4" aria-label={`${label}: failed`} />;
}
