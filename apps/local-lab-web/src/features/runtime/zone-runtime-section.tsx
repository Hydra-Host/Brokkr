import { ErrorBanner } from '@/features/datastore/shared/error-banner';

import { useZoneRuntime } from './use-zone-runtime';
import { ZoneRuntimeCard } from './zone-runtime-card';

export function ZoneRuntimeSection() {
  const { zones, error, isPending } = useZoneRuntime();

  return (
    <div className="space-y-2">
      <div className="text-text-dim pl-0.5 text-[10px] tracking-wide uppercase">Zone runtime</div>
      {error ? (
        <ErrorBanner>{error}</ErrorBanner>
      ) : zones === null ? (
        <div className="text-text-dim text-xs">{isPending ? 'loading…' : 'no runtime state'}</div>
      ) : zones.length === 0 ? (
        <div className="text-text-dim text-xs">no zones configured</div>
      ) : (
        zones.map((zone) => <ZoneRuntimeCard key={zone.zoneId} zone={zone} />)
      )}
    </div>
  );
}
