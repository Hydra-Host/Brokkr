import { describe, expect, it } from 'vitest';
import { ListNotificationsQuerySchema, NotificationSchema } from '../notifications';

const BASE = {
  id: 'notif-1',
  userId: 'user-1',
  organizationId: null,
  type: 'provision.approval.requested',
  idempotencyKey: 'key-1',
  title: 'Approval needed',
  body: 'Please review',
  href: null,
  readAt: null,
  createdAt: '2024-01-01T00:00:00.000Z',
};

describe('NotificationSchema', () => {
  it('coerces ISO strings to Dates', () => {
    const result = NotificationSchema.parse(BASE);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it('accepts a null readAt', () => {
    expect(NotificationSchema.parse(BASE).readAt).toBeNull();
  });

  it('coerces a non-null readAt string', () => {
    const result = NotificationSchema.parse({ ...BASE, readAt: '2024-06-01T00:00:00.000Z' });
    expect(result.readAt).toBeInstanceOf(Date);
  });
});

describe('ListNotificationsQuerySchema — limit', () => {
  it('accepts a valid limit', () => {
    expect(ListNotificationsQuerySchema.parse({ limit: '20' }).limit).toBe(20);
  });

  it('rejects limit = 0', () => {
    expect(ListNotificationsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
  });

  it('rejects limit > 50', () => {
    expect(ListNotificationsQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
  });

  it('allows limit to be omitted', () => {
    expect(ListNotificationsQuerySchema.safeParse({}).success).toBe(true);
  });
});
