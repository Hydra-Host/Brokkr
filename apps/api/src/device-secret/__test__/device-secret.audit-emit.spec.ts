import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
} from '@repo/database';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeviceSecretService } from '../device-secret.service';

vi.mock('../device-secret.crypto', () => ({
  sealDeviceSecret: vi.fn().mockReturnValue({
    ephPub: Buffer.from('eph'),
    ciphertext: Buffer.from('ct'),
    tag: Buffer.from('tag'),
  }),
}));

const ENROLLMENT = { id: 'zk-1', zonePub: Buffer.from('zonepub'), generation: 5 };

interface Harness {
  service: DeviceSecretService;
  auditRecord: ReturnType<typeof vi.fn>;
  deviceSecret: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(opts?: { enrollmentGen?: number | null }): Harness {
  const deviceSecret = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    deviceSecret,
  };
  const prisma = {
    deviceSecret,
    device: { findUnique: vi.fn().mockResolvedValue({ zoneId: 'zone-1' }) },
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const enrollmentGen = opts?.enrollmentGen === undefined ? ENROLLMENT.generation : opts.enrollmentGen;
  const zoneCryptoConfig = { isAvailable: true, privateKey: Buffer.from('hubpriv') };
  const zoneCryptoRepository = {
    findEnrollmentByZoneId: vi
      .fn()
      .mockResolvedValue(enrollmentGen === null ? null : { ...ENROLLMENT, generation: enrollmentGen }),
  };
  const auditRecord = vi.fn().mockResolvedValue(undefined);
  const audit = { record: auditRecord };
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new DeviceSecretService(
    prisma as never,
    zoneCryptoConfig as never,
    zoneCryptoRepository as never,
    audit as never,
    logger as never,
  );
  return { service, auditRecord, deviceSecret };
}

const SECRET = { user: 'admin', pass: 'p' };

describe('DeviceSecretService audit emission', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits WRITE for the first version, atomically with the seal (transaction client)', async () => {
    const { service, auditRecord, deviceSecret } = makeHarness();
    deviceSecret.findFirst.mockResolvedValueOnce(null);
    deviceSecret.create.mockResolvedValueOnce({
      version: 1,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      createdAt: new Date(),
      createdById: 'user-1',
      invalidatedAt: null,
    });

    await service.write('dev-1', DeviceSecretPurpose.BMC, DeviceSecretKind.USER, SECRET, 'user-1');

    expect(auditRecord).toHaveBeenCalledOnce();
    const [input, client] = auditRecord.mock.calls[0];
    expect(input).toMatchObject({
      deviceId: 'dev-1',
      event: DeviceSecretAuditEventType.WRITE,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 1,
      actor: { type: DeviceSecretActorType.USER, id: 'user-1' },
    });
    expect(client).toBeDefined();
  });

  it('emits UPDATE when a prior version exists', async () => {
    const { service, auditRecord, deviceSecret } = makeHarness();
    deviceSecret.findFirst.mockResolvedValueOnce({ version: 2 });
    deviceSecret.create.mockResolvedValueOnce({
      version: 3,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      createdAt: new Date(),
      createdById: 'user-1',
      invalidatedAt: null,
    });

    await service.write('dev-1', DeviceSecretPurpose.BMC, DeviceSecretKind.USER, SECRET, 'user-1');

    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      event: DeviceSecretAuditEventType.UPDATE,
      version: 3,
    });
  });

  it('does NOT emit when skipIfLivePresent reuses an existing live version', async () => {
    const { service, auditRecord, deviceSecret } = makeHarness();
    deviceSecret.findFirst.mockResolvedValueOnce({
      version: 1,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      createdAt: new Date(),
      createdById: 'user-1',
      invalidatedAt: null,
    });

    await service.write('dev-1', DeviceSecretPurpose.BMC, DeviceSecretKind.USER, SECRET, 'user-1', {
      skipIfLivePresent: true,
    });

    expect(auditRecord).not.toHaveBeenCalled();
    expect(deviceSecret.create).not.toHaveBeenCalled();
  });
});
