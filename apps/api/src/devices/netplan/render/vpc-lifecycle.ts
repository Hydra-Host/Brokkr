import { ServerLifecycleStatus } from '@repo/database';
import type { DeviceContext } from '../../device-context/device-context.types';
import type { NetplanPhase } from '../netplan.service';

// These booleans flip default-route metrics on customer traffic. `isDiscovery`
// derives from the render `phase` (`live` IS the in-rescue/discovery render) — no live platform column.
export interface VpcLifecycle {
  /** Rendering the in-rescue/discovery config. Gates north-south config and bonding. */
  isDiscovery: boolean;
  // OR'd with `isDiscovery`, matching the Jinja — a discovery render is always
  // treated as deprovisioning for metric purposes.
  isDeprovisioning: boolean;
  isFailed: boolean;
}

const DEPROVISIONING_LIFECYCLE: ReadonlySet<ServerLifecycleStatus> = new Set([
  ServerLifecycleStatus.DEPROVISIONING,
  ServerLifecycleStatus.INVENTORY,
]);

export function deriveVpcLifecycle(ctx: DeviceContext, phase: NetplanPhase): VpcLifecycle {
  const lifecycleStatus = ctx.device.server?.lifecycleStatus ?? null;
  const isDiscovery = phase === 'live';

  return {
    isDiscovery,
    isDeprovisioning: isDiscovery || (lifecycleStatus !== null && DEPROVISIONING_LIFECYCLE.has(lifecycleStatus)),
    isFailed: lifecycleStatus === ServerLifecycleStatus.FAILED,
  };
}
