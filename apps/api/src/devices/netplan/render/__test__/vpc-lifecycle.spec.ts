import { ServerLifecycleStatus } from '@repo/database';
import type { DeviceContext } from '../../../device-context/device-context.types';
import type { NetplanPhase } from '../../netplan.service';
import { deriveVpcLifecycle } from '../vpc-lifecycle';

function ctxWith(lifecycleStatus: ServerLifecycleStatus | null): DeviceContext {
  const device = lifecycleStatus === null ? {} : { server: { lifecycleStatus } };
  return { device } as unknown as DeviceContext;
}

const PHASES: NetplanPhase[] = ['live', 'deploy'];

const CELLS: Array<{
  status: ServerLifecycleStatus | null;
  phase: NetplanPhase;
  isDiscovery: boolean;
  isDeprovisioning: boolean;
  isFailed: boolean;
}> = [
  { status: null, phase: 'live', isDiscovery: true, isDeprovisioning: true, isFailed: false },
  { status: null, phase: 'deploy', isDiscovery: false, isDeprovisioning: false, isFailed: false },

  {
    status: ServerLifecycleStatus.INVENTORY,
    phase: 'live',
    isDiscovery: true,
    isDeprovisioning: true,
    isFailed: false,
  },
  {
    status: ServerLifecycleStatus.INVENTORY,
    phase: 'deploy',
    isDiscovery: false,
    isDeprovisioning: true,
    isFailed: false,
  },

  {
    status: ServerLifecycleStatus.DEPROVISIONING,
    phase: 'live',
    isDiscovery: true,
    isDeprovisioning: true,
    isFailed: false,
  },
  {
    status: ServerLifecycleStatus.DEPROVISIONING,
    phase: 'deploy',
    isDiscovery: false,
    isDeprovisioning: true,
    isFailed: false,
  },

  {
    status: ServerLifecycleStatus.PROVISIONED,
    phase: 'live',
    isDiscovery: true,
    isDeprovisioning: true,
    isFailed: false,
  },
  {
    status: ServerLifecycleStatus.PROVISIONED,
    phase: 'deploy',
    isDiscovery: false,
    isDeprovisioning: false,
    isFailed: false,
  },

  {
    status: ServerLifecycleStatus.PROVISIONING,
    phase: 'live',
    isDiscovery: true,
    isDeprovisioning: true,
    isFailed: false,
  },
  {
    status: ServerLifecycleStatus.PROVISIONING,
    phase: 'deploy',
    isDiscovery: false,
    isDeprovisioning: false,
    isFailed: false,
  },

  { status: ServerLifecycleStatus.OFFLINE, phase: 'live', isDiscovery: true, isDeprovisioning: true, isFailed: false },
  {
    status: ServerLifecycleStatus.OFFLINE,
    phase: 'deploy',
    isDiscovery: false,
    isDeprovisioning: false,
    isFailed: false,
  },

  { status: ServerLifecycleStatus.FAILED, phase: 'live', isDiscovery: true, isDeprovisioning: true, isFailed: true },
  {
    status: ServerLifecycleStatus.FAILED,
    phase: 'deploy',
    isDiscovery: false,
    isDeprovisioning: false,
    isFailed: true,
  },
];

describe('deriveVpcLifecycle', () => {
  it.each(CELLS)(
    'status=$status phase=$phase -> discovery=$isDiscovery deprovisioning=$isDeprovisioning failed=$isFailed',
    ({ status, phase, isDiscovery, isDeprovisioning, isFailed }) => {
      expect(deriveVpcLifecycle(ctxWith(status), phase)).toEqual({ isDiscovery, isDeprovisioning, isFailed });
    },
  );

  it('covers every lifecycle status in both phases', () => {
    const statuses = Object.values(ServerLifecycleStatus);
    for (const status of statuses) {
      for (const phase of PHASES) {
        expect(CELLS.some((c) => c.status === status && c.phase === phase)).toBe(true);
      }
    }
    // …plus the no-Server-row case (bridges and unprovisioned devices).
    expect(CELLS.filter((c) => c.status === null)).toHaveLength(PHASES.length);
  });
});
