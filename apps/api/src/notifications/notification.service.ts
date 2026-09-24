import type { PluginNotificationPublishInput } from '@hydrahost/plugin-sdk';
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type {
  ListNotificationsQuery,
  MarkAllNotificationsReadQuery,
  MarkAllNotificationsReadResponse,
  Notification,
  NotificationUnreadCount,
  NotificationUnreadCountQuery,
} from '@repo/api-client';
import { Prisma } from '@repo/database';
import { AuthType } from 'src/auth/identity-context';
import { ContextService } from 'src/common/context/context.service';
import { getErrorMessage } from 'src/common/error-utils';
import { EmailService } from 'src/email/email.service';
import { PrismaClient } from 'src/prisma/prisma.client';

const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly prisma: PrismaClient,
    private readonly contextService: ContextService,
    private readonly email: EmailService,
  ) {}

  async publish(input: PluginNotificationPublishInput): Promise<void> {
    const userIds = [...new Set(input.userIds.filter(Boolean))];
    if (userIds.length === 0) return;
    if (!input.channels.inApp && !input.channels.email) return;
    if (!input.channels.inApp && input.channels.email) {
      throw new Error('email channel requires inApp: true for idempotency');
    }

    for (const userId of userIds) {
      const created = await this.tryCreateInApp(userId, input);
      if (created && input.channels.email) {
        await this.sendEmailBestEffort(userId, input);
      }
    }
  }

  async list(query: ListNotificationsQuery): Promise<Notification[]> {
    const userId = this.requireSessionUserId();
    const limit = Math.min(query.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    return this.prisma.notification.findMany({
      where: this.scopedWhere(userId, query.organizationId),
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async unreadCount(query: NotificationUnreadCountQuery): Promise<NotificationUnreadCount> {
    const userId = this.requireSessionUserId();
    const count = await this.prisma.notification.count({
      where: {
        ...this.scopedWhere(userId, query.organizationId),
        readAt: null,
      },
    });
    return { count };
  }

  async markRead(id: string): Promise<Notification> {
    const userId = this.requireSessionUserId();
    const existing = await this.prisma.notification.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException('Notification not found');
    }
    if (existing.readAt) return existing;
    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(query: MarkAllNotificationsReadQuery): Promise<MarkAllNotificationsReadResponse> {
    const userId = this.requireSessionUserId();
    const result = await this.prisma.notification.updateMany({
      where: {
        ...this.scopedWhere(userId, query.organizationId),
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    return { count: result.count };
  }

  private scopedWhere(userId: string, organizationId: string | undefined) {
    if (!organizationId) {
      return { userId };
    }
    return {
      userId,
      OR: [{ organizationId }, { organizationId: null }],
    };
  }

  private requireSessionUserId(): string {
    const identity = this.contextService.identity;
    if (identity === undefined || identity.authType === AuthType.ApiKey) {
      throw new ForbiddenException('Notifications require an interactive session');
    }
    return this.contextService.userId;
  }

  private async tryCreateInApp(userId: string, input: PluginNotificationPublishInput): Promise<boolean> {
    try {
      await this.prisma.notification.create({
        data: {
          userId,
          organizationId: input.organizationId,
          type: input.type,
          idempotencyKey: input.idempotencyKey,
          title: input.title,
          body: input.body,
          href: input.href,
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return false;
      }
      throw error;
    }
  }

  private async sendEmailBestEffort(userId: string, input: PluginNotificationPublishInput): Promise<void> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true },
      });
      if (!user?.email) return;
      await this.email.send.inAppNotification({
        email: user.email,
        title: input.title,
        body: input.body,
        href: input.href,
      });
    } catch (error) {
      this.logger.warn(`Failed to send notification email: ${getErrorMessage(error)}`);
    }
  }
}
