import { PLUGIN_NOTIFICATIONS } from '@hydrahost/plugin-sdk';
import { Global, Module } from '@nestjs/common';

import { NotificationService } from '../notifications/notification.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Global()
@Module({
  imports: [NotificationsModule],
  providers: [{ provide: PLUGIN_NOTIFICATIONS, useExisting: NotificationService }],
  exports: [PLUGIN_NOTIFICATIONS],
})
export class PluginNotificationsModule {}
