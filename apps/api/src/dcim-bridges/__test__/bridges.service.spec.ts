import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ContextService } from 'src/common/context/context.service';
import { REDIS_CLIENT } from 'src/common/redis';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgesService } from '../bridges.service';

describe('BridgesService', () => {
  let service: BridgesService;

  let mockContextService: {
    requireIdentity: { organization: { id: string } };
  };

  let mockPrismaClient: {
    device: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn> };
    $queryRaw: ReturnType<typeof vi.fn>;
  };

  let mockRedis: { hgetall: ReturnType<typeof vi.fn> };

  let mockLogger: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn>; log: ReturnType<typeof vi.fn> };

  const mockBridgeDevice = (overrides: Record<string, any> = {}) => ({
    id: 'device-uuid-1',
    name: 'Bridge-01',
    status: 'ACTIVE',
    zoneId: 'zone-uuid-a',
    zone: { name: 'Zone A' },
    interfaces: [
      {
        name: 'eth0',
        type: null,
        macAddress: 'AA:BB:CC:DD:EE:FF',
        mgmtOnly: false,
        enabled: true,
        markConnected: true,
        ipAddresses: [{ id: 'ip-uuid-1', address: '10.0.0.1/24' }],
      },
    ],
    ...overrides,
  });

  beforeEach(async () => {
    mockContextService = {
      requireIdentity: { organization: { id: 'org-1' } },
    };

    mockPrismaClient = {
      device: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
      $queryRaw: vi.fn().mockResolvedValue([]),
    };

    mockRedis = { hgetall: vi.fn().mockResolvedValue({}) };

    mockLogger = { warn: vi.fn(), error: vi.fn(), log: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgesService,
        { provide: ContextService, useValue: mockContextService },
        { provide: PrismaClient, useValue: mockPrismaClient },
        { provide: REDIS_CLIENT, useValue: mockRedis },
        { provide: 'LoggerServiceBridgesService', useValue: mockLogger },
      ],
    }).compile();

    service = module.get<BridgesService>(BridgesService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getBridgesPaginated', () => {
    it('maps the page, scoped to the org, and loads nested interfaces/IPs only for the returned page', async () => {
      mockPrismaClient.device.findMany
        .mockResolvedValueOnce([{ id: 'device-uuid-1', name: 'Bridge-01', status: 'ACTIVE', zone: { name: 'Zone A' } }])
        .mockResolvedValueOnce([mockBridgeDevice()]);

      const result = await service.getBridgesPaginated({ page: 1, pageSize: 20 });

      expect(result.meta).toEqual({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
      expect(result.data).toEqual([
        {
          id: 'device-uuid-1',
          name: 'Bridge-01',
          status: 'active',
          type: 'managed',
          datacenter: { id: 'zone-uuid-a', name: 'Zone A' },
          zone: { id: 'zone-uuid-a', name: 'Zone A' },
          interfaces: [
            {
              name: 'eth0',
              type: null,
              mac_address: 'AA:BB:CC:DD:EE:FF',
              ip_addresses: [{ id: 'ip-uuid-1', address: '10.0.0.1/24' }],
              mark_connected: true,
              enabled: true,
              mgmt_only: false,
            },
          ],
          online: false,
          is_leader: false,
          active_plugins: [],
        },
      ]);

      expect(mockPrismaClient.device.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({ role: 'Bridge', organizationId: 'org-1' }),
          select: expect.objectContaining({ id: true }),
        }),
      );
      const summaryArgs = mockPrismaClient.device.findMany.mock.calls[0][0];
      expect(summaryArgs.include).toBeUndefined();

      expect(mockPrismaClient.device.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({ id: { in: ['device-uuid-1'] }, role: 'Bridge', organizationId: 'org-1' }),
          include: expect.objectContaining({ interfaces: expect.anything() }),
        }),
      );
    });

    it('only fetches nested data for the requested page, not every bridge', async () => {
      const summaries = Array.from({ length: 25 }, (_, i) => ({
        id: `device-uuid-${i}`,
        name: `Bridge-${String(i).padStart(2, '0')}`,
        status: 'ACTIVE',
        zone: { name: 'Zone A' },
      }));
      const pageDevices = Array.from({ length: 5 }, (_, i) =>
        mockBridgeDevice({ id: `device-uuid-${20 + i}`, name: `Bridge-${20 + i}` }),
      );
      mockPrismaClient.device.findMany.mockResolvedValueOnce(summaries).mockResolvedValueOnce(pageDevices);

      const result = await service.getBridgesPaginated({ page: 2, pageSize: 20 });

      expect(result.meta).toEqual({ page: 2, pageSize: 20, totalItems: 25, totalPages: 2 });
      expect(result.data).toHaveLength(5);
      const nestedArgs = mockPrismaClient.device.findMany.mock.calls[1][0];
      expect(nestedArgs.where.id.in).toHaveLength(5);
      expect(nestedArgs.where.id.in).toEqual([
        'device-uuid-20',
        'device-uuid-21',
        'device-uuid-22',
        'device-uuid-23',
        'device-uuid-24',
      ]);
    });

    it('restricts the summary scan to a zone when zoneId is passed', async () => {
      mockPrismaClient.device.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await service.getBridgesPaginated({ page: 1, pageSize: 20, zoneId: 'zone-uuid-a' });

      const summaryWhere = mockPrismaClient.device.findMany.mock.calls[0][0].where;
      expect(summaryWhere).toEqual(
        expect.objectContaining({ role: 'Bridge', organizationId: 'org-1', zoneId: 'zone-uuid-a' }),
      );
    });

    it('does not add a zone filter when zoneId is omitted', async () => {
      mockPrismaClient.device.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await service.getBridgesPaginated({ page: 1, pageSize: 20 });

      expect(mockPrismaClient.device.findMany.mock.calls[0][0].where).not.toHaveProperty('zoneId');
    });
  });

  describe('getBridgeById', () => {
    it('returns the bridge looked up by its device UUID', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice({ id: 'device-uuid-5', name: 'Bridge-05' }));

      const result = await service.getBridgeById('device-uuid-5');

      expect(result.id).toBe('device-uuid-5');
      expect(result.name).toBe('Bridge-05');
      expect(result.type).toBe('managed');
      expect(mockPrismaClient.device.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'device-uuid-5', role: 'Bridge' }) }),
      );
    });

    it('throws NotFoundException when the bridge is not found', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(null);

      await expect(service.getBridgeById('missing-uuid')).rejects.toThrow(NotFoundException);
      await expect(service.getBridgeById('missing-uuid')).rejects.toThrow('Bridge not found');
    });
  });

  describe('live presence overlay', () => {
    it('marks a bridge online + leader from a fresh registered_at', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice());
      mockRedis.hgetall.mockResolvedValue({ registered_at: String(Date.now() / 1000), is_leader: 'True' });

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(bridge.online).toBe(true);
      expect(bridge.is_leader).toBe(true);
      expect(mockRedis.hgetall).toHaveBeenCalledWith('zone-uuid-a:bridge:instance:Bridge-01');
    });

    it('marks a bridge offline when registered_at is stale (missed check-ins)', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice());
      mockRedis.hgetall.mockResolvedValue({ registered_at: String(Date.now() / 1000 - 100), is_leader: 'True' });

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(bridge.online).toBe(false);
    });

    it('marks a bridge offline when no presence key exists', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice());
      mockRedis.hgetall.mockResolvedValue({});

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(bridge.online).toBe(false);
      expect(bridge.is_leader).toBe(false);
    });
  });

  describe('enrichInterfacePrefixes (via getBridgeById)', () => {
    it('enriches each IP with the most-specific matching zone prefix and populates role', async () => {
      const device = mockBridgeDevice({
        interfaces: [
          {
            name: 'eth0',
            macAddress: 'AA:BB:CC:DD:EE:FF',
            mgmtOnly: false,
            enabled: true,
            markConnected: true,
            type: null,
            ipAddresses: [
              { id: 'ip-1', address: '10.0.0.1/24' },
              { id: 'ip-2', address: '192.168.1.5/24' },
            ],
          },
        ],
      });
      mockPrismaClient.device.findUnique.mockResolvedValue(device);
      mockPrismaClient.$queryRaw.mockResolvedValue([
        { ipId: 'ip-1', prefixId: 'prefix-1', prefix: '10.0.0.0/24', role: 'primary' },
        { ipId: 'ip-2', prefixId: 'prefix-2', prefix: '192.168.1.0/24', role: 'management' },
      ]);

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(bridge.interfaces[0].ip_addresses[0].prefix).toEqual({
        id: 'prefix-1',
        prefix: '10.0.0.0/24',
        role: 'primary',
      });
      expect(bridge.interfaces[0].ip_addresses[1].prefix).toEqual({
        id: 'prefix-2',
        prefix: '192.168.1.0/24',
        role: 'management',
      });
      expect(mockPrismaClient.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('leaves prefix null when no zone prefix contains the IP', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice());
      mockPrismaClient.$queryRaw.mockResolvedValue([]);

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(bridge.interfaces[0].ip_addresses[0].prefix).toBeNull();
    });

    it('early-returns without querying when zoneId is null', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice({ zoneId: null }));

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
      expect(bridge.interfaces[0].ip_addresses[0]).not.toHaveProperty('prefix');
    });

    it('early-returns without querying when the bridge has no interface IPs', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(
        mockBridgeDevice({
          interfaces: [
            {
              name: 'eth0',
              macAddress: 'AA:BB:CC:DD:EE:FF',
              mgmtOnly: false,
              enabled: true,
              markConnected: true,
              type: null,
              ipAddresses: [],
            },
          ],
        }),
      );

      await service.getBridgeById('device-uuid-1');

      expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
    });

    it('early-returns without querying when the bridge has only IPv6 IPs', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(
        mockBridgeDevice({
          interfaces: [
            {
              name: 'eth0',
              macAddress: 'AA:BB:CC:DD:EE:FF',
              mgmtOnly: false,
              enabled: true,
              markConnected: true,
              type: null,
              ipAddresses: [{ id: 'ip-v6', address: 'fd00::1/64' }],
            },
          ],
        }),
      );

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(mockPrismaClient.$queryRaw).not.toHaveBeenCalled();
      expect(bridge.interfaces[0].ip_addresses[0]).not.toHaveProperty('prefix');
    });

    it('enriches the IPv4 IP but leaves the IPv6 IP without a prefix key on a dual-stack bridge', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(
        mockBridgeDevice({
          interfaces: [
            {
              name: 'eth0',
              macAddress: 'AA:BB:CC:DD:EE:FF',
              mgmtOnly: false,
              enabled: true,
              markConnected: true,
              type: null,
              ipAddresses: [
                { id: 'ip-v4', address: '10.0.0.1/24' },
                { id: 'ip-v6', address: 'fd00::1/64' },
              ],
            },
          ],
        }),
      );
      mockPrismaClient.$queryRaw.mockResolvedValue([
        { ipId: 'ip-v4', prefixId: 'prefix-1', prefix: '10.0.0.0/24', role: 'primary' },
      ]);

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(mockPrismaClient.$queryRaw).toHaveBeenCalledTimes(1);
      expect(bridge.interfaces[0].ip_addresses[0].prefix).toEqual({
        id: 'prefix-1',
        prefix: '10.0.0.0/24',
        role: 'primary',
      });
      expect(bridge.interfaces[0].ip_addresses[1]).not.toHaveProperty('prefix');
    });

    it('logs a warning and omits prefixes when $queryRaw fails (catch path)', async () => {
      mockPrismaClient.device.findUnique.mockResolvedValue(mockBridgeDevice());
      mockPrismaClient.$queryRaw.mockRejectedValue(new Error('DB connection lost'));

      const bridge = await service.getBridgeById('device-uuid-1');

      expect(bridge.id).toBe('device-uuid-1');
      expect(bridge.interfaces[0].ip_addresses[0]).not.toHaveProperty('prefix');
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('enrichInterfacePrefixes failed'));
    });
  });
});
