import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceSecretKind,
  DeviceSecretPurpose,
} from '@repo/database';
import { Buffer } from 'node:buffer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealDeviceSecret } from '../device-secret.crypto';
import { DeviceSecretService } from '../device-secret.service';

vi.mock('../device-secret.crypto', () => ({
  sealDeviceSecret: vi.fn().mockReturnValue({
    ephPub: Buffer.from('eph'),
    ciphertext: Buffer.from('ct'),
    tag: Buffer.from('tag'),
  }),
}));

const sealDeviceSecretMock = vi.mocked(sealDeviceSecret);

const ENROLLMENT = { id: 'zk-1', zonePub: Buffer.from('zonepub'), generation: 5 };
const USER_ACTOR = { type: DeviceSecretActorType.USER, id: 'user-1' };

function deviceSecretClient() {
  return {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  };
}

function makeHarness(opts?: { enrollmentGen?: number | null; privateKey?: Buffer | null }) {
  const prismaDeviceSecret = deviceSecretClient();
  const txDeviceSecret = deviceSecretClient();
  const txDevice = { findUnique: vi.fn().mockResolvedValue({ zoneId: 'zone-tx' }) };
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(undefined),
    deviceSecret: txDeviceSecret,
    device: txDevice,
  };
  const prismaDevice = { findUnique: vi.fn().mockResolvedValue({ zoneId: 'zone-1' }) };
  const prisma = {
    deviceSecret: prismaDeviceSecret,
    device: prismaDevice,
    $transaction: vi.fn(async (cb: (t: typeof tx) => unknown) => cb(tx)),
  };
  const enrollmentGen = opts?.enrollmentGen === undefined ? ENROLLMENT.generation : opts.enrollmentGen;
  const privateKey = opts?.privateKey === undefined ? Buffer.from('hubpriv') : opts.privateKey;
  const zoneCryptoConfig = { isAvailable: privateKey !== null, privateKey };
  const findEnrollmentByZoneId = vi
    .fn()
    .mockResolvedValue(enrollmentGen === null ? null : { ...ENROLLMENT, generation: enrollmentGen });
  const zoneCryptoRepository = { findEnrollmentByZoneId };
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
  return {
    service,
    auditRecord,
    findEnrollmentByZoneId,
    prisma,
    tx,
    prismaDeviceSecret,
    txDeviceSecret,
    prismaDevice,
    txDevice,
    logger,
  };
}

const SECRET = { user: 'admin', pass: 'p' };

describe('DeviceSecretService.invalidateAll', () => {
  beforeEach(() => vi.clearAllMocks());

  it('snapshots the live ids first, then stamps exactly those ids and audits every one', async () => {
    const { service, auditRecord, prismaDeviceSecret } = makeHarness();
    const invalidated = [
      { id: 'row-1', purpose: DeviceSecretPurpose.BMC, kind: DeviceSecretKind.USER, version: 1 },
      { id: 'row-2', purpose: DeviceSecretPurpose.BMC, kind: DeviceSecretKind.KEY, version: 2 },
      { id: 'row-3', purpose: DeviceSecretPurpose.CONSOLE, kind: DeviceSecretKind.TOKEN, version: 1 },
    ];
    prismaDeviceSecret.findMany.mockResolvedValueOnce(invalidated);

    const count = await service.invalidateAll('dev-1', USER_ACTOR, 'device abandoned');

    expect(count).toBe(3);
    expect(prismaDeviceSecret.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { deviceId: 'dev-1', invalidatedAt: null } }),
    );
    expect(prismaDeviceSecret.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['row-1', 'row-2', 'row-3'] } },
      data: { invalidatedAt: expect.any(Date) },
    });
    expect(auditRecord).toHaveBeenCalledTimes(3);
    for (let i = 0; i < invalidated.length; i++) {
      expect(auditRecord.mock.calls[i][0]).toMatchObject({
        deviceId: 'dev-1',
        event: DeviceSecretAuditEventType.INVALIDATED,
        purpose: invalidated[i].purpose,
        kind: invalidated[i].kind,
        version: invalidated[i].version,
        actor: USER_ACTOR,
        payload: { cause: 'device abandoned' },
      });
    }
  });

  it('returns 0 and skips the stamp/audit when no live rows exist', async () => {
    const { service, auditRecord, prismaDeviceSecret } = makeHarness();
    prismaDeviceSecret.findMany.mockResolvedValueOnce([]);

    const count = await service.invalidateAll('dev-1', USER_ACTOR, 'nothing to do');

    expect(count).toBe(0);
    expect(prismaDeviceSecret.updateMany).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('runs on the supplied tx client (not this.prisma) and threads the tx into audit.record', async () => {
    const { service, auditRecord, prismaDeviceSecret, txDeviceSecret, tx } = makeHarness();
    txDeviceSecret.findMany.mockResolvedValueOnce([
      { id: 'row-1', purpose: DeviceSecretPurpose.BMC, kind: DeviceSecretKind.USER, version: 1 },
    ]);

    const count = await service.invalidateAll('dev-1', USER_ACTOR, 'soft-delete', tx as never);

    expect(count).toBe(1);
    expect(txDeviceSecret.updateMany).toHaveBeenCalledOnce();
    expect(txDeviceSecret.findMany).toHaveBeenCalledOnce();
    expect(prismaDeviceSecret.findMany).not.toHaveBeenCalled();
    expect(prismaDeviceSecret.updateMany).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord.mock.calls[0][1]).toBe(tx);
  });
});

describe('DeviceSecretService.sealEphemeral', () => {
  beforeEach(() => vi.clearAllMocks());

  const EPH_ACTOR = { type: DeviceSecretActorType.USER, id: 'user-1' };

  it('binds the AAD to exactly the fields carried on the returned envelope', async () => {
    const { service } = makeHarness({ enrollmentGen: 7 });

    const envelope = await service.sealEphemeral(
      'zone-eph',
      'synthetic-dev',
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      SECRET,
      EPH_ACTOR,
    );

    expect(sealDeviceSecretMock).toHaveBeenCalledOnce();
    const aad = sealDeviceSecretMock.mock.calls[0][3];
    expect(aad).toEqual({
      zoneId: envelope.zoneId,
      zoneKeyId: envelope.zoneKeyId,
      deviceId: envelope.deviceId,
      purpose: envelope.purpose,
      kind: envelope.kind,
      keyGen: envelope.keyGen,
    });
    expect(envelope).toMatchObject({
      zoneId: 'zone-eph',
      zoneKeyId: ENROLLMENT.id,
      deviceId: 'synthetic-dev',
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      keyGen: 7,
    });
  });

  it('skips the audit row and stays log-only when the actor is SYSTEM', async () => {
    const { service, auditRecord, prisma, logger } = makeHarness({ enrollmentGen: 7 });

    const envelope = await service.sealEphemeral(
      'zone-eph',
      'synthetic-dev',
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      SECRET,
      { type: DeviceSecretActorType.SYSTEM, id: null },
    );

    expect(envelope.keyGen).toBe(7);
    expect(auditRecord).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalledOnce();
    const line = logger.log.mock.calls[0][0];
    expect(line).toContain('zone zone-eph');
    expect(line).toContain('gen 7');
    expect(line).toContain('plan synthetic-dev');
    expect(line).toContain(DeviceSecretKind.USER);
    expect(line).toContain(DeviceSecretPurpose.BMC);
  });

  it('records a device-less DISPATCH disclosure against the zone for non-system actors', async () => {
    const { service, auditRecord } = makeHarness({ enrollmentGen: 7 });

    await service.sealEphemeral(
      'zone-eph',
      'synthetic-dev',
      DeviceSecretPurpose.BMC,
      DeviceSecretKind.USER,
      SECRET,
      EPH_ACTOR,
    );

    expect(auditRecord).toHaveBeenCalledOnce();
    expect(auditRecord.mock.calls[0][0]).toMatchObject({
      deviceId: null,
      zoneId: 'zone-eph',
      event: DeviceSecretAuditEventType.DISPATCH,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      actor: EPH_ACTOR,
      requestId: 'synthetic-dev',
      payload: expect.objectContaining({ keyGen: 7, ephemeral: true, planId: 'synthetic-dev' }),
    });
  });

  it('throws SecretStorageUnavailableError when the hub key is dormant', async () => {
    const { service, findEnrollmentByZoneId, auditRecord } = makeHarness({ privateKey: null });

    await expect(
      service.sealEphemeral(
        'zone-eph',
        'synthetic-dev',
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        SECRET,
        EPH_ACTOR,
      ),
    ).rejects.toThrow(/dormant/i);
    expect(findEnrollmentByZoneId).not.toHaveBeenCalled();
    expect(sealDeviceSecretMock).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('throws SecretStorageUnavailableError when the zone is not enrolled', async () => {
    const { service, auditRecord } = makeHarness({ enrollmentGen: null });

    await expect(
      service.sealEphemeral(
        'zone-eph',
        'synthetic-dev',
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        SECRET,
        EPH_ACTOR,
      ),
    ).rejects.toThrow(/not enrolled/i);
    expect(sealDeviceSecretMock).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });
});

describe('DeviceSecretService.write (caller-supplied tx join branch)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('joins the caller tx directly: no nested $transaction, tx used throughout, tx threaded into lookups', async () => {
    const { service, prisma, tx, txDeviceSecret, txDevice, prismaDeviceSecret, prismaDevice, findEnrollmentByZoneId } =
      makeHarness();
    txDeviceSecret.findFirst.mockResolvedValueOnce(null);
    txDeviceSecret.create.mockResolvedValueOnce({
      version: 1,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      createdAt: new Date(),
      createdById: 'user-1',
      invalidatedAt: null,
    });

    await service.write('dev-1', DeviceSecretPurpose.BMC, DeviceSecretKind.USER, SECRET, 'user-1', {
      tx: tx as never,
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(txDeviceSecret.findFirst).toHaveBeenCalledOnce();
    expect(txDeviceSecret.create).toHaveBeenCalledOnce();
    expect(prismaDeviceSecret.findFirst).not.toHaveBeenCalled();
    expect(prismaDeviceSecret.create).not.toHaveBeenCalled();
    expect(txDevice.findUnique).toHaveBeenCalledOnce();
    expect(prismaDevice.findUnique).not.toHaveBeenCalled();
    expect(findEnrollmentByZoneId).toHaveBeenCalledWith('zone-tx', tx);
  });
});
