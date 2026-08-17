import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { DeploymentLifecycleActionType, DeploymentType, Prisma, RequestSource } from '@repo/database';
import { z } from 'zod';
import {
  DeploymentAggregate,
  deploymentAggregateInclude,
  deploymentListAggregateInclude,
} from './types/deployments.types';

const DeploymentPersistenceSchema = z.object({
  id: z.string(),
  nickname: z.string(),
  customIpxeScript: z.boolean(),
  startDate: z.date(),
  endDate: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date().nullable(),
  type: z.string(),
  serverId: z.string(),
  reservationId: z.string().nullable(),
  scheduledInterruptionTime: z.date().nullable(),
  isLocked: z.boolean(),
  diskEncryptionEnabled: z.boolean(),
  deployerId: z.string(),
  customerId: z.string(),
  baseLayerId: z.string().nullable(),
  rescueLayerId: z.string().nullable(),
  deploymentProjectId: z.string().nullable(),
});

// Shared with the admin app, which has no context provider — admin code MUST use the *Unscoped helpers with an explicit customerId.
export class DeploymentRecord extends createActiveRecord(DeploymentPersistenceSchema, 'deployment', {
  tenantField: 'customerId',
  actions: { read: 'deployment:read' },
}) {
  _scopeWhere(): Record<string, unknown> {
    const where = super._scopeWhere();
    const loadedEndDate = 'endDate' in this._changes ? this._changes.endDate!.from : this._data.endDate;
    if (loadedEndDate === null) {
      where.endDate = null;
    }
    return where;
  }

  static findActiveById(id: string): Promise<DeploymentRecord | null> {
    this.requireAction('read');
    return this.findOne({ where: { id, endDate: null } });
  }

  static async findActiveByDeviceId(deviceId: string): Promise<DeploymentRecord | null> {
    this.requireAction('read');
    return this.findOne({ where: { endDate: null, server: { deviceId } } });
  }

  static async findActiveAggregateById(id: string): Promise<DeploymentAggregate | null> {
    this.requireAction('read');
    const delegate = this._delegate();
    return delegate.findUnique({
      where: { id, endDate: null },
      include: deploymentAggregateInclude(),
    }) as Promise<DeploymentAggregate | null>;
  }

  static async findActiveAggregatesForCaller(): Promise<DeploymentAggregate[]> {
    this.requireAction('read');
    const delegate = this._delegate();
    return delegate.findMany({
      where: { endDate: null },
      include: deploymentListAggregateInclude(),
    }) as Promise<DeploymentAggregate[]>;
  }

  static async findAggregateByDeviceId(deviceId: string): Promise<DeploymentAggregate | null> {
    this.requireAction('read');
    const delegate = this._delegate();
    return delegate.findFirst({
      where: { endDate: null, server: { deviceId } },
      orderBy: { createdAt: 'desc' },
      include: deploymentAggregateInclude(),
    }) as Promise<DeploymentAggregate | null>;
  }

  static async findAggregateUnscoped(args: {
    where: Prisma.DeploymentWhereInput;
    orderBy?: Prisma.DeploymentOrderByWithRelationInput;
  }): Promise<DeploymentAggregate | null> {
    const delegate = this._unscopedDelegate();
    return delegate.findFirst({
      ...args,
      include: deploymentAggregateInclude(),
    }) as Promise<DeploymentAggregate | null>;
  }

  static async createWithRelations(data: {
    nickname: string;
    customIpxeScript: boolean;
    sshKeyIds: string[];
    deviceId: string;
    baseLayerId: string;
    deployerId: string;
    customerId: string;
    type: DeploymentType;
    reservationId?: string;
    projectId: string;
    diskEncryptionEnabled?: boolean;
    isInterruptible?: boolean;
    interruptibleNoticePeriod?: number | null;
  }): Promise<DeploymentAggregate> {
    const delegate = this._unscopedDelegate();
    return delegate.create({
      data: {
        nickname: data.nickname,
        customIpxeScript: data.customIpxeScript,
        startDate: new Date(),
        type: data.type,
        diskEncryptionEnabled: data.diskEncryptionEnabled ?? false,
        isInterruptible: data.isInterruptible ?? false,
        interruptibleNoticePeriod: data.interruptibleNoticePeriod ?? null,
        deploymentKeys: {
          createMany: {
            data: data.sshKeyIds.map((id) => ({ sshKeyId: id })),
          },
        },
        baseLayer: { connect: { id: data.baseLayerId } },
        deployer: { connect: { id: data.deployerId } },
        customer: { connect: { id: data.customerId } },
        server: { connect: { deviceId: data.deviceId } },
        ...(data.reservationId ? { reservation: { connect: { id: data.reservationId } } } : {}),
        deploymentProject: { connect: { id: data.projectId } },
      },
      include: deploymentAggregateInclude(),
    }) as Promise<DeploymentAggregate>;
  }

  static async createLifecycleAction(data: {
    deploymentId: string;
    actionType: DeploymentLifecycleActionType;
    source: RequestSource;
    performedBy: string;
  }) {
    const client = ActiveRecordRegistry.client;
    return client.deploymentLifecycleAction.create({ data });
  }

  async updateSshKeys(sshKeyIds: string[]): Promise<void> {
    const delegate = DeploymentRecord._unscopedDelegate();
    const loadedEndDate = 'endDate' in this._changes ? this._changes.endDate!.from : this._data.endDate;
    const activeGuard = loadedEndDate === null ? { endDate: null } : {};
    try {
      await delegate.update({
        where: { id: this.data.id, customerId: this.data.customerId, ...activeGuard },
        data: {
          deploymentKeys: {
            deleteMany: { deploymentId: this.data.id },
            createMany: {
              data: sshKeyIds.map((sshKeyId) => ({
                id: crypto.randomUUID(),
                sshKeyId,
              })),
            },
          },
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new NotFoundException('Deployment not found');
      }
      throw error;
    }
  }

  lock(): this {
    return this.set({ isLocked: true });
  }

  unlock(): this {
    return this.set({ isLocked: false });
  }

  toggleLock(): this {
    return this.set({ isLocked: !this.data.isLocked });
  }

  rename(nickname: string): this {
    return this.set({ nickname });
  }

  endDeployment(): this {
    return this.set({ endDate: new Date() });
  }

  endDeploymentIfNotLocked(): this {
    if (this.data.isLocked) {
      throw new BadRequestException('Cannot end deployment: deployment is locked');
    }
    return this.endDeployment();
  }

  setScheduledInterruptionTime(warningMs: number): this {
    return this.set({ scheduledInterruptionTime: new Date(Date.now() + warningMs) });
  }

  clearScheduledInterruptionTime(): this {
    return this.set({ scheduledInterruptionTime: null });
  }

  static async clearScheduledInterruption(deploymentId: string, customerId: string): Promise<void> {
    const record: DeploymentRecord | null = await DeploymentRecord.findOneUnscoped({
      where: { id: deploymentId, customerId, endDate: null },
    });
    if (!record) return;
    record.clearScheduledInterruptionTime();
    await record.save();
  }

  updateBaseLayer(baseLayerId: string): this {
    return this.set({ baseLayerId, rescueLayerId: null });
  }

  setRescueLayer(rescueLayerId: string | null): this {
    return this.set({ rescueLayerId });
  }

  updateCustomIpxeScript(ipxeUrl: string): this {
    return this.set({ customIpxeScript: !!ipxeUrl });
  }

  updateDiskEncryption(enabled: boolean): this {
    return this.set({ diskEncryptionEnabled: enabled });
  }
}
