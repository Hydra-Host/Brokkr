import type { ServerLifecycleStatus } from '@repo/database';
import { describe, expect, it } from 'vitest';
import type { CollectorContext } from '../../collectors/collector.types';
import { LifecycleComposer } from '../lifecycle.composer';

const makeCtx = (lifecycleStatus: ServerLifecycleStatus | null): CollectorContext =>
  ({
    device: { server: lifecycleStatus === null ? null : { lifecycleStatus } },
    rawBundle: {},
  }) as CollectorContext;

describe('LifecycleComposer', () => {
  const composer = new LifecycleComposer();

  it('non-server (no lifecycle) → untouched', async () => {
    const mutation = await composer.compose(makeCtx(null));
    expect(mutation).toEqual({});
  });

  it.each(['DEPROVISIONING', 'INVENTORY', 'OFFLINE'] as const)('%s → INVENTORY (re-qualification)', async (status) => {
    const mutation = await composer.compose(makeCtx(status));
    expect(mutation.deviceUpdate).toEqual({ server: { update: { lifecycleStatus: 'INVENTORY' } } });
  });

  it.each(['PROVISIONED', 'PROVISIONING', 'FAILED'] as const)('%s → untouched', async (status) => {
    const mutation = await composer.compose(makeCtx(status));
    expect(mutation).toEqual({});
  });
});
