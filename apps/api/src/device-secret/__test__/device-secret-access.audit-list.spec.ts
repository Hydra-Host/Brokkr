import { ForbiddenException } from '@nestjs/common';
import { AuthType } from 'src/auth/identity-context';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSecretAccessService } from '../device-secret-access.service';

const DEVICE_ID = '00000000-0000-4000-8000-0000000000cc';

function makeHarness(
  overrides: {
    auditRows?: unknown[];
    users?: Array<{ id: string; email: string }>;
    zones?: Array<{ id: string; name: string }>;
    authType?: AuthType;
  } = {},
) {
  const contextService = {
    identity: { authType: overrides.authType ?? AuthType.Session },
    requirePermission: vi.fn(),
  };
  const prisma = {
    device: { findUnique: vi.fn().mockResolvedValue({ id: DEVICE_ID }) },
    deviceSecretAuditEvent: {
      findMany: vi.fn().mockResolvedValue(overrides.auditRows ?? []),
      count: vi.fn().mockResolvedValue((overrides.auditRows ?? []).length),
    },
    user: { findMany: vi.fn().mockResolvedValue(overrides.users ?? []) },
    zone: { findMany: vi.fn().mockResolvedValue(overrides.zones ?? []) },
  };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new DeviceSecretAccessService(
    {} as never,
    contextService as never,
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger as never,
  );
  return { service, prisma, contextService };
}

function auditRow(overrides: Record<string, unknown>) {
  return {
    id: 'e1',
    deviceId: DEVICE_ID,
    zoneId: null,
    event: 'WRITE',
    purpose: 'BMC',
    kind: 'USER',
    version: 1,
    actorType: 'USER',
    actor: 'u1',
    requestId: null,
    createdAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('DeviceSecretAccessService audit listing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves user actor ids to emails and keeps the raw actor id', async () => {
    const rows = [auditRow({ id: 'e1', actorType: 'USER', actor: 'u1' })];
    const { service, prisma } = makeHarness({ auditRows: rows, users: [{ id: 'u1', email: 'kent@example.com' }] });
    const result = await service.listAuditEvents(DEVICE_ID, { page: 1 });
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['u1'] } },
      select: { id: true, email: true },
    });
    expect(result.data[0].actorDisplay).toBe('kent@example.com');
    expect(result.data[0].actor).toBe('u1');
  });

  it('falls back to a null display when the user row is gone (deleted user)', async () => {
    const rows = [auditRow({ id: 'e1', actorType: 'USER', actor: 'u-deleted' })];
    const { service } = makeHarness({ auditRows: rows, users: [] });
    const result = await service.listAuditEvents(DEVICE_ID, { page: 1 });
    expect(result.data[0].actorDisplay).toBeNull();
    expect(result.data[0].actor).toBe('u-deleted');
  });

  it('resolves bridge actor ids that are zone ids to the zone name', async () => {
    const zoneId = '00000000-0000-4000-8000-0000000000dd';
    const rows = [auditRow({ id: 'e1', event: 'REVEAL_DELIVERED', actorType: 'BRIDGE', actor: zoneId })];
    const { service, prisma } = makeHarness({ auditRows: rows, zones: [{ id: zoneId, name: 'DC Paris 1' }] });
    const result = await service.listAuditEvents(DEVICE_ID, { page: 1 });
    expect(prisma.zone.findMany).toHaveBeenCalledWith({
      where: { id: { in: [zoneId] } },
      select: { id: true, name: true },
    });
    expect(result.data[0].actorDisplay).toBe('DC Paris 1');
  });

  it('leaves bridge instance ids that are not zones unresolved', async () => {
    const rows = [auditRow({ id: 'e1', event: 'DISPATCH', actorType: 'BRIDGE', actor: 'bridge-a' })];
    const { service } = makeHarness({ auditRows: rows, zones: [] });
    const result = await service.listAuditEvents(DEVICE_ID, { page: 1 });
    expect(result.data[0].actorDisplay).toBeNull();
    expect(result.data[0].actor).toBe('bridge-a');
  });

  it('skips actor lookups entirely for system/null actors', async () => {
    const rows = [auditRow({ id: 'e1', event: 'INVALIDATED', actorType: 'SYSTEM', actor: null })];
    const { service, prisma } = makeHarness({ auditRows: rows });
    const result = await service.listAuditEvents(DEVICE_ID, { page: 1 });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.zone.findMany).not.toHaveBeenCalled();
    expect(result.data[0].actorDisplay).toBeNull();
  });

  it('rejects api-key auth: the trail is session-only like every other secret operation', async () => {
    const { service, prisma } = makeHarness({ authType: AuthType.ApiKey });
    await expect(service.listAuditEvents(DEVICE_ID, { page: 1 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.deviceSecretAuditEvent.findMany).not.toHaveBeenCalled();
  });
});
