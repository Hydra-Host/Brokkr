import { Injectable } from '@nestjs/common';
import { Prisma } from '@repo/database';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class WebhookRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async create(organizationId: string, createWebhook: Partial<Prisma.WebhookCreateInput>) {
    return this.prisma.webhook.create({
      data: {
        endpoint: createWebhook.endpoint,
        description: createWebhook.description,
        events: createWebhook.events,
        isActive: createWebhook.isActive,
        secret: createWebhook.secret,
        organization: {
          connect: {
            id: organizationId,
          },
        },
      },
    });
  }

  public async update(webhookId: string, updateWebhook: Partial<Prisma.WebhookUpdateInput>) {
    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: updateWebhook,
    });
  }

  public async findById(webhookId: string) {
    return this.prisma.webhook.findUnique({
      where: { id: webhookId },
    });
  }

  public async findFirst(where: Prisma.WebhookWhereInput) {
    return this.prisma.webhook.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  public async findMany(where: Prisma.WebhookWhereInput) {
    return this.prisma.webhook.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
  }

  public async reactivateWebhook(webhookId: string) {
    return this.prisma.webhook.update({
      where: { id: webhookId },
      data: {
        isActive: true,
        failureCount: 0,
        lastFailureAt: null,
      },
    });
  }

  public async getWebhookStats(organizationId: string) {
    const [total, active, failed, recentDeliveries] = await Promise.all([
      this.prisma.webhook.count({
        where: {
          organizationId,
          deletedAt: null,
        },
      }),
      this.prisma.webhook.count({
        where: {
          organizationId,
          isActive: true,
          deletedAt: null,
        },
      }),
      this.prisma.webhook.count({
        where: {
          organizationId,
          failureCount: { gt: 0 },
          isActive: true,
          deletedAt: null,
        },
      }),
      this.prisma.webhookDelivery.findMany({
        where: {
          webhook: {
            organizationId,
            deletedAt: null,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
        include: {
          webhook: {
            select: {
              endpoint: true,
              description: true,
            },
          },
        },
      }),
    ]);

    return { total, active, failed, recentDeliveries };
  }
}
