import { ClickToCopyString } from '@repo/ui/components/click-to-copy-string';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { bootPollInterval } from '../hooks/boot-poll';
import { healthSummaryLine, relativeTime } from '../hooks/health-copy';
import { HEALTH_SUMMARY_POLL_MS } from '../hooks/poll-intervals';
import { diagnosticsKeys, useDiagnosticsApi } from '../hooks/use-diagnostics-api';
import { BootTrailLine } from './boot-trail-line';

export interface DiagnosticDevice {
  id: string;
  displayName: string;
  zoneId: string | null;
  zoneName: string | null;
  bmcIp: string | null;
  deployedOs: boolean;
  status: string | null;
}

export function HeaderLine({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

export function HeaderLines({ device, extra }: { device: DiagnosticDevice; extra?: ReactNode }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
      <HeaderLine label="id">
        <ClickToCopyString value={device.id} className="text-xs" />
      </HeaderLine>
      {device.bmcIp && (
        <HeaderLine label="bmc">
          <ClickToCopyString value={device.bmcIp} className="text-xs" />
        </HeaderLine>
      )}
      {extra}
    </dl>
  );
}

export function BootHeaderLine({ device }: { device: DiagnosticDevice }) {
  const api = useDiagnosticsApi();
  const interval = bootPollInterval(device.status);
  const query = useQuery({
    queryKey: diagnosticsKeys.bootTrail(device.id),
    queryFn: () => api.bootTrail(device.id),
    refetchInterval: interval,
    enabled: interval !== false,
  });
  if (interval === false || query.data === undefined) return null;
  return (
    <HeaderLine label="boot">
      <Link to={api.hrefs.diagnostics(device.id)} className="hover:underline">
        <BootTrailLine trail={query.data.trail} />
      </Link>
    </HeaderLine>
  );
}

export function HealthHeaderLine({ device }: { device: DiagnosticDevice }) {
  const api = useDiagnosticsApi();
  const query = useQuery({
    queryKey: diagnosticsKeys.health(device.id),
    queryFn: () => api.healthSummary(device.id),
    refetchInterval: HEALTH_SUMMARY_POLL_MS,
  });
  if (query.data === undefined) return null;
  const reachability = query.data.checks?.reachability;
  return (
    <HeaderLine label="health">
      <Link to={api.hrefs.health(device.id)} className="hover:underline">
        {healthSummaryLine(query.data, Date.now())}
        {reachability ? ` BMC ${reachability}.` : ''}
      </Link>
    </HeaderLine>
  );
}

export function PhoneHomeHeaderLine({ device }: { device: DiagnosticDevice }) {
  const api = useDiagnosticsApi();
  const allowed = api.gates.can('device-tokens.read');
  const query = useQuery({
    queryKey: diagnosticsKeys.deviceTokens(device.id),
    queryFn: () => api.listDeviceTokens(device.id),
    enabled: allowed,
  });
  if (!allowed || query.data === undefined) return null;
  // a rotated-out token still holds the newest phone-home, so status is not a filter here
  const newest = query.data
    .filter((token) => token.lastUsedAt !== null)
    .sort((a, b) => new Date(b.lastUsedAt ?? 0).getTime() - new Date(a.lastUsedAt ?? 0).getTime())[0];
  return (
    <HeaderLine label="phone-home">
      <Link to={api.hrefs.health(device.id)} className="hover:underline">
        {newest?.lastUsedAt
          ? `${relativeTime(new Date(newest.lastUsedAt).toISOString(), Date.now())} (${newest.context === 'BROKKR_LIVE' ? 'discovery OS' : 'deployment OS'})`
          : 'No phone-home recorded'}
      </Link>
    </HeaderLine>
  );
}
