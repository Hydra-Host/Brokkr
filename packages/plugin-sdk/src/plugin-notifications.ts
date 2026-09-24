export const PLUGIN_NOTIFICATIONS = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_NOTIFICATIONS');

export interface PluginNotificationChannels {
  inApp: boolean;
  email: boolean;
}

export interface PluginNotificationPublishInput {
  type: string;
  idempotencyKey: string;
  userIds: string[];
  organizationId?: string;
  title: string;
  body: string;
  href?: string;
  channels: PluginNotificationChannels;
}

export interface PluginNotifications {
  publish(input: PluginNotificationPublishInput): Promise<void>;
}
