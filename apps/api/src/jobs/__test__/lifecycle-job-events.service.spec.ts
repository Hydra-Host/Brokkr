import { NotFoundException } from '@nestjs/common';
import type { LifecycleJobEvent } from '@repo/database';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { ContextService } from 'src/common/context/context.service';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LifecycleJobEventsService } from '../lifecycle-job-events.service';

const JOB = '44444444-4444-4444-4444-444444444444';

const row = (over: Partial<LifecycleJobEvent> = {}): LifecycleJobEvent => ({
  id: 'e-1',
  jobId: JOB,
  sagaName: 'provision',
  stepName: 'power_cycle',
  operation: 'Power cycle the server',
  eventType: 'job_failed',
  status: 'failed',
  result: { password: 'x', ok: 1 },
  error: 'BMC did not answer',
  attempt: 1,
  occurredAt: new Date('2026-09-16T12:00:00.000Z'),
  recordedAt: new Date('2026-09-16T12:00:06.200Z'),
  ...over,
});

function setup(rows: LifecycleJobEvent[], found = true) {
  const calls: string[] = [];
  const contextService = {
    requirePermission: vi.fn(() => {
      calls.push('permission');
      return undefined;
    }),
    requireInstanceOperator: vi.fn(() => {
      calls.push('operator');
    }),
  } as unknown as ContextService;
  vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(found ? ({ data: { id: JOB } } as never) : null);
  const list = vi.spyOn(LifecycleJobRecord, 'listEventsUnscoped').mockResolvedValue(rows);
  return { service: new LifecycleJobEventsService(contextService), calls, list };
}

describe('LifecycleJobEventsService.list', () => {
  afterEach(() => vi.restoreAllMocks());

  it('checks the permission before the operator designation', async () => {
    const { service, calls } = setup([row()]);
    await service.list(JOB);
    expect(calls).toEqual(['permission', 'operator']);
  });

  it('404s an unknown job', async () => {
    const { service } = setup([], false);
    await expect(service.list(JOB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('reads one past the cap and reports truncation', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => row({ id: `e-${i}` }));
    const { service, list } = setup(rows);
    const out = await service.list(JOB);
    expect(list).toHaveBeenCalledWith(JOB, 501);
    expect(out.data).toHaveLength(500);
    expect(out.meta).toEqual({ truncated: true, cap: 500 });
  });

  it('redacts secret-shaped keys in result', async () => {
    const { service } = setup([row()]);
    const out = await service.list(JOB);
    expect(out.data[0]?.result).toEqual({ password: '***', ok: 1 });
  });

  it('marks engine-stamped rows as hub origin', async () => {
    const { service } = setup([row({ eventType: 'phone_home' }), row({ id: 'e-2', eventType: 'job_completed' })]);
    const out = await service.list(JOB);
    expect(out.data.map((e) => e.origin)).toEqual(['hub', 'bridge']);
  });
});
