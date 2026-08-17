import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
} from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSecretAuditService } from '../device-secret-audit.service';

function makeService() {
  const create = vi.fn().mockResolvedValue({ id: 'evt' });
  const prisma = { deviceSecretAuditEvent: { create } };
  const logger = { error: vi.fn(), warn: vi.fn(), log: vi.fn() };
  const service = new DeviceSecretAuditService(prisma as never, logger as never);
  return { service, create, logger };
}

const BASE = {
  deviceId: 'dev-1',
  event: DeviceSecretAuditEventType.WRITE,
  purpose: DeviceSecretPurpose.BMC,
  actor: { type: DeviceSecretActorType.USER, id: 'user-1' },
} as const;

describe('DeviceSecretAuditService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('persists an event with actor, device, and metadata mapped onto the row', async () => {
    const { service, create } = makeService();
    await service.record({
      ...BASE,
      kind: DeviceSecretKind.USER,
      version: 3,
      requestId: 'req-9',
      payload: { zoneId: 'zone-1', keyGen: 2 },
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0][0]).toEqual({
      data: {
        deviceId: 'dev-1',
        event: DeviceSecretAuditEventType.WRITE,
        purpose: DeviceSecretPurpose.BMC,
        kind: DeviceSecretKind.USER,
        version: 3,
        actorType: DeviceSecretActorType.USER,
        actor: 'user-1',
        requestId: 'req-9',
        ip: null,
        userAgent: null,
        payload: { zoneId: 'zone-1', keyGen: 2 },
      },
    });
  });

  it('defaults optional fields to null and omits payload when absent', async () => {
    const { service, create } = makeService();
    await service.record({ ...BASE, actor: { type: DeviceSecretActorType.SYSTEM, id: null } });
    const data = create.mock.calls[0][0].data;
    expect(data.kind).toBeNull();
    expect(data.version).toBeNull();
    expect(data.requestId).toBeNull();
    expect(data.actorType).toBe(DeviceSecretActorType.SYSTEM);
    expect(data.actor).toBeNull();
    expect('payload' in data).toBe(false);
  });

  it('is fail-soft on the shared client: a write failure is logged, never thrown', async () => {
    const { service, create, logger } = makeService();
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.record(BASE)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toContain('db down');
  });

  it('propagates failures when given a transaction client (audit must be atomic)', async () => {
    const { service, logger } = makeService();
    const txCreate = vi.fn().mockRejectedValue(new Error('tx rollback'));
    const tx = { deviceSecretAuditEvent: { create: txCreate } };
    await expect(service.record(BASE, tx as never)).rejects.toThrow('tx rollback');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('records ip/userAgent from the actor when present', async () => {
    const { service, create } = makeService();
    await service.record({
      ...BASE,
      actor: { type: DeviceSecretActorType.USER, id: 'u', ip: '10.0.0.1', userAgent: 'curl' },
    });
    const data = create.mock.calls[0][0].data;
    expect(data.ip).toBe('10.0.0.1');
    expect(data.userAgent).toBe('curl');
  });

  it('records a device-less DISPATCH against the zone (zoneId set, no device connect)', async () => {
    const { service, create } = makeService();
    await service.record({
      deviceId: null,
      zoneId: 'zone-1',
      event: DeviceSecretAuditEventType.DISPATCH,
      purpose: DeviceSecretPurpose.BMC,
      actor: { type: DeviceSecretActorType.USER, id: 'user-1' },
    });
    const data = create.mock.calls[0][0].data;
    expect(data.zoneId).toBe('zone-1');
    expect('device' in data).toBe(false);
  });

  it('throws when neither deviceId nor zoneId is provided (scope invariant)', async () => {
    const { service, create } = makeService();
    await expect(
      service.record({
        deviceId: null,
        zoneId: null,
        event: DeviceSecretAuditEventType.DISPATCH,
        actor: { type: DeviceSecretActorType.SYSTEM, id: null },
      }),
    ).rejects.toThrow('requires a deviceId or zoneId scope');
    expect(create).not.toHaveBeenCalled();
  });
});
