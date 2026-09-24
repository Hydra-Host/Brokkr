import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { NotificationService } from './notification.service';

@Controller()
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @TsRestHandler(contract.listNotifications)
  listNotifications() {
    return tsRestHandler(contract.listNotifications, async ({ query }) => {
      const body = await this.notifications.list(query);
      return { status: 200 as const, body };
    });
  }

  @TsRestHandler(contract.getNotificationUnreadCount)
  getNotificationUnreadCount() {
    return tsRestHandler(contract.getNotificationUnreadCount, async ({ query }) => {
      const body = await this.notifications.unreadCount(query);
      return { status: 200 as const, body };
    });
  }

  @TsRestHandler(contract.markNotificationRead)
  markNotificationRead() {
    return tsRestHandler(contract.markNotificationRead, async ({ params }) => {
      const body = await this.notifications.markRead(params.id);
      return { status: 200 as const, body };
    });
  }

  @TsRestHandler(contract.markAllNotificationsRead)
  markAllNotificationsRead() {
    return tsRestHandler(contract.markAllNotificationsRead, async ({ query }) => {
      const body = await this.notifications.markAllRead(query);
      return { status: 200 as const, body };
    });
  }
}
