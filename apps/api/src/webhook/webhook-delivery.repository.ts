import { Injectable } from '@nestjs/common';
import { DeliveryStatus, Prisma, WebhookEventType } from '@repo/database';
import { truncateString } from '@repo/utils';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class WebhookDeliveryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  public async create(webhookId: string, eventType: WebhookEventType, payload: any) {
    return this.prisma.webhookDelivery.create({
      data: {
        webhookId,
        eventType,
        payload,
        status: DeliveryStatus.PENDING,
      },
    });
  }

  public async update(deliveryId: string, data: Prisma.WebhookDeliveryUpdateInput) {
    return this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data,
    });
  }

  public async findById(deliveryId: string) {
    return this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true },
    });
  }

  public async findManyForOrganization(organizationId: string) {
    return this.prisma.webhookDelivery.findMany({
      where: {
        webhook: {
          organizationId,
          deletedAt: null,
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        webhook: {
          select: {
            endpoint: true,
            description: true,
          },
        },
      },
    });
  }

  public async getDeliveryDetails(deliveryId: string) {
    return this.prisma.webhookDelivery.findUnique({
      where: { id: deliveryId },
      include: {
        webhook: {
          select: {
            endpoint: true,
            description: true,
          },
        },
      },
    });
  }

  public async updateToSuccess(deliveryId: string, response: any) {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: DeliveryStatus.SUCCESS,
        httpStatus: response.status,
        responseBody: truncateString(JSON.stringify(response.data), 1000),
        deliveredAt: new Date(),
      },
    });
  }

  public async updateToFailed(deliveryId: string, errorMessage: string) {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { status: DeliveryStatus.FAILED, errorMessage },
    });
  }

  public async updateManyPendingOrRetryingToFailed(webhookId: string, errorMessage: string) {
    await this.prisma.webhookDelivery.updateMany({
      where: {
        webhookId,
        status: {
          in: [DeliveryStatus.PENDING, DeliveryStatus.RETRYING],
        },
      },
      data: { status: DeliveryStatus.FAILED, errorMessage },
    });
  }

  public async resetForImmediateRetry(deliveryId: string) {
    return this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        nextRetryAt: new Date(),
        status: DeliveryStatus.RETRYING,
        attempts: 0,
        httpStatus: null,
        responseBody: null,
        errorMessage: null,
      },
    });
  }

  public async incrementAttempts(deliveryId: string) {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: { attempts: { increment: 1 }, status: DeliveryStatus.PENDING },
    });
  }

  public async getLockedDeliveries(instanceId: string) {
    const now = new Date();
    const lockDurationMinutes = 5;
    const lockExpires = new Date(now.getTime() + lockDurationMinutes * 60 * 1000);

    return this.prisma.$transaction(async (tx) => {
      return tx.$queryRaw<{ id: string }[]>`
        UPDATE "WebhookDelivery"
        SET "processingLockedBy" = ${instanceId},
            "processingLockedAt" = ${now},
            "processingLockExpires" = ${lockExpires}
        WHERE id IN (
          SELECT id FROM "WebhookDelivery"
          WHERE status = 'RETRYING'::"DeliveryStatus"
          AND "nextRetryAt" <= ${now}
          AND (
            "processingLockedBy" IS NULL
            OR "processingLockExpires" < ${now}
          )
          LIMIT 100
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `;
    });
  }

  public async getRetriesToProcess(locked: { id: string }[]) {
    return this.prisma.webhookDelivery.findMany({
      where: {
        id: { in: locked.map((l) => l.id) },
      },
      include: { webhook: true },
    });
  }

  public async releaseLock(deliveryId: string) {
    await this.prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        processingLockedBy: null,
        processingLockedAt: null,
        processingLockExpires: null,
      },
    });
  }

  public async releaseLockBatch(deliveryIds: string[]) {
    if (deliveryIds.length === 0) return;

    await this.prisma.webhookDelivery.updateMany({
      where: { id: { in: deliveryIds } },
      data: {
        processingLockedBy: null,
        processingLockedAt: null,
        processingLockExpires: null,
      },
    });
  }

  public async cleanupOldDeliveries(daysToKeep: number) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    return this.prisma.webhookDelivery.deleteMany({
      where: {
        createdAt: { lt: cutoffDate },
        status: { in: [DeliveryStatus.SUCCESS, DeliveryStatus.FAILED] },
      },
    });
  }

  public async releaseExpiredLocks() {
    const now = new Date();
    return this.prisma.webhookDelivery.updateMany({
      where: {
        processingLockedBy: { not: null },
        processingLockExpires: { lt: now },
      },
      data: {
        processingLockedBy: null,
        processingLockedAt: null,
        processingLockExpires: null,
      },
    });
  }
}
