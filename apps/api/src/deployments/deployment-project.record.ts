import { BadRequestException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { z } from 'zod';
import { deploymentAggregateInclude } from './types/deployments.types';

const DeploymentProjectPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  isDefault: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date().nullable(),
  deletedAt: z.date().nullable(),
});

const deploymentProjectAggregateInclude = {
  deployments: {
    where: { endDate: null },
    include: deploymentAggregateInclude(),
  },
} satisfies Prisma.DeploymentProjectInclude;

export type DeploymentProjectAggregate = Prisma.DeploymentProjectGetPayload<{
  include: typeof deploymentProjectAggregateInclude;
}>;

export class DeploymentProjectRecord extends createActiveRecord(
  DeploymentProjectPersistenceSchema,
  'deploymentProject',
  { tenantField: 'organizationId', actions: { read: 'deployment-project:read' } },
) {
  static findActiveById(id: string): Promise<DeploymentProjectRecord | null> {
    this.requireAction('read');
    return this.findOne({ where: { id, deletedAt: null } });
  }

  static async findActiveAggregateById(id: string): Promise<DeploymentProjectAggregate | null> {
    this.requireAction('read');
    const delegate = this._delegate();
    return delegate.findUnique({
      where: { id, deletedAt: null },
      include: deploymentProjectAggregateInclude,
    }) as Promise<DeploymentProjectAggregate | null>;
  }

  static async findActiveAggregates(): Promise<DeploymentProjectAggregate[]> {
    this.requireAction('read');
    const delegate = this._delegate();
    return delegate.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: deploymentProjectAggregateInclude,
    }) as Promise<DeploymentProjectAggregate[]>;
  }

  static async findActiveDefault(): Promise<DeploymentProjectAggregate | null> {
    this.requireAction('read');
    const delegate = this._delegate();
    return delegate.findFirst({
      where: { isDefault: true, deletedAt: null },
      include: deploymentProjectAggregateInclude,
    }) as Promise<DeploymentProjectAggregate | null>;
  }

  static async findActiveDefaultUnscoped(organizationId: string): Promise<DeploymentProjectAggregate | null> {
    const delegate = this._unscopedDelegate();
    return delegate.findFirst({
      where: { organizationId, isDefault: true, deletedAt: null },
      include: deploymentProjectAggregateInclude,
    }) as Promise<DeploymentProjectAggregate | null>;
  }

  static async findActiveByIdUnscoped(id: string, organizationId: string): Promise<{ id: string } | null> {
    const delegate = this._unscopedDelegate();
    return delegate.findUnique({
      where: { id, organizationId, deletedAt: null },
      select: { id: true },
    }) as Promise<{ id: string } | null>;
  }

  static async createWithRelations(data: {
    name: string;
    organizationId: string;
    isDefault?: boolean;
  }): Promise<DeploymentProjectAggregate> {
    const delegate = this._unscopedDelegate();
    return delegate.create({
      data: {
        name: data.name,
        isDefault: data.isDefault ?? false,
        organization: { connect: { id: data.organizationId } },
      },
      include: deploymentProjectAggregateInclude,
    }) as Promise<DeploymentProjectAggregate>;
  }

  static async createForCaller(data: { name: string; isDefault?: boolean }): Promise<DeploymentProjectAggregate> {
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    return this.createWithRelations({ ...data, organizationId: ctx.organizationId });
  }

  static async findOrCreateBrokkrAdminTest(organizationId: string) {
    const client = ActiveRecordRegistry.client;
    return client.$transaction(async (tx) => {
      const existing = await tx.deploymentProject.findFirst({
        where: { organizationId, name: 'Brokkr Admin Test', deletedAt: null },
      });
      if (existing) {
        return existing;
      }
      return tx.deploymentProject.create({
        data: { name: 'Brokkr Admin Test', organizationId },
      });
    });
  }

  static async moveDeployments(args: {
    sourceProjectId: string;
    targetProjectId: string;
    deploymentIds: string[];
  }): Promise<DeploymentProjectAggregate[]> {
    const client = ActiveRecordRegistry.client;
    const deployments = await client.deployment.findMany({
      where: { id: { in: args.deploymentIds }, endDate: null },
      include: { deploymentProject: true },
    });

    if (deployments.some((deployment) => deployment.deploymentProject?.id !== args.sourceProjectId)) {
      throw new BadRequestException('Deployments do not belong to the source project');
    }

    const updates = (await client.$transaction([
      client.deploymentProject.update({
        where: { id: args.sourceProjectId },
        data: { deployments: { disconnect: deployments.map((d) => ({ id: d.id })) } },
        include: deploymentProjectAggregateInclude,
      }),
      client.deploymentProject.update({
        where: { id: args.targetProjectId },
        data: { deployments: { connect: deployments.map((d) => ({ id: d.id })) } },
        include: deploymentProjectAggregateInclude,
      }),
    ])) as unknown as DeploymentProjectAggregate[];

    return updates;
  }

  rename(name: string): this {
    return this.set({ name: name.trim() });
  }

  setAsDefault(): this {
    return this.set({ isDefault: true });
  }

  unsetDefault(): this {
    return this.set({ isDefault: false });
  }

  softDelete(): this {
    return this.set({ deletedAt: new Date() });
  }

  async addDeployment(deploymentId: string): Promise<DeploymentProjectAggregate> {
    const delegate = DeploymentProjectRecord._unscopedDelegate();
    const result = await delegate.update({
      where: { id: this.data.id, organizationId: this.data.organizationId },
      data: { deployments: { connect: [{ id: deploymentId }] } },
      include: deploymentProjectAggregateInclude,
    });
    return result as DeploymentProjectAggregate;
  }
}
