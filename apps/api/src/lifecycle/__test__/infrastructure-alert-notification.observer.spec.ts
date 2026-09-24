import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { Test } from '@nestjs/testing';
import { NotificationService } from 'src/notifications/notification.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InfrastructureAlertNotificationObserver } from '../observers/infrastructure-alert-notification.observer';

type Handler = (event: unknown) => void | Promise<void>;

describe('InfrastructureAlertNotificationObserver', () => {
  const handlers = new Map<string, Handler>();
  const eventBus = {
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn((event: string, h: Handler) => {
      handlers.set(event, h);
      return () => {};
    }),
  };
  const notifications = {
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const prisma = {
    user: { findUnique: vi.fn() },
    device: { findMany: vi.fn() },
    member: { findMany: vi.fn() },
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    handlers.clear();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InfrastructureAlertNotificationObserver,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: NotificationService, useValue: notifications },
        { provide: PrismaClient, useValue: prisma },
      ],
    }).compile();
    moduleRef.get(InfrastructureAlertNotificationObserver).onModuleInit();
  });

  it('publishes device.failed to the deployer resolved by email', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'deployer-1' });

    await handlers.get('device.failed')!({
      deviceId: 'device-1',
      deviceName: 'host-1',
      primaryIp: '10.0.0.1',
      deployment: {
        id: 'dep-1',
        customerOrganizationId: 'org-1',
        operatingSystemName: 'Ubuntu',
        deployer: { email: 'dep@x.com', firstName: 'A', lastName: 'B' },
      },
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'dep@x.com' },
      select: { id: true },
    });
    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'device.failed',
      idempotencyKey: 'device-failed:device-1:dep-1',
      userIds: ['deployer-1'],
      organizationId: 'org-1',
      title: 'Device failed',
      body: 'Device host-1 reported a failure while deployed.',
      href: '/deployments/dep-1',
      channels: { inApp: true, email: true },
    });
  });

  it('skips device.failed when there is no active deployment', async () => {
    await handlers.get('device.failed')!({
      deviceId: 'device-1',
      deviceName: 'host-1',
      primaryIp: null,
      deployment: null,
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('skips device.failed when the deployer email does not resolve to a user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await handlers.get('device.failed')!({
      deviceId: 'device-1',
      deviceName: 'host-1',
      primaryIp: null,
      deployment: {
        id: 'dep-1',
        customerOrganizationId: 'org-1',
        operatingSystemName: null,
        deployer: { email: 'missing@x.com', firstName: 'A', lastName: 'B' },
      },
    });

    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('publishes zone.alert to members of every supplier org with a device in the zone', async () => {
    prisma.device.findMany.mockResolvedValue([{ supplierId: 'sup-a' }, { supplierId: 'sup-b' }]);
    prisma.member.findMany.mockResolvedValue([
      { organizationId: 'sup-a', user: { id: 'u-a' } },
      { organizationId: 'sup-b', user: { id: 'u-b' } },
    ]);
    const lastHeartbeatAt = new Date('2030-01-01T00:00:00.000Z');

    await handlers.get('zone.alert')!({
      zoneId: 'zone-1',
      zoneName: 'iad-1',
      lastHeartbeatAt,
      timeSinceHeartbeatSeconds: 120,
      deviceCount: 10,
      activeRentalsCount: 3,
    });

    expect(prisma.device.findMany).toHaveBeenCalledWith({
      where: { zoneId: 'zone-1', deletedAt: null, supplierId: { not: null } },
      select: { supplierId: true },
      distinct: ['supplierId'],
    });
    expect(prisma.member.findMany).toHaveBeenCalledWith({
      where: { organizationId: { in: ['sup-a', 'sup-b'] }, deletedAt: null },
      select: { organizationId: true, user: { select: { id: true } } },
    });
    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'zone.alert',
      idempotencyKey: `zone-alert:zone-1:${lastHeartbeatAt.toISOString()}`,
      userIds: ['u-a', 'u-b'],
      organizationId: undefined,
      title: 'Zone offline',
      body: `Zone iad-1 is offline. Last heartbeat ${lastHeartbeatAt.toISOString()} (120s ago). 10 devices, 3 active rentals.`,
      href: '/dcim/zones/zone-1',
      channels: { inApp: true, email: true },
    });
  });

  it('does not notify members of orgs that have no device in the zone', async () => {
    prisma.device.findMany.mockResolvedValue([{ supplierId: 'sup-a' }]);
    prisma.member.findMany.mockResolvedValue([{ organizationId: 'sup-a', user: { id: 'u-a' } }]);

    await handlers.get('zone.alert')!({
      zoneId: 'zone-1',
      zoneName: 'iad-1',
      lastHeartbeatAt: new Date('2030-01-01T00:00:00.000Z'),
      timeSinceHeartbeatSeconds: 120,
      deviceCount: 1,
      activeRentalsCount: 0,
    });

    expect(prisma.member.findMany).toHaveBeenCalledWith({
      where: { organizationId: { in: ['sup-a'] }, deletedAt: null },
      select: { organizationId: true, user: { select: { id: true } } },
    });
    expect(notifications.publish).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['u-a'], organizationId: 'sup-a' }),
    );
  });

  it('does not add recipients from isInstanceOperator alone', async () => {
    prisma.device.findMany.mockResolvedValue([]);

    await handlers.get('zone.alert')!({
      zoneId: 'zone-1',
      zoneName: 'iad-1',
      lastHeartbeatAt: new Date(),
      timeSinceHeartbeatSeconds: 1,
      deviceCount: 0,
      activeRentalsCount: 0,
    });

    expect(prisma.member.findMany).not.toHaveBeenCalled();
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('publishes bridge.alert to the same zone supplier recipients', async () => {
    prisma.device.findMany.mockResolvedValue([{ supplierId: 'sup-a' }]);
    prisma.member.findMany.mockResolvedValue([{ organizationId: 'sup-a', user: { id: 'u-a' } }]);
    const lastSeenAt = new Date('2030-01-01T01:00:00.000Z');

    await handlers.get('bridge.alert')!({
      deviceId: 'bridge-device',
      instanceId: 'bridge-1',
      zoneId: 'zone-1',
      zoneName: 'iad-1',
      lastSeenAt,
      offlineSince: lastSeenAt,
      timeSinceLastSeenSeconds: 90,
      bridgeVersion: '1.0.0',
    });

    expect(prisma.device.findMany).toHaveBeenCalledWith({
      where: { zoneId: 'zone-1', deletedAt: null, supplierId: { not: null } },
      select: { supplierId: true },
      distinct: ['supplierId'],
    });
    expect(notifications.publish).toHaveBeenCalledWith({
      type: 'bridge.alert',
      idempotencyKey: `bridge-alert:bridge-device:${lastSeenAt.toISOString()}`,
      userIds: ['u-a'],
      organizationId: 'sup-a',
      title: 'Bridge offline',
      body: `Bridge bridge-1 in zone iad-1 is offline. Last seen ${lastSeenAt.toISOString()} (90s ago).`,
      href: '/dcim/zones/zone-1',
      channels: { inApp: true, email: true },
    });
  });

  it('skips bridge.alert when zoneId is missing', async () => {
    await handlers.get('bridge.alert')!({
      deviceId: 'bridge-device',
      instanceId: 'bridge-1',
      zoneId: '',
      zoneName: 'iad-1',
      lastSeenAt: new Date(),
      offlineSince: new Date(),
      timeSinceLastSeenSeconds: 90,
      bridgeVersion: null,
    });

    expect(prisma.device.findMany).not.toHaveBeenCalled();
    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('skips zone.alert when there are no supplier recipients', async () => {
    prisma.device.findMany.mockResolvedValue([{ supplierId: 'sup-a' }]);
    prisma.member.findMany.mockResolvedValue([]);

    await handlers.get('zone.alert')!({
      zoneId: 'zone-1',
      zoneName: 'iad-1',
      lastHeartbeatAt: new Date(),
      timeSinceHeartbeatSeconds: 1,
      deviceCount: 0,
      activeRentalsCount: 0,
    });

    expect(notifications.publish).not.toHaveBeenCalled();
  });

  it('reuses the same zone.alert idempotency key for the same timestamp', async () => {
    prisma.device.findMany.mockResolvedValue([{ supplierId: 'sup-a' }]);
    prisma.member.findMany.mockResolvedValue([{ organizationId: 'sup-a', user: { id: 'u-a' } }]);
    const lastHeartbeatAt = new Date('2030-01-01T00:00:00.000Z');
    const event = {
      zoneId: 'zone-1',
      zoneName: 'iad-1',
      lastHeartbeatAt,
      timeSinceHeartbeatSeconds: 120,
      deviceCount: 10,
      activeRentalsCount: 3,
    };

    await handlers.get('zone.alert')!(event);
    await handlers.get('zone.alert')!(event);

    expect(notifications.publish).toHaveBeenCalledTimes(2);
    expect(notifications.publish.mock.calls[0][0].idempotencyKey).toBe(
      `zone-alert:zone-1:${lastHeartbeatAt.toISOString()}`,
    );
    expect(notifications.publish.mock.calls[1][0].idempotencyKey).toBe(
      notifications.publish.mock.calls[0][0].idempotencyKey,
    );
  });
});
