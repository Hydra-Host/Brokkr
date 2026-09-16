import { DeviceRole, DeviceStatus, InterfaceType, Prisma } from '@repo/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureIpAddress } from '../../common/ipam/ensure-ip-address';
import type { LoggerService } from '../../logger/logger.service';
import type { PrismaClient } from '../../prisma/prisma.client';
import { BridgePresenceReconcilerService } from '../bridge-presence-reconciler.service';

vi.mock('../../common/ipam/ensure-ip-address', () => ({
  ensureIpAddress: vi.fn().mockResolvedValue('created'),
}));

const ZONE = 'deca8b4c-2e65-4f75-96e5-67bdcdc9d79a';
const ORG = '00000000-0000-0000-0000-000000000000';
const KEY = `${ZONE}:bridge:instance:spoke-1`;

interface DbIface {
  id: string;
  name: string;
  macAddress: string | null;
  type: InterfaceType | null;
  enabled: boolean;
  markConnected: boolean;
  ipAddresses: Array<{ id: string; address: string }>;
}

function buildService(
  hash: Record<string, string>,
  zones = [{ id: ZONE, organizationId: ORG }],
  dbIfaces: DbIface[] = [],
) {
  const scan = vi.fn().mockResolvedValue(['0', [KEY]]);
  const hgetall = vi.fn().mockResolvedValue(hash);
  const redis = { scan, hgetall } as unknown as import('ioredis').default;

  const upsert = vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue(zones);

  let created = 0;
  let ipCreated = 0;
  const tx = {
    interface: {
      findMany: vi.fn().mockResolvedValue(dbIfaces),
      create: vi.fn().mockImplementation(() => Promise.resolve({ id: `new-iface-${++created}` })),
      update: vi.fn().mockResolvedValue({}),
    },
    ipAddress: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      create: vi.fn().mockImplementation(() => Promise.resolve({ id: `new-ip-${++ipCreated}` })),
    },
    gateway: {
      create: vi.fn().mockResolvedValue({ id: 'gw-1' }),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    prefix: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const $transaction = vi.fn((cb: (t: typeof tx) => unknown) => cb(tx));

  const prisma = { device: { upsert }, zone: { findMany }, $transaction } as unknown as PrismaClient;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as unknown as LoggerService;

  const service = new BridgePresenceReconcilerService(prisma, redis, logger);
  return { service, upsert, findMany, hgetall, logger, tx };
}

const ifaceJson = (
  entries: Array<{ iface: string; mac: string; subnet: string; ip: string; gateway?: string; routed?: boolean }>,
) => JSON.stringify(entries);

const getSqlTexts = (calls: unknown[][]): string[] => calls.map((call) => (call[0] as Prisma.Sql).sql);

describe('BridgePresenceReconcilerService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a Device(role=Bridge) + Bridge from a Redis presence hash', async () => {
    const { service, upsert } = buildService({
      instance_id: 'spoke-1',
      brokkr_worker_version: '1.2.3',
      brokkr_live_version: '0.9.1',
    });

    await service.handleCron();

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(typeof arg.where.id).toBe('string');
    expect(arg.create).toMatchObject({
      name: 'spoke-1',
      role: DeviceRole.Bridge,
      status: DeviceStatus.ACTIVE,
      supplierId: ORG,
      zoneId: ZONE,
    });
    expect(arg.create.bridge.create).toMatchObject({
      redisQueuePrefix: ZONE,
      bridgeVersion: '1.2.3',
      brokkrLiveVersion: '0.9.1',
    });
  });

  it('is write-on-change: an unchanged bridge is not re-upserted on the next tick', async () => {
    const { service, upsert } = buildService({ instance_id: 'spoke-1', brokkr_worker_version: '1.2.3' });

    await service.handleCron();
    await service.handleCron();

    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it('re-upserts when the bridge version changes', async () => {
    const { service, upsert, hgetall } = buildService({ instance_id: 'spoke-1', brokkr_worker_version: '1.2.3' });

    await service.handleCron();
    hgetall.mockResolvedValueOnce({ instance_id: 'spoke-1', brokkr_worker_version: '1.3.0' });
    await service.handleCron();

    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('re-upserts when only the brokkr-live version changes', async () => {
    const { service, upsert, hgetall } = buildService({
      instance_id: 'spoke-1',
      brokkr_worker_version: '1.2.3',
      brokkr_live_version: '0.9.1',
    });

    await service.handleCron();
    hgetall.mockResolvedValueOnce({
      instance_id: 'spoke-1',
      brokkr_worker_version: '1.2.3',
      brokkr_live_version: '0.9.2',
    });
    await service.handleCron();

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert.mock.calls[1][0].update.bridge.upsert.update).toMatchObject({ brokkrLiveVersion: '0.9.2' });
  });

  it('skips bridges whose zone row is missing/deleted', async () => {
    const { service, upsert, logger } = buildService({ instance_id: 'spoke-1' }, []);

    await service.handleCron();

    expect(upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('skipping its bridges'));
  });

  it('skips a malformed presence hash without a Device write', async () => {
    const { service, upsert, logger } = buildService({ is_leader: 'True' });

    await service.handleCron();

    expect(upsert).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Malformed bridge presence hash'));
  });

  describe('interface reconcile', () => {
    beforeEach(() => vi.mocked(ensureIpAddress).mockClear());

    it('creates a new NIC and ensures its IP when none exists in the DB', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      expect(tx.interface.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'bond0', macAddress: 'aa:bb:cc:dd:ee:01' }) }),
      );
      expect(ensureIpAddress).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ address: '10.0.0.5/24', organizationId: ORG }),
      );
    });

    it('matches by MAC and takes the live name on a rename', async () => {
      const { service, tx } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'bond1', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'bond0',
            macAddress: 'AA:BB:CC:DD:EE:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [{ id: 'ip-1', address: '10.0.0.5/24' }],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.create).not.toHaveBeenCalled();
      expect(tx.interface.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'if-1' }, data: expect.objectContaining({ name: 'bond1' }) }),
      );
    });

    it('creates a NIC without a MAC when a matched row already keeps that MAC this tick', async () => {
      const { service, tx, logger } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'eth0', mac: '00:00:00:00:00:00', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
            { iface: 'eth1', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.1.0/24', ip: '10.0.1.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'eth0',
            macAddress: 'aa:bb:cc:dd:ee:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [{ id: 'ip-1', address: '10.0.0.5/24' }],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.create).toHaveBeenCalledTimes(1);
      expect(tx.interface.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ name: 'eth1', macAddress: null, type: null }) }),
      );
      const macWrites = tx.interface.update.mock.calls.filter((call) => call[0].data.macAddress !== undefined);
      expect(macWrites).toEqual([]);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('eth0 and eth1'));
    });

    it('skips the MAC update on a name-matched NIC when another matched row keeps that MAC', async () => {
      const { service, tx, logger } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'eth0', mac: '00:00:00:00:00:00', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
            { iface: 'eth1', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.1.0/24', ip: '10.0.1.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'eth0',
            macAddress: 'aa:bb:cc:dd:ee:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
          {
            id: 'if-2',
            name: 'eth1',
            macAddress: 'aa:bb:cc:dd:ee:02',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.create).not.toHaveBeenCalled();
      const macWrites = tx.interface.update.mock.calls.filter((call) => call[0].data.macAddress !== undefined);
      expect(macWrites).toEqual([]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('eth0 and eth1'));
    });

    it('ensures a zone Prefix for each connected subnet (>/32)', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          { iface: 'lo', mac: '00:00:00:00:00:00', subnet: '10.9.9.9/32', ip: '10.9.9.9' },
        ]),
      });

      await service.handleCron();

      const texts = getSqlTexts(tx.$executeRaw.mock.calls);
      expect(texts.filter((t: string) => t.includes('pg_advisory_xact_lock'))).toHaveLength(1);
      expect(texts.filter((t: string) => t.includes('INSERT INTO "Prefix"'))).toHaveLength(1);
    });

    it('persists a MAC-less overlay NIC (wt0) as VIRTUAL, matched by name', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'wt0', mac: '00:00:00:00:00:00', subnet: '100.64.0.0/10', ip: '100.64.0.2' },
        ]),
      });

      await service.handleCron();

      expect(tx.interface.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ name: 'wt0', macAddress: null, type: InterfaceType.VIRTUAL }),
        }),
      );
    });

    it('disables a NIC absent from the live set and retires its IPs', async () => {
      const { service, tx } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'bond0',
            macAddress: 'aa:bb:cc:dd:ee:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
          {
            id: 'if-gone',
            name: 'eth9',
            macAddress: 'aa:bb:cc:dd:ee:99',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [{ id: 'ip-gone', address: '192.168.9.9/24' }],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.update).toHaveBeenCalledWith({
        where: { id: 'if-gone' },
        data: { enabled: false, deletedAt: expect.any(Date) },
      });
      expect(tx.ipAddress.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ip-gone', interfaceId: 'if-gone', deletedAt: null },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });

    it('renames two NICs that swap names via a temp name (no partial-unique collision)', async () => {
      const { service, tx } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'eth1', mac: 'aa:bb:cc:dd:ee:0a', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
            { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:0b', subnet: '10.0.0.0/24', ip: '10.0.0.6' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-a',
            name: 'eth0',
            macAddress: 'aa:bb:cc:dd:ee:0a',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
          {
            id: 'if-b',
            name: 'eth1',
            macAddress: 'aa:bb:cc:dd:ee:0b',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.update).toHaveBeenCalledWith({ where: { id: 'if-a' }, data: { name: '__tmp__if-a' } });
      expect(tx.interface.update).toHaveBeenCalledWith({ where: { id: 'if-b' }, data: { name: '__tmp__if-b' } });
      expect(tx.interface.update).toHaveBeenCalledWith({ where: { id: 'if-a' }, data: { name: 'eth1' } });
      expect(tx.interface.update).toHaveBeenCalledWith({ where: { id: 'if-b' }, data: { name: 'eth0' } });

      const calls = tx.interface.update.mock.calls as Array<[{ where: { id: string }; data: { name: string } }]>;
      const orders = tx.interface.update.mock.invocationCallOrder;
      const orderOf = (id: string, name: string) => {
        const idx = calls.findIndex((c) => c[0].where.id === id && c[0].data.name === name);
        expect(idx, `expected update(${id}, ${name}) to exist`).not.toBe(-1);
        return orders[idx];
      };
      const tempA = orderOf('if-a', '__tmp__if-a');
      const tempB = orderOf('if-b', '__tmp__if-b');
      const finalA = orderOf('if-a', 'eth1');
      const finalB = orderOf('if-b', 'eth0');
      expect(Math.max(tempA, tempB), 'both temp parks must complete before any final rename').toBeLessThan(
        Math.min(finalA, finalB),
      );
    });

    it('tears down a departing NIC before renaming a survivor onto its freed name (no unique collision)', async () => {
      const { service, tx } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'eth1', mac: 'aa:bb:cc:dd:ee:0a', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-a',
            name: 'eth0',
            macAddress: 'aa:bb:cc:dd:ee:0a',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
          {
            id: 'if-b',
            name: 'eth1',
            macAddress: 'aa:bb:cc:dd:ee:0b',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.update).toHaveBeenCalledWith({
        where: { id: 'if-b' },
        data: { enabled: false, deletedAt: expect.any(Date) },
      });
      expect(tx.interface.update).toHaveBeenCalledWith({ where: { id: 'if-a' }, data: { name: 'eth1' } });

      const calls = tx.interface.update.mock.calls as Array<[{ where: { id: string }; data: Record<string, unknown> }]>;
      const orders = tx.interface.update.mock.invocationCallOrder;
      const teardownB = orders[calls.findIndex((c) => c[0].where.id === 'if-b' && c[0].data.deletedAt !== undefined)];
      const finalA = orders[calls.findIndex((c) => c[0].where.id === 'if-a' && c[0].data.name === 'eth1')];
      expect(teardownB, 'departing NIC must be torn down before the survivor claims its name').toBeLessThan(finalA);
    });

    it('skips absent-NIC teardown when some live names are unsafe (partial-forge cannot tear down inventory)', async () => {
      const { service, tx, logger } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
            { iface: 'evil;rm', mac: 'aa:bb:cc:dd:ee:66', subnet: '10.0.0.0/24', ip: '10.0.0.7' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'bond0',
            macAddress: 'aa:bb:cc:dd:ee:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [],
          },
          {
            id: 'if-gone',
            name: 'eth9',
            macAddress: 'aa:bb:cc:dd:ee:99',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [{ id: 'ip-gone', address: '192.168.9.9/24' }],
          },
        ],
      );

      await service.handleCron();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unsafe name'));
      const ifGone = tx.interface.update.mock.calls.filter((c: any) => c[0]?.where?.id === 'if-gone');
      expect(ifGone).toHaveLength(0);
      expect(tx.ipAddress.updateMany).not.toHaveBeenCalled();
    });

    it('skips NIC sync on an empty interfaces_json rather than wiping the inventory', async () => {
      const { service, tx } = buildService({ instance_id: 'spoke-1', interfaces_json: '[]' }, undefined, [
        {
          id: 'if-1',
          name: 'bond0',
          macAddress: 'aa:bb:cc:dd:ee:01',
          type: null,
          enabled: true,
          markConnected: true,
          ipAddresses: [{ id: 'ip-1', address: '10.0.0.5/24' }],
        },
      ]);

      await service.handleCron();

      expect(tx.interface.findMany).not.toHaveBeenCalled();
      expect(tx.interface.update).not.toHaveBeenCalled();
      expect(tx.ipAddress.updateMany).not.toHaveBeenCalled();
    });

    it('drops a NIC whose name has shell metacharacters (iptables injection guard)', async () => {
      const { service, tx, logger } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'eth0; curl x | bash', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      expect(tx.interface.create).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('unsafe name'));
    });

    it('preserves inventory when every live NIC name is unsafe (no mass-disable)', async () => {
      const { service, tx } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'bad name;', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'bond0',
            macAddress: 'aa:bb:cc:dd:ee:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [{ id: 'ip-1', address: '10.0.0.5/24' }],
          },
        ],
      );

      await service.handleCron();

      expect(tx.interface.update).not.toHaveBeenCalled();
      expect(tx.ipAddress.updateMany).not.toHaveBeenCalled();
    });

    it('retires an IP that vanished from a still-present NIC', async () => {
      const { service, tx } = buildService(
        {
          instance_id: 'spoke-1',
          interfaces_json: ifaceJson([
            { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
          ]),
        },
        undefined,
        [
          {
            id: 'if-1',
            name: 'bond0',
            macAddress: 'aa:bb:cc:dd:ee:01',
            type: null,
            enabled: true,
            markConnected: true,
            ipAddresses: [
              { id: 'ip-keep', address: '10.0.0.5/24' },
              { id: 'ip-drop', address: '10.0.0.9/24' },
            ],
          },
        ],
      );

      await service.handleCron();

      expect(tx.ipAddress.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ip-drop', interfaceId: 'if-1', deletedAt: null },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(tx.ipAddress.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'ip-keep' }) }),
      );
    });

    it('logs a warning when ensureIpAddress resolves "invalid"', async () => {
      vi.mocked(ensureIpAddress).mockResolvedValue('invalid');
      const { service, logger } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Skipped IP'));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('invalid'));
    });

    it('logs a warning when ensureIpAddress resolves "assigned-elsewhere"', async () => {
      vi.mocked(ensureIpAddress).mockResolvedValue('assigned-elsewhere');
      const { service, logger } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('assigned-elsewhere'));
    });

    it('ensures an IPv6 zone Prefix for /64 but skips a /128 host route', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:01', subnet: '2001:db8::/64', ip: '2001:db8::5' },
          { iface: 'eth1', mac: 'aa:bb:cc:dd:ee:02', subnet: '2001:db8::1/128', ip: '2001:db8::1' },
        ]),
      });

      await service.handleCron();

      const texts = getSqlTexts(tx.$executeRaw.mock.calls);
      expect(texts.filter((t: string) => t.includes('pg_advisory_xact_lock'))).toHaveLength(1);
      expect(texts.filter((t: string) => t.includes('INSERT INTO "Prefix"'))).toHaveLength(1);
    });

    it('skips a subnet with a syntactically-invalid host rather than crashing on the ::cidr cast', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:01', subnet: '999.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      const texts = getSqlTexts(tx.$executeRaw.mock.calls);
      expect(texts.filter((t: string) => t.includes('pg_advisory_xact_lock'))).toHaveLength(0);
      expect(texts.filter((t: string) => t.includes('INSERT INTO "Prefix"'))).toHaveLength(0);
    });
  });

  describe('prefix reconcile', () => {
    const oneNic = () =>
      buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

    const prefixInsert = (tx: { $executeRaw: { mock: { calls: unknown[][] } } }): string => {
      const inserts = getSqlTexts(tx.$executeRaw.mock.calls).filter((t) => t.includes('INSERT INTO "Prefix"'));
      expect(inserts).toHaveLength(1);
      return inserts[0];
    };

    it('guards the exact CIDR org-wide and not only in the null-VRF slot', async () => {
      const { service, tx } = oneNic();

      await service.handleCron();

      const insert = prefixInsert(tx);
      expect(insert).toContain('AND prefix = ');
      expect(insert).not.toContain('"vrfId" IS NULL');
    });

    it('still skips a subnet a prefix in its own zone already contains', async () => {
      const { service, tx } = oneNic();

      await service.handleCron();

      const insert = prefixInsert(tx);
      expect(insert).toContain('prefix >>= ');
      expect(insert).toContain('"zoneId" = ');
    });
  });

  describe('gateway reconcile', () => {
    beforeEach(() => vi.mocked(ensureIpAddress).mockClear());

    it('creates a Gateway and IpAddress from bridge presence data when prefix has no gateway', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip-1' }]);

      await service.handleCron();

      expect(tx.$queryRaw).toHaveBeenCalled();
      expect(tx.gateway.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prefixId: 'prefix-1', gatewayIpId: 'new-gw-ip-1', routingPriority: 100 }),
        }),
      );
      expect(tx.prefix.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prefix-1', gatewayIpId: null },
          data: expect.objectContaining({ gatewayIpId: 'new-gw-ip-1' }),
        }),
      );
    });

    it('does not create duplicate gateway on a second run with the same data', async () => {
      const { service, tx, hgetall } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip-1' }]);

      await service.handleCron();

      const gwCreateCount = tx.gateway.create.mock.calls.length;

      hgetall.mockResolvedValueOnce({
        instance_id: 'spoke-1',
        brokkr_worker_version: '1.0.1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw.mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: 'existing-ip-1', vrfId: null }]);

      await service.handleCron();

      expect(tx.gateway.create.mock.calls.length).toBe(gwCreateCount);
    });

    it('does not attempt gateway creation when no gateway field is present', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
    });

    it('skips auto-derived gateway entirely when prefix already has an operator-set gatewayIpId', async () => {
      const { service, tx, logger } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: 'operator-gw-ip' }]);

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.prefix.updateMany).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('operator-set gateway'));
    });

    it('fills null gatewayIpId on prefix from bridge-derived gateway IP', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'bridge-gw-ip-1' }]);

      await service.handleCron();

      expect(tx.prefix.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'prefix-1', gatewayIpId: null },
          data: expect.objectContaining({ gatewayIpId: 'bridge-gw-ip-1' }),
        }),
      );
    });

    it('creates separate Gateway rows for multiple NICs with different subnets and gateways', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
          { iface: 'bond1', mac: 'aa:bb:cc:dd:ee:02', subnet: '10.1.0.0/24', ip: '10.1.0.5', gateway: '10.1.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-a', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'gw-ip-a' }])
        .mockResolvedValueOnce([{ id: 'prefix-b', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'gw-ip-b' }]);

      await service.handleCron();

      expect(tx.gateway.create).toHaveBeenCalledTimes(2);
      expect(tx.prefix.updateMany).toHaveBeenCalledTimes(2);
    });

    it('skips gateway derivation when the gateway address is outside the reported subnet', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.1.0.1' },
        ]),
      });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.prefix.updateMany).not.toHaveBeenCalled();
    });

    it('ignores routed presence entries when deriving gateways', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          {
            iface: 'bond0',
            mac: 'aa:bb:cc:dd:ee:01',
            subnet: '10.9.0.0/16',
            ip: '10.2.0.4',
            gateway: '10.9.0.1',
            routed: true,
          },
        ]),
      });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.prefix.updateMany).not.toHaveBeenCalled();
    });

    it('skips prefixes that already have a gateway row', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw.mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }]);
      tx.gateway.findFirst.mockResolvedValueOnce({ id: 'operator-gw' });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.prefix.updateMany).not.toHaveBeenCalled();
    });

    it('skips the gateway when no prefix covers the reported subnet', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.prefix.updateMany).not.toHaveBeenCalled();

      const prefixQuery = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(prefixQuery.sql).toContain('prefix = ');
    });

    it('materializes the exact child prefix under a supernet and binds the gateway to it', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'supernet-1', vrfId: 'vrf-9' }])
        .mockResolvedValueOnce([{ id: 'child-1', gatewayIpId: null, vrfId: 'vrf-9' }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip' }]);

      await service.handleCron();

      const inserts = tx.$executeRaw.mock.calls.map((call) => (call[0] as Prisma.Sql).sql).join('\n');
      expect(inserts).toContain('INSERT INTO "Prefix"');
      expect(inserts).toContain('"parentId"');
      expect(inserts).toContain('IS NOT DISTINCT FROM s."vrfId"');
      expect(tx.gateway.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prefixId: 'child-1', vrfId: 'vrf-9' }),
        }),
      );
      expect(tx.prefix.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'child-1', gatewayIpId: null } }),
      );
    });

    it('skips a gateway whose subnet host is syntactically invalid rather than crashing on the ::cidr cast', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:01', subnet: 'not-an-ip/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('skips a gateway whose subnet is a /32 host route', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'eth0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.1/32', ip: '10.0.0.1', gateway: '10.0.0.254' },
        ]),
      });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
    });

    it('skips gateway from an interface with an unsafe name', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
          { iface: 'evil;rm', mac: 'aa:bb:cc:dd:ee:66', subnet: '10.1.0.0/24', ip: '10.1.0.5', gateway: '10.1.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip' }]);

      await service.handleCron();

      expect(tx.gateway.create).toHaveBeenCalledTimes(1);
      expect(tx.gateway.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ prefixId: 'prefix-1' }),
        }),
      );
    });

    it('binds the gateway only to the exact-cidr prefix', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'specific-24', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip' }]);

      await service.handleCron();

      const prefixQuery = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
      expect(prefixQuery.sql).toContain('prefix = ');
      expect(prefixQuery.sql).not.toContain('>>=');
    });

    it('acquires an org+vrf-scoped advisory lock before gateway upserts', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip' }]);

      await service.handleCron();

      const lockCalls = tx.$executeRaw.mock.calls.filter((call: unknown[]) => {
        const sql = call[0] as Prisma.Sql;
        return (
          sql.sql.includes('pg_advisory_xact_lock') &&
          (sql.values as string[]).some((v) => String(v).includes('ipam:gateway:'))
        );
      });
      expect(lockCalls).toHaveLength(1);
    });

    it('reuses any existing IpAddress row via atomic insert fallback to avoid duplicates', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'existing-ip' }]);

      await service.handleCron();

      expect(tx.gateway.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ gatewayIpId: 'existing-ip' }) }),
      );
    });

    it('scopes gateway ip lookup to prefix vrf so same ip in a different vrf is not reused', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: 'vrf-zone-a' }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip' }]);

      await service.handleCron();

      const insertSql = tx.$queryRaw.mock.calls[2][0] as Prisma.Sql;
      expect(insertSql.sql).toContain('IS NOT DISTINCT FROM');
      expect(insertSql.values).toContain('vrf-zone-a');

      expect(tx.gateway.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ vrfId: 'vrf-zone-a' }),
        }),
      );
    });

    it('creates gateway ip with null vrf when prefix has no vrf', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5', gateway: '10.0.0.1' },
        ]),
      });
      tx.$queryRaw
        .mockResolvedValueOnce([{ id: 'prefix-1', gatewayIpId: null, vrfId: null }])
        .mockResolvedValueOnce([{ gatewayIpId: null }])
        .mockResolvedValueOnce([{ id: 'new-gw-ip' }]);

      await service.handleCron();

      const insertSql = tx.$queryRaw.mock.calls[2][0] as Prisma.Sql;
      expect(insertSql.values).toContain(null);
    });

    it('does not delete or expire gateways during normal reconcile (gateways are infrastructure)', async () => {
      const { service, tx } = buildService({
        instance_id: 'spoke-1',
        interfaces_json: ifaceJson([
          { iface: 'bond0', mac: 'aa:bb:cc:dd:ee:01', subnet: '10.0.0.0/24', ip: '10.0.0.5' },
        ]),
      });

      await service.handleCron();

      expect(tx.gateway.create).not.toHaveBeenCalled();
      expect(tx.gateway.findFirst).not.toHaveBeenCalled();
    });
  });
});
