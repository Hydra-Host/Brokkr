import type { ContextService } from 'src/common/context/context.service';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import type { IpamQueryExecutor } from '../../shared/base-ipam.repository';
import { PrefixRepository } from '../prefix.repository';

const PREFIX_ID = 'prefix-1';
const OLD_GW = 'gw-ip-old';
const NEW_GW = 'gw-ip-new';
const VRF_ID = 'vrf-1';

function makeRepo(): PrefixRepository {
  const prisma = {} as unknown as PrismaClient;
  const contextService = { organizationId: 'org-1' } as unknown as ContextService;
  return new PrefixRepository(prisma, contextService);
}

function makeExecutor(queryResults: unknown[][], executeResults: number[]) {
  const queryRaw = vi.fn();
  for (const result of queryResults) queryRaw.mockResolvedValueOnce(result);
  queryRaw.mockResolvedValue([]);
  const executeRaw = vi.fn();
  for (const result of executeResults) executeRaw.mockResolvedValueOnce(result);
  executeRaw.mockResolvedValue(0);
  const executor: IpamQueryExecutor = { queryRaw, executeRaw, createChangelog: vi.fn() };
  return { executor, queryRaw, executeRaw };
}

function sqlOf(call: unknown[]): string {
  const [template] = call;
  return (template as string[]).join('?');
}

describe('PrefixRepository.syncGatewayRecordOnSet', () => {
  it('creates an auto-managed row at priority 100 on a fresh set', async () => {
    const { executor, executeRaw } = makeExecutor([[]], [1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnSet(PREFIX_ID, NEW_GW, null, VRF_ID, executor);

    expect(result).toEqual({ action: 'created', customRowPreserved: false });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const insertSql = sqlOf(executeRaw.mock.calls[0]);
    expect(insertSql).toContain('INSERT INTO "Gateway"');
    expect(executeRaw.mock.calls[0]).toEqual(expect.arrayContaining([NEW_GW, PREFIX_ID, VRF_ID, 100]));
  });

  it('is a noop when a row for the new gateway ip already exists', async () => {
    const { executor, executeRaw } = makeExecutor([[{ id: 'gw-row-1' }]], []);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnSet(PREFIX_ID, NEW_GW, null, VRF_ID, executor);

    expect(result).toEqual({ action: 'noop', customRowPreserved: false });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it('self-heals a missing row when the same gateway is re-set', async () => {
    const { executor, executeRaw } = makeExecutor([[]], [1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnSet(PREFIX_ID, OLD_GW, OLD_GW, null, executor);

    expect(result).toEqual({ action: 'created', customRowPreserved: false });
    expect(sqlOf(executeRaw.mock.calls[0])).toContain('INSERT INTO "Gateway"');
  });

  it('moves the auto-managed row to the new gateway ip on change', async () => {
    const { executor, executeRaw } = makeExecutor([[], []], [1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnSet(PREFIX_ID, NEW_GW, OLD_GW, VRF_ID, executor);

    expect(result).toEqual({ action: 'updated', customRowPreserved: false });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const updateSql = sqlOf(executeRaw.mock.calls[0]);
    expect(updateSql).toContain('UPDATE "Gateway"');
    expect(updateSql).toContain('"routingPriority" =');
    expect(executeRaw.mock.calls[0]).toEqual(expect.arrayContaining([NEW_GW, OLD_GW, PREFIX_ID, VRF_ID, 100]));
  });

  it('preserves an operator-customized row for the old ip and creates a fresh auto row', async () => {
    const { executor, executeRaw } = makeExecutor([[], [{ id: 'custom-row' }]], [0, 1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnSet(PREFIX_ID, NEW_GW, OLD_GW, null, executor);

    expect(result).toEqual({ action: 'created', customRowPreserved: true });
    expect(sqlOf(executeRaw.mock.calls[0])).toContain('UPDATE "Gateway"');
    expect(sqlOf(executeRaw.mock.calls[1])).toContain('INSERT INTO "Gateway"');
  });

  it('drops the stale auto row when a row for the new ip already exists on change', async () => {
    const { executor, executeRaw } = makeExecutor([[{ id: 'gw-row-new' }], []], [1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnSet(PREFIX_ID, NEW_GW, OLD_GW, null, executor);

    expect(result).toEqual({ action: 'noop', customRowPreserved: false });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const deleteSql = sqlOf(executeRaw.mock.calls[0]);
    expect(deleteSql).toContain('DELETE FROM "Gateway"');
    expect(executeRaw.mock.calls[0]).toEqual(expect.arrayContaining([PREFIX_ID, OLD_GW, 100]));
  });
});

describe('PrefixRepository.syncGatewayRecordOnClear', () => {
  it('removes the auto-managed row at priority 100', async () => {
    const { executor, executeRaw } = makeExecutor([], [1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnClear(PREFIX_ID, OLD_GW, executor);

    expect(result).toEqual({ action: 'removed', customRowPreserved: false });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const deleteSql = sqlOf(executeRaw.mock.calls[0]);
    expect(deleteSql).toContain('DELETE FROM "Gateway"');
    expect(deleteSql).toContain('"routingPriority" =');
    expect(executeRaw.mock.calls[0]).toEqual(expect.arrayContaining([PREFIX_ID, OLD_GW, 100]));
  });

  it('reports a surviving custom row even when the auto-managed row was removed', async () => {
    const { executor, executeRaw } = makeExecutor([[{ id: 'custom-row' }]], [1]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnClear(PREFIX_ID, OLD_GW, executor);

    expect(result).toEqual({ action: 'removed', customRowPreserved: true });
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('preserves an operator-customized row instead of deleting it', async () => {
    const { executor, executeRaw } = makeExecutor([[{ id: 'custom-row' }]], [0]);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnClear(PREFIX_ID, OLD_GW, executor);

    expect(result).toEqual({ action: 'noop', customRowPreserved: true });
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('is a noop without touching the db when no gateway was set', async () => {
    const { executor, executeRaw, queryRaw } = makeExecutor([], []);
    const repo = makeRepo();

    const result = await repo.syncGatewayRecordOnClear(PREFIX_ID, null, executor);

    expect(result).toEqual({ action: 'noop', customRowPreserved: false });
    expect(executeRaw).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
