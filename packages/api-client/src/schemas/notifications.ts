import { z } from 'zod';

export const NotificationSchema = z.object({
  id: z.string().describe('Unique identifier for the notification'),
  userId: z.string().describe('ID of the recipient user'),
  organizationId: z
    .string()
    .nullable()
    .describe('Optional organization scope; null means the notification is not org-scoped'),
  type: z.string().describe('Stable event type string (e.g. provision.approval.requested)'),
  idempotencyKey: z.string().describe('Per-user dedupe key for this notification'),
  title: z.string().describe('Short notification title shown in the inbox'),
  body: z.string().describe('Notification body text'),
  href: z.string().nullable().describe('Optional in-app path to open when the notification is clicked'),
  readAt: z.coerce.date().nullable().describe('When the notification was marked read, or null if unread'),
  createdAt: z.coerce.date().describe('When the notification was created'),
});

export type Notification = z.infer<typeof NotificationSchema>;

export const ListNotificationsQuerySchema = z.object({
  organizationId: z
    .string()
    .optional()
    .describe('When set, return rows for this organization or with a null organizationId'),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe('Maximum number of notifications to return. Server default is 20; max 50.'),
});

export type ListNotificationsQuery = z.infer<typeof ListNotificationsQuerySchema>;

export const NotificationUnreadCountQuerySchema = z.object({
  organizationId: z
    .string()
    .optional()
    .describe('When set, count rows for this organization or with a null organizationId'),
});

export type NotificationUnreadCountQuery = z.infer<typeof NotificationUnreadCountQuerySchema>;

export const NotificationUnreadCountSchema = z.object({
  count: z.number().int().nonnegative().describe('Number of unread notifications for the current user'),
});

export type NotificationUnreadCount = z.infer<typeof NotificationUnreadCountSchema>;

export const NotificationIdParamsSchema = z.object({
  id: z.string().describe('Notification ID'),
});

export type NotificationIdParams = z.infer<typeof NotificationIdParamsSchema>;

export const MarkAllNotificationsReadQuerySchema = z.object({
  organizationId: z
    .string()
    .optional()
    .describe('When set, mark read only rows for this organization or with a null organizationId'),
});

export type MarkAllNotificationsReadQuery = z.infer<typeof MarkAllNotificationsReadQuerySchema>;

export const MarkAllNotificationsReadResponseSchema = z.object({
  count: z.number().int().nonnegative().describe('Number of notifications marked read'),
});

export type MarkAllNotificationsReadResponse = z.infer<typeof MarkAllNotificationsReadResponseSchema>;
