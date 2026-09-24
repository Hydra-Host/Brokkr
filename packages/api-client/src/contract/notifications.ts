import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import {
  ListNotificationsQuerySchema,
  MarkAllNotificationsReadQuerySchema,
  MarkAllNotificationsReadResponseSchema,
  NotificationIdParamsSchema,
  NotificationSchema,
  NotificationUnreadCountQuerySchema,
  NotificationUnreadCountSchema,
} from '../schemas/notifications';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const notificationsRoutes = c.router({
  listNotifications: {
    method: 'GET',
    path: '/notifications',
    query: ListNotificationsQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.array(NotificationSchema),
    },
    summary: 'List in-app notifications',
    description:
      'Returns the newest notifications for the authenticated session user. Optional organizationId includes org-scoped rows for that org plus unscoped rows. Session auth only.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getNotificationUnreadCount: {
    method: 'GET',
    path: '/notifications/unread-count',
    query: NotificationUnreadCountQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: NotificationUnreadCountSchema,
    },
    summary: 'Get unread notification count',
    description:
      'Returns how many unread notifications the authenticated session user has, with the same optional organization filter as the list endpoint. Session auth only.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  markNotificationRead: {
    method: 'POST',
    path: '/notifications/:id/read',
    pathParams: NotificationIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: NotificationSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Mark a notification as read',
    description:
      'Marks one notification as read for the authenticated session user. Returns 404 if the notification does not belong to the caller. Session auth only.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  markAllNotificationsRead: {
    method: 'POST',
    path: '/notifications/read-all',
    query: MarkAllNotificationsReadQuerySchema,
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: MarkAllNotificationsReadResponseSchema,
    },
    summary: 'Mark all notifications as read',
    description:
      'Marks all matching unread notifications as read for the authenticated session user, using the same optional organization filter as the list endpoint. Session auth only.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
