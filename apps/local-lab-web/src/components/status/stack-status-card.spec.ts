import { describe, expect, it } from 'vitest';

import type { InitTask } from '@/contract';

import { deriveStackStatus } from './stack-status-card';

type DatastoreLike = { id: string; status: string };
type MinService = { id: string; group: string; health: string };

const ds = (id: string, status: string): DatastoreLike => ({ id, status });
const svc = (id: string, group: string, health: string) => ({ id, group, health }) as unknown as MinService;
const init = (name: string, state: InitTask['state'], over: Partial<InitTask> = {}): InitTask => ({
  name,
  label: name,
  state,
  exitCode: state === 'failed' ? 1 : null,
  detail: null,
  updatedAt: 1_000,
  ...over,
});
const upStack = () => ({
  datastores: [ds('pg', 'up'), ds('redis', 'up')],
  services: [svc('hub-api', 'hub', 'up'), svc('spoke', 'spoke', 'up')] as never[],
});
const derive = (initTasks: InitTask[]) => {
  const { datastores, services } = upStack();
  return deriveStackStatus(datastores, services, false, new Set(), initTasks);
};
const stepState = (status: ReturnType<typeof derive>, key: string) => status.steps.find((s) => s.key === key)?.state;

describe('deriveStackStatus', () => {
  it('returns ready when all enabled datastores and services are up', () => {
    const result = deriveStackStatus(
      [ds('pg', 'up'), ds('redis', 'up')],
      [svc('hub-api', 'hub', 'up')] as never[],
      false,
    );
    expect(result.health).toBe('ready');
  });

  it('excludes genuinely disabled datastores with no pending op (original fix)', () => {
    const result = deriveStackStatus(
      [ds('pg', 'up'), ds('redis', 'up'), ds('fleet-ds', 'disabled')],
      [svc('hub-api', 'hub', 'up')] as never[],
      false,
    );
    expect(result.health).toBe('ready');
  });

  it('does not report ready while a disabled datastore has a pending start op', () => {
    const pending = new Set(['fleet-ds']);
    const result = deriveStackStatus(
      [ds('pg', 'up'), ds('redis', 'up'), ds('fleet-ds', 'disabled')],
      [svc('hub-api', 'hub', 'up')] as never[],
      false,
      pending,
    );
    expect(result.health).not.toBe('ready');
    expect(result.health).toBe('coming-up');
  });

  it('shows coming-up when hasActiveRun is true and not all tiers are done', () => {
    const result = deriveStackStatus(
      [ds('pg', 'up'), ds('redis', 'down')],
      [svc('hub-api', 'hub', 'up')] as never[],
      true,
    );
    expect(result.health).toBe('coming-up');
  });

  it('reports failed when a datastore is failed and no op is in flight', () => {
    const result = deriveStackStatus(
      [ds('pg', 'failed'), ds('redis', 'up')],
      [svc('hub-api', 'hub', 'up')] as never[],
      false,
    );
    expect(result.health).toBe('failed');
  });

  it('treats a pending service as unhealthy (coming-up, not failed)', () => {
    const pending = new Set(['hub-api']);
    const result = deriveStackStatus([ds('pg', 'up')], [svc('hub-api', 'hub', 'down')] as never[], false, pending);
    expect(result.health).toBe('coming-up');
  });
});

describe('deriveStackStatus init attribution', () => {
  it('never reports ready while an init task the hub owns is still running', () => {
    const result = derive([init('sim:seed', 'running')]);

    expect(stepState(result, 'hub')).toBe('active');
    expect(result.health).toBe('coming-up');
  });

  it('holds the spoke tier open while a spoke init task runs', () => {
    const result = derive([init('zone-crypto:seed-bmc', 'running')]);

    expect(stepState(result, 'spoke')).toBe('active');
    expect(stepState(result, 'hub')).toBe('done');
  });

  it('fails the tier its failed init task gates', () => {
    const result = derive([init('hub:migrate', 'failed')]);

    expect(stepState(result, 'hub')).toBe('failed');
    expect(stepState(result, 'spoke')).toBe('done');
    expect(result.health).toBe('failed');
  });

  it('lets a completed init task leave the tier alone', () => {
    const result = derive([init('hub:migrate', 'completed'), init('redis-acl:seed', 'completed')]);

    expect(result.health).toBe('ready');
    expect(result.pct).toBe(100);
  });

  it('does not treat a pending init task as outstanding work', () => {
    const result = derive([init('hub:init', 'pending'), init('spoke:init', 'pending')]);

    expect(stepState(result, 'hub')).toBe('done');
    expect(stepState(result, 'spoke')).toBe('done');
    expect(result.health).toBe('ready');
    expect(result.pct).toBe(100);
  });

  it('keeps a failed process tier failed even while an init task still runs', () => {
    const result = deriveStackStatus([ds('pg', 'up')], [svc('hub-api', 'hub', 'failed')] as never[], false, new Set(), [
      init('hub:migrate', 'running'),
    ]);

    expect(stepState(result, 'hub')).toBe('failed');
  });

  it('attributes neither apps:init nor fleet:init to any tier', () => {
    const result = derive([init('apps:init', 'running'), init('fleet:init', 'failed')]);

    expect(result.health).toBe('ready');
    expect(result.steps.map((s) => s.key)).toEqual(['datastores', 'hub', 'spoke']);
  });

  it('names the running init task as the blocker rather than only its tier', () => {
    const result = deriveStackStatus([ds('pg', 'up')], [svc('hub-api', 'hub', 'up')] as never[], false, new Set(), [
      init('hub:migrate', 'running', { label: 'Hub DB migrate' }),
    ]);

    expect(result.detail).toBe('hub coming up — Hub DB migrate');
  });

  it('leaves the detail unqualified when nothing in that tier is running', () => {
    const result = deriveStackStatus(
      [ds('pg', 'up'), ds('redis', 'down')],
      [svc('hub-api', 'hub', 'up')] as never[],
      false,
    );

    expect(result.detail).toBe('datastores coming up');
  });
});
