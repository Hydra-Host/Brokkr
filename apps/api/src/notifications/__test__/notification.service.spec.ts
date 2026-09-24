import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import { Prisma } from '@repo/database';
import { AuthType } from 'src/auth/identity-context';
import { ContextService } from 'src/common/context/context.service';
import { EmailService } from 'src/email/email.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationService } from '../notification.service';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';

function knownRequestError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code,
    clientVersion: 'test',
  });
}

describe('NotificationService', () => {
  let service: NotificationService;

  const mockPrisma = {
    notification: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  };

  const mockContext = {
    identity: { authType: AuthType.Session },
    userId: USER_ID,
  };

  const mockEmail = {
    send: {
      inAppNotification: vi.fn().mockResolvedValue(undefined),
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockContext.identity = { authType: AuthType.Session };
    mockContext.userId = USER_ID;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationService,
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: ContextService, useValue: mockContext },
        { provide: EmailService, useValue: mockEmail },
      ],
    }).compile();

    service = module.get(NotificationService);
  });

  it('inserts an in-app row and sends email on publish', async () => {
    mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });

    await service.publish({
      type: 'provision.approval.requested',
      idempotencyKey: 'provision-approval-requested:job-1',
      userIds: [USER_ID],
      organizationId: 'org-1',
      title: 'Title',
      body: 'Body',
      href: '/plugins/operator-hub/provision-approvals',
      channels: { inApp: true, email: true },
    });

    expect(mockPrisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER_ID,
        idempotencyKey: 'provision-approval-requested:job-1',
        type: 'provision.approval.requested',
      }),
    });
    expect(mockEmail.send.inAppNotification).toHaveBeenCalledWith({
      email: 'user@example.com',
      title: 'Title',
      body: 'Body',
      href: '/plugins/operator-hub/provision-approvals',
    });
  });

  it('skips a second email when the idempotency key already exists', async () => {
    mockPrisma.notification.create.mockRejectedValue(knownRequestError('P2002'));

    await service.publish({
      type: 'provision.approval.requested',
      idempotencyKey: 'provision-approval-requested:job-1',
      userIds: [USER_ID],
      title: 'Title',
      body: 'Body',
      channels: { inApp: true, email: true },
    });

    expect(mockEmail.send.inAppNotification).not.toHaveBeenCalled();
  });

  it('rejects email-only publish without inApp', async () => {
    await expect(
      service.publish({
        type: 'provision.approval.requested',
        idempotencyKey: 'provision-approval-requested:job-1',
        userIds: [USER_ID],
        title: 'Title',
        body: 'Body',
        channels: { inApp: false, email: true },
      }),
    ).rejects.toThrow('email channel requires inApp: true for idempotency');
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockEmail.send.inAppNotification).not.toHaveBeenCalled();
  });

  it('does not throw when email sending fails', async () => {
    mockPrisma.notification.create.mockResolvedValue({ id: 'n1' });
    mockPrisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockEmail.send.inAppNotification.mockRejectedValue(new Error('smtp down'));

    await expect(
      service.publish({
        type: 'provision.approval.requested',
        idempotencyKey: 'provision-approval-requested:job-1',
        userIds: [USER_ID],
        title: 'Title',
        body: 'Body',
        channels: { inApp: true, email: true },
      }),
    ).resolves.toBeUndefined();
  });

  it('forbids API-key auth from listing notifications', async () => {
    mockContext.identity = { authType: AuthType.ApiKey };

    await expect(service.list({})).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.notification.findMany).not.toHaveBeenCalled();
  });

  it('lists notifications for the session user without an org filter', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n1' }]);

    const result = await service.list({});

    expect(result).toEqual([{ id: 'n1' }]);
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });

  it('lists notifications with org-scoped OR filter', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n1' }]);

    await service.list({ organizationId: 'org-1' });

    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        OR: [{ organizationId: 'org-1' }, { organizationId: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  });

  it('includes unscoped notifications when listing by organization', async () => {
    mockPrisma.notification.findMany.mockResolvedValue([{ id: 'n-unscoped', organizationId: null }]);

    const result = await service.list({ organizationId: 'org-B' });

    expect(result).toEqual([{ id: 'n-unscoped', organizationId: null }]);
    expect(mockPrisma.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: USER_ID,
          OR: [{ organizationId: 'org-B' }, { organizationId: null }],
        },
      }),
    );
  });

  it('returns unread count for the session user', async () => {
    mockPrisma.notification.count.mockResolvedValue(3);

    const result = await service.unreadCount({});

    expect(result).toEqual({ count: 3 });
    expect(mockPrisma.notification.count).toHaveBeenCalledWith({
      where: { userId: USER_ID, readAt: null },
    });
  });

  it('returns unread count with org-scoped OR filter', async () => {
    mockPrisma.notification.count.mockResolvedValue(2);

    await service.unreadCount({ organizationId: 'org-1' });

    expect(mockPrisma.notification.count).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        OR: [{ organizationId: 'org-1' }, { organizationId: null }],
        readAt: null,
      },
    });
  });

  it('forbids API-key auth from unread count', async () => {
    mockContext.identity = { authType: AuthType.ApiKey };

    await expect(service.unreadCount({})).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.notification.count).not.toHaveBeenCalled();
  });

  it('marks all unread notifications read for the session user', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 4 });

    const result = await service.markAllRead({});

    expect(result).toEqual({ count: 4 });
    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: { userId: USER_ID, readAt: null },
      data: { readAt: expect.any(Date) },
    });
  });

  it('marks all read with org-scoped OR filter', async () => {
    mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

    await service.markAllRead({ organizationId: 'org-1' });

    expect(mockPrisma.notification.updateMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        OR: [{ organizationId: 'org-1' }, { organizationId: null }],
        readAt: null,
      },
      data: { readAt: expect.any(Date) },
    });
  });

  it('forbids API-key auth from marking all read', async () => {
    mockContext.identity = { authType: AuthType.ApiKey };

    await expect(service.markAllRead({})).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockPrisma.notification.updateMany).not.toHaveBeenCalled();
  });

  it('returns 404 when marking another user notification read', async () => {
    mockPrisma.notification.findUnique.mockResolvedValue({
      id: 'n1',
      userId: OTHER_USER_ID,
      readAt: null,
    });

    await expect(service.markRead('n1')).rejects.toBeInstanceOf(NotFoundException);
    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
  });

  it('returns existing row when marking an already-read notification', async () => {
    const existing = { id: 'n1', userId: USER_ID, readAt: new Date('2024-01-01T00:00:00.000Z') };
    mockPrisma.notification.findUnique.mockResolvedValue(existing);

    const result = await service.markRead('n1');

    expect(result).toBe(existing);
    expect(mockPrisma.notification.update).not.toHaveBeenCalled();
  });

  it('marks an unread notification as read', async () => {
    const existing = { id: 'n1', userId: USER_ID, readAt: null };
    const updated = { ...existing, readAt: new Date('2024-06-01T00:00:00.000Z') };
    mockPrisma.notification.findUnique.mockResolvedValue(existing);
    mockPrisma.notification.update.mockResolvedValue(updated);

    const result = await service.markRead('n1');

    expect(result).toEqual(updated);
    expect(mockPrisma.notification.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { readAt: expect.any(Date) },
    });
  });
});
