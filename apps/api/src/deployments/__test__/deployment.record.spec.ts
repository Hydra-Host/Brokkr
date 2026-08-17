import { ActiveRecordRegistry } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentRecord } from '../deployment.record';

const mockDelegate = {
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
};

describe('DeploymentRecord', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ActiveRecordRegistry.configureForTest(
      { deployment: mockDelegate, deploymentLifecycleAction: mockDelegate },
      () => ({ organizationId: 'customer-1', permissions: new Set<string>(['deployment:read']) }),
    );
  });

  function buildRecord(overrides = {}) {
    return DeploymentRecord.build({
      id: 'dep-1',
      nickname: 'Test Server',
      customIpxeScript: false,
      startDate: new Date(),
      endDate: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      type: 'SELF_SERVICE',
      serverId: 'brokkr-server-1',
      baseLayerId: null,
      rescueLayerId: null,
      reservationId: 'res-1',
      scheduledInterruptionTime: null,
      isLocked: false,
      diskEncryptionEnabled: false,
      deployerId: 'user-1',
      customerId: 'customer-1',
      deploymentProjectId: 'project-1',
      ...overrides,
    });
  }

  describe('lock / unlock / toggleLock', () => {
    it('lock sets isLocked to true', () => {
      const record = buildRecord({ isLocked: false });
      record.lock();
      expect(record.data.isLocked).toBe(true);
      expect(record.isDirty).toBe(true);
    });

    it('unlock sets isLocked to false', () => {
      const record = buildRecord({ isLocked: true });
      record.unlock();
      expect(record.data.isLocked).toBe(false);
    });

    it('toggleLock flips the value', () => {
      const record = buildRecord({ isLocked: false });
      record.toggleLock();
      expect(record.data.isLocked).toBe(true);
      record.toggleLock();
      expect(record.data.isLocked).toBe(false);
    });
  });

  describe('rename', () => {
    it('sets the nickname field', () => {
      const record = buildRecord();
      record.rename('New Name');
      expect(record.data.nickname).toBe('New Name');
      expect(record.isDirty).toBe(true);
    });

    it('is chainable', () => {
      const record = buildRecord();
      const result = record.rename('New Name');
      expect(result).toBe(record);
    });
  });

  describe('endDeployment', () => {
    it('sets endDate to a Date value', () => {
      const record = buildRecord();
      expect(record.data.endDate).toBeNull();
      record.endDeployment();
      expect(record.data.endDate).toBeInstanceOf(Date);
    });
  });

  describe('setScheduledInterruptionTime', () => {
    it('sets time to now + warningMs', () => {
      const mockNow = 1609459200000;
      vi.spyOn(Date, 'now').mockImplementation(() => mockNow);

      const record = buildRecord();
      record.setScheduledInterruptionTime(3600000);
      expect(record.data.scheduledInterruptionTime).toEqual(new Date(mockNow + 3600000));

      vi.restoreAllMocks();
    });
  });

  describe('updateBaseLayer', () => {
    it('sets baseLayerId and clears rescue layer', () => {
      const record = buildRecord({ rescueLayerId: 'rescue-layer-1' });
      record.updateBaseLayer('new-layer-id');

      expect(record.data.baseLayerId).toBe('new-layer-id');
      expect(record.data.rescueLayerId).toBeNull();
    });
  });

  describe('updateCustomIpxeScript', () => {
    it('sets customIpxeScript to true for a URL', () => {
      const record = buildRecord({ customIpxeScript: false });
      record.updateCustomIpxeScript('https://example.com/ipxe');
      expect(record.data.customIpxeScript).toBe(true);
    });

    it('sets customIpxeScript to false for empty string', () => {
      const record = buildRecord({ customIpxeScript: true });
      record.updateCustomIpxeScript('');
      expect(record.data.customIpxeScript).toBe(false);
    });
  });

  describe('updateDiskEncryption', () => {
    it('sets diskEncryptionEnabled to true', () => {
      const record = buildRecord({ diskEncryptionEnabled: false });
      record.updateDiskEncryption(true);
      expect(record.data.diskEncryptionEnabled).toBe(true);
    });

    it('sets diskEncryptionEnabled to false', () => {
      const record = buildRecord({ diskEncryptionEnabled: true });
      record.updateDiskEncryption(false);
      expect(record.data.diskEncryptionEnabled).toBe(false);
    });
  });

  describe('scoped finders', () => {
    it('findActiveById auto-injects customerId from context', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await DeploymentRecord.findActiveById('dep-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'dep-1', endDate: null, customerId: 'customer-1' },
      });
    });

    it('findActiveByDeviceId filters by Server.deviceId via relational where + auto-injects customerId from context', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await DeploymentRecord.findActiveByDeviceId('brokkr-device-1');
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { endDate: null, server: { deviceId: 'brokkr-device-1' }, customerId: 'customer-1' },
      });
    });
  });

  describe('cross-tenant finders (unscoped)', () => {
    it('findOneUnscoped honors an explicit customerId verbatim (no injection)', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await DeploymentRecord.findOneUnscoped({
        where: { id: 'dep-1', endDate: null, customerId: 'other-customer' },
      });
      expect(mockDelegate.findFirst).toHaveBeenCalledWith({
        where: { id: 'dep-1', endDate: null, customerId: 'other-customer' },
      });
    });

    it('findAggregateUnscoped pre-bakes the include and bypasses tenant injection', async () => {
      mockDelegate.findFirst.mockResolvedValue(null);
      await DeploymentRecord.findAggregateUnscoped({
        where: { endDate: null, serverId: 'brokkr-server-1', customerId: 'other-customer' },
      });
      expect(mockDelegate.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { endDate: null, serverId: 'brokkr-server-1', customerId: 'other-customer' },
          include: expect.any(Object),
        }),
      );
    });
  });

  describe('updateSshKeys', () => {
    function persistedRow(overrides = {}) {
      return {
        id: 'dep-1',
        nickname: 'Test',
        customIpxeScript: false,
        startDate: new Date(),
        endDate: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        type: 'SELF_SERVICE',
        serverId: 'brokkr-server-1',
        baseLayerId: null,
        rescueLayerId: null,
        reservationId: 'res-1',
        scheduledInterruptionTime: null,
        isLocked: false,
        diskEncryptionEnabled: false,
        deployerId: 'user-1',
        customerId: 'customer-1',
        deploymentProjectId: 'project-1',
        ...overrides,
      };
    }

    it('calls update with deleteMany + createMany scoped by record customerId and endDate: null', async () => {
      mockDelegate.findFirst.mockResolvedValue(persistedRow());
      mockDelegate.update.mockResolvedValue({});

      const record = await DeploymentRecord.findActiveById('dep-1');
      await record.updateSshKeys(['key-a', 'key-b']);

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'dep-1', customerId: 'customer-1', endDate: null },
        data: {
          deploymentKeys: {
            deleteMany: { deploymentId: 'dep-1' },
            createMany: {
              data: expect.arrayContaining([
                expect.objectContaining({ sshKeyId: 'key-a' }),
                expect.objectContaining({ sshKeyId: 'key-b' }),
              ]),
            },
          },
        },
      });
    });

    it('uses the record customerId verbatim — does NOT inject from request context', async () => {
      mockDelegate.update.mockResolvedValue({});
      const record = DeploymentRecord.fromRow(persistedRow({ customerId: 'other-org' }));

      await record.updateSshKeys(['key-a']);

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep-1', customerId: 'other-org', endDate: null },
        }),
      );
    });

    it('includes endDate: null in the WHERE when the record was loaded as active', async () => {
      mockDelegate.update.mockResolvedValue({});
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: null }));

      await record.updateSshKeys(['key-a']);

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'dep-1', customerId: 'customer-1', endDate: null }),
        }),
      );
    });

    it('still guards on endDate: null after an in-memory endDeployment() mutation', async () => {
      mockDelegate.update.mockResolvedValue({});
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: null }));
      record.endDeployment();

      await record.updateSshKeys(['key-a']);

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ endDate: null }),
        }),
      );
    });

    it('omits the endDate guard when the record was loaded as already-ended', async () => {
      mockDelegate.update.mockResolvedValue({});
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: new Date('2025-01-01') }));

      await record.updateSshKeys(['key-a']);

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'dep-1', customerId: 'customer-1' },
        data: expect.any(Object),
      });
    });

    it('throws NotFoundException when Prisma returns P2025 (concurrent end)', async () => {
      mockDelegate.update.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Record to update not found', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: null }));

      await expect(record.updateSshKeys(['key-a'])).rejects.toThrow('Deployment not found');
    });
  });

  describe('createWithRelations', () => {
    it('uses data.customerId verbatim — does NOT inject from request context', async () => {
      mockDelegate.create.mockResolvedValue({ id: 'new-dep' });

      await DeploymentRecord.createWithRelations({
        nickname: 'Saga-created',
        customIpxeScript: false,
        sshKeyIds: ['key-a'],
        deviceId: 'brokkr-device-1',
        baseLayerId: 'layer-1',
        deployerId: 'user-1',
        customerId: 'other-org',
        type: 'SELF_SERVICE' as any,
        reservationId: 'res-1',
        projectId: 'project-1',
      });

      expect(mockDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            customer: { connect: { id: 'other-org' } },
            server: { connect: { deviceId: 'brokkr-device-1' } },
            baseLayer: { connect: { id: 'layer-1' } },
          }),
        }),
      );
      const createArg = mockDelegate.create.mock.calls[0][0];
      expect(createArg.data).not.toHaveProperty('selectedOperatingSystem');
    });
  });

  describe('endDeploymentIfNotLocked', () => {
    it('ends an unlocked deployment by setting endDate', () => {
      const record = buildRecord({ isLocked: false, endDate: null });
      record.endDeploymentIfNotLocked();
      expect(record.data.endDate).toBeInstanceOf(Date);
      expect(record.isDirty).toBe(true);
    });

    it('throws BadRequestException on a locked deployment', () => {
      const record = buildRecord({ isLocked: true, endDate: null });
      expect(() => record.endDeploymentIfNotLocked()).toThrow('Cannot end deployment: deployment is locked');
      expect(record.data.endDate).toBeNull();
    });

    it('is chainable', () => {
      const record = buildRecord({ isLocked: false });
      const result = record.endDeploymentIfNotLocked();
      expect(result).toBe(record);
    });
  });

  describe('setRescueLayer', () => {
    it('sets rescueLayerId when id provided', () => {
      const record = buildRecord({ rescueLayerId: null });
      record.setRescueLayer('rescue-layer-1');
      expect(record.data.rescueLayerId).toBe('rescue-layer-1');
      expect(record.isDirty).toBe(true);
    });

    it('clears rescueLayerId when null', () => {
      const record = buildRecord({ rescueLayerId: 'rescue-layer-1' });
      record.setRescueLayer(null);
      expect(record.data.rescueLayerId).toBeNull();
      expect(record.isDirty).toBe(true);
    });

    it('is chainable', () => {
      const record = buildRecord();
      const result = record.setRescueLayer('rescue-layer-1');
      expect(result).toBe(record);
    });
  });

  describe('_scopeWhere (active-only update guard)', () => {
    function persistedRow(overrides = {}) {
      return {
        id: 'dep-1',
        nickname: 'Test',
        customIpxeScript: false,
        startDate: new Date(),
        endDate: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        type: 'SELF_SERVICE',
        serverId: 'brokkr-server-1',
        baseLayerId: null,
        rescueLayerId: null,
        reservationId: 'res-1',
        scheduledInterruptionTime: null,
        isLocked: false,
        diskEncryptionEnabled: false,
        deployerId: 'user-1',
        customerId: 'customer-1',
        deploymentProjectId: 'project-1',
        ...overrides,
      };
    }

    it('save() on an active record includes endDate: null in the WHERE', async () => {
      mockDelegate.update.mockResolvedValue(persistedRow({ rescueLayerId: 'rescue-layer-1' }));
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: null }));
      record.setRescueLayer('rescue-layer-1');
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'dep-1', customerId: 'customer-1', endDate: null },
        data: { rescueLayerId: 'rescue-layer-1' },
      });
    });

    it('save() on the active→ended transition still WHEREs on endDate: null (atomic transition)', async () => {
      mockDelegate.update.mockResolvedValue(persistedRow({ endDate: new Date('2025-06-01') }));
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: null }));
      record.endDeployment();
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'dep-1', customerId: 'customer-1', endDate: null },
        }),
      );
    });

    it('save() on a record loaded as already-ended does NOT add endDate: null', async () => {
      mockDelegate.update.mockResolvedValue(
        persistedRow({ endDate: new Date('2025-01-01'), nickname: 'archived-name' }),
      );
      const record = DeploymentRecord.fromRow(persistedRow({ endDate: new Date('2025-01-01') }));
      record.rename('archived-name');
      await record.save();

      expect(mockDelegate.update).toHaveBeenCalledWith({
        where: { id: 'dep-1', customerId: 'customer-1' },
        data: { nickname: 'archived-name' },
      });
    });
  });
});
