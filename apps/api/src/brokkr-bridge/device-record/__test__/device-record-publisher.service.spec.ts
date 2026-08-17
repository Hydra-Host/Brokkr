import { Test, type TestingModule } from '@nestjs/testing';
import { DeviceRole } from '@repo/database';
import { ConfigAtomWriter } from 'src/common/redis';
import { NetplanService } from 'src/devices/netplan/netplan.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { z } from 'zod';
import { DeviceRecordPublisher, TTL_PLACEHOLDER_DEVICE_RECORD_SECONDS } from '../device-record-publisher.service';
import { DeviceRecordSchema } from '../device-record.schema';
import { placeholderIdFromBundle } from '../placeholder-id';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440000';
const ZONE_ID = '550e8400-e29b-41d4-a716-446655440042';

function makeDeviceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: DEVICE_UUID,
    status: 'ACTIVE',
    role: DeviceRole.DiscoveredHost,
    lastJobId: 'job-1',
    ipmiBootDeviceOverride: null,
    server: { netplanOverride: null },
    zoneId: ZONE_ID,
    zone: null,
    serial: 'SN-100',
    systemUuid: '550e8400-e29b-41d4-a716-446655440aaa',
    chassisSerial: null,
    baseboardSerial: null,
    deviceModel: { slug: 'dell-r740', model: 'PowerEdge R740', manufacturer: 'Dell' },
    solConfig: { optimalPort: 'ttyS1' },
    interfaces: [
      { macAddress: 'aa:bb:cc:dd:ee:ff', mgmtOnly: false, ipAddresses: [{ address: '192.168.200.10/24' }] },
      { macAddress: '11:22:33:44:55:66', mgmtOnly: true, ipAddresses: [{ address: '192.168.105.10' }] },
    ],
    ...overrides,
  };
}

type MutatorResult = {
  value: string[];
  extraOps: Array<{ op: 'set' | 'del'; key: string; value?: string; ttl?: number }>;
};

interface AtomWriterMock {
  writeAtomJson: Mock;
  watchAndExecMulti: Mock;
  writeMulti: Mock;
  readJson: Mock;
}

describe('DeviceRecordPublisher', () => {
  let publisher: DeviceRecordPublisher;
  let atomWriter: AtomWriterMock;
  let netplan: { renderForDevice: Mock };
  let prisma: {
    device: { findUnique: Mock };
    zone: { findUnique: Mock };
    deployment: { findFirst: Mock };
  };
  let lastMutatorResult: MutatorResult | null;
  let logger: { log: Mock; warn: Mock };

  beforeEach(async () => {
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', '');
    lastMutatorResult = null;
    atomWriter = {
      writeAtomJson: vi.fn().mockResolvedValue({ written: true }),
      writeMulti: vi.fn().mockResolvedValue(undefined),
      readJson: vi.fn().mockResolvedValue(null),
      watchAndExecMulti: vi
        .fn()
        .mockImplementation(
          async (
            _zone: string,
            _key: string,
            _schema: z.ZodSchema<unknown>,
            mutator: (current: string[] | null) => MutatorResult,
          ) => {
            lastMutatorResult = mutator(null);
            return { updated: true, attempts: 1 };
          },
        ),
    };
    prisma = {
      device: { findUnique: vi.fn() },
      zone: { findUnique: vi.fn().mockResolvedValue(null) },
      deployment: { findFirst: vi.fn().mockResolvedValue(null) },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeviceRecordPublisher,
        { provide: PrismaClient, useValue: prisma },
        { provide: ConfigAtomWriter, useValue: atomWriter },
        { provide: NetplanService, useValue: { renderForDevice: vi.fn().mockResolvedValue('NETPLAN_YAML') } },
        {
          provide: `LoggerService${DeviceRecordPublisher.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    publisher = module.get(DeviceRecordPublisher);
    netplan = module.get(NetplanService);
    logger = module.get(`LoggerService${DeviceRecordPublisher.name}`);
  });

  afterEach(() => vi.restoreAllMocks());

  describe('writeForDevice', () => {
    it('reads the device once and publishes the record + pointers', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());

      await publisher.writeForDevice(DEVICE_UUID, { requestId: 'req-1' });

      expect(prisma.device.findUnique).toHaveBeenCalledTimes(1);
      expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
      expect(atomWriter.watchAndExecMulti).toHaveBeenCalledTimes(1);
    });

    it('skips publishing for an infrastructure role outside the allow-list (e.g. Switch)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Switch }));

      await publisher.writeForDevice(DEVICE_UUID);

      expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
      expect(atomWriter.watchAndExecMulti).not.toHaveBeenCalled();
    });

    it('publishes for an allow-listed host role (OffMarketplaceHost)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.OffMarketplaceHost }));

      await publisher.writeForDevice(DEVICE_UUID);

      expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
    });

    it('publishes a role=null commissioning device (no opt-in needed) with a computed netplan', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: null }));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result.written).toBe(true);
      expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
      const writtenRecord = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(writtenRecord.netplan).toBe('NETPLAN_YAML');
      expect(netplan.renderForDevice).toHaveBeenCalledWith(DEVICE_UUID, 'live');
    });

    it('still skips a non-null infra role outside the allow-list (the role=null relaxation is commissioning-only)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Switch }));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: false, reason: 'role-not-published' });
      expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
      expect(atomWriter.watchAndExecMulti).not.toHaveBeenCalled();
    });

    it('publishes for the allow-listed Server role', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Server }));

      await publisher.writeForDevice(DEVICE_UUID);

      expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
    });

    it('publishes a non-baremetal allow-listed role with netplan: null (DHCP) — no render', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Hypervisor }));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result.written).toBe(true);
      expect(netplan.renderForDevice).not.toHaveBeenCalled();
      expect(atomWriter.writeAtomJson.mock.calls[0][2].netplan).toBeNull();
    });

    it('still publishes the boot record when netplan render throws — falls back to null (DHCP)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Server }));
      netplan.renderForDevice.mockRejectedValueOnce(new Error('context build failed'));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result.written).toBe(true);
      expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
      expect(atomWriter.writeAtomJson.mock.calls[0][2].netplan).toBeNull();
    });

    it('envelope-writes the record under device:{uuid}:device_record with ttl=0', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());

      await publisher.writeForDevice(DEVICE_UUID);

      const [zone, key, value, schema, ttl, opts] = atomWriter.writeAtomJson.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      expect(key).toBe(`device:${DEVICE_UUID}:device_record`);
      expect(schema).toBe(DeviceRecordSchema);
      expect(ttl).toBe(0);
      expect(opts).toEqual({ request_id: null });
      expect(value).toMatchObject({
        id: DEVICE_UUID,
        is_placeholder: false,
        status: 'ACTIVE',
        role: 'discovered-hosts',
        device_type: 'dell-r740',
        serial_port_recommended: 'ttyS1',
        last_job_id: 'job-1',
        buildarch: null,
      });
      expect(value).not.toHaveProperty('tenant_id');
      expect(value).not.toHaveProperty('site_id');
      expect(value).not.toHaveProperty('location_id');
    });

    it('publishes device:{id}:data (plain JSON, persistent) with role + device_type + mgmt-only BMC IP', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());

      await publisher.writeForDevice(DEVICE_UUID);

      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [zone, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({ op: 'set', key: `device:${DEVICE_UUID}:data` });
      expect(ops[0].ttl).toBeUndefined();
      const blob = JSON.parse(ops[0].value);
      expect(blob.role).toBe('discovered-hosts');
      expect(blob.device_type).toEqual({
        slug: 'dell-r740',
        model: 'PowerEdge R740',
        manufacturer: { name: 'Dell' },
      });
      const mgmt = blob.interfaces.find((i: { mgmt_only: boolean }) => i.mgmt_only);
      expect(mgmt.ip_addresses).toEqual([{ address: '192.168.105.10' }]);
    });

    it('publishes device_type: null in the data blob when the device has no model', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ deviceModel: null }));

      await publisher.writeForDevice(DEVICE_UUID);

      const blob = JSON.parse(atomWriter.writeMulti.mock.calls[0][1][0].value);
      expect(blob.device_type).toBeNull();
    });

    it('deletes any stale device:{id}:data when the role is in neither role set', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Switch }));

      await publisher.writeForDevice(DEVICE_UUID);

      expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [zone, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      expect(ops).toEqual([{ op: 'del', key: `device:${DEVICE_UUID}:data` }]);
    });

    it.each([
      [DeviceRole.PDU, 'pdu', 'vertiv-gu2', 'Vertiv'],
      [DeviceRole.CDU, 'cdu', 'coolit-chx750', 'CoolIT'],
    ])(
      'writes device:{id}:data for monitored-but-not-bootable role %s without a boot record',
      async (role, slug, modelSlug, manufacturer) => {
        prisma.device.findUnique.mockResolvedValueOnce(
          makeDeviceRow({ role, deviceModel: { slug: modelSlug, model: modelSlug, manufacturer } }),
        );

        const result = await publisher.writeForDevice(DEVICE_UUID);

        expect(result).toEqual({ written: false, reason: 'role-not-published' });
        expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
        expect(atomWriter.watchAndExecMulti).not.toHaveBeenCalled();
        expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
        const [zone, ops] = atomWriter.writeMulti.mock.calls[0];
        expect(zone).toBe(ZONE_ID);
        expect(ops[0]).toMatchObject({ op: 'set', key: `device:${DEVICE_UUID}:data` });
        const blob = JSON.parse(ops[0].value);
        expect(blob.role).toBe(slug);
        expect(blob.device_type).toEqual({ slug: modelSlug, model: modelSlug, manufacturer: { name: manufacturer } });
      },
    );

    it.each([[DeviceRole.VM], [DeviceRole.Cluster]])(
      'publishes the boot record for %s but deletes the data atom (no BMC to monitor)',
      async (role) => {
        prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role }));

        const result = await publisher.writeForDevice(DEVICE_UUID);

        expect(result).toEqual({ written: true });
        expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
        expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
        const [, ops] = atomWriter.writeMulti.mock.calls[0];
        expect(ops).toEqual([{ op: 'del', key: `device:${DEVICE_UUID}:data` }]);
      },
    );

    it('keeps a Decommissioned device in the monitoring set (still racked, BMC reachable)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Decommissioned }));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: true });
      const [, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(ops[0]).toMatchObject({ op: 'set', key: `device:${DEVICE_UUID}:data` });
      expect(JSON.parse(ops[0].value).role).toBe('decommissioned-hosts');
    });

    it('writes the data atom for a role=null commissioning device (always monitored)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: null }));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: true });
      const [, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(ops[0]).toMatchObject({ op: 'set', key: `device:${DEVICE_UUID}:data` });
      expect(JSON.parse(ops[0].value).role).toBeNull();
    });

    it('propagates a data-atom write failure on the monitored-not-published path (PDU has no boot record to mask)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.PDU }));
      atomWriter.writeMulti.mockRejectedValueOnce(new Error('redis down'));

      await expect(publisher.writeForDevice(DEVICE_UUID)).rejects.toThrow('redis down');
    });

    it('swallows a data-atom sync failure after a successful boot-record publish (warn, still written: true)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Server }));
      atomWriter.writeMulti.mockRejectedValueOnce(new Error('redis down'));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: true });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to sync device:{id}:data'));
    });

    it('rotates pointers and writes them with the same ttl as the record (no-ttl for real devices)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());

      await publisher.writeForDevice(DEVICE_UUID);

      expect(lastMutatorResult).not.toBeNull();
      const { extraOps, value } = lastMutatorResult!;
      const pointerSets = extraOps.filter((o) => o.op === 'set');
      expect(pointerSets).toHaveLength(5);
      for (const op of pointerSets) {
        expect(op.value).toBe(DEVICE_UUID);
        expect(op.ttl).toBeUndefined();
      }
      expect(value).toContain('device:lookup:mac:aa-bb-cc-dd-ee-ff');
      expect(value).toContain('device:lookup:ipmi_mac:11-22-33-44-55-66');
      expect(value).toContain('device:lookup:mac:11-22-33-44-55-66');
      expect(value).toContain('device:lookup:serial:sn-100');
      expect(value).toContain('device:lookup:system_uuid:550e8400-e29b-41d4-a716-446655440aaa');
    });

    it('DELs stale pointers when identifiers change between writes', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(
        makeDeviceRow({ interfaces: [{ macAddress: 'bb:bb:bb:bb:bb:bb', mgmtOnly: false, ipAddresses: [] }] }),
      );
      atomWriter.watchAndExecMulti.mockImplementationOnce(
        async (
          _zone: string,
          _key: string,
          _schema: z.ZodSchema<unknown>,
          mutator: (current: string[] | null) => MutatorResult,
        ) => {
          lastMutatorResult = mutator(['device:lookup:mac:aa-aa-aa-aa-aa-aa']);
          return { updated: true, attempts: 1 };
        },
      );

      await publisher.writeForDevice(DEVICE_UUID);

      const delOps = lastMutatorResult!.extraOps.filter((o) => o.op === 'del');
      expect(delOps).toContainEqual({ op: 'del', key: 'device:lookup:mac:aa-aa-aa-aa-aa-aa' });
      const setOps = lastMutatorResult!.extraOps.filter((o) => o.op === 'set');
      expect(setOps).toContainEqual(
        expect.objectContaining({ op: 'set', key: 'device:lookup:mac:bb-bb-bb-bb-bb-bb', value: DEVICE_UUID }),
      );
    });

    it('returns { written: true } and emits a mac pointer per interface MAC', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(
        makeDeviceRow({
          interfaces: [
            { macAddress: 'de:ad:be:ef:00:01', mgmtOnly: false, ipAddresses: [] },
            { macAddress: 'de:ad:be:ef:00:02', mgmtOnly: false, ipAddresses: [] },
            { macAddress: 'de:ad:be:ef:00:01', mgmtOnly: false, ipAddresses: [] },
          ],
        }),
      );

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: true });
      const { value } = lastMutatorResult!;
      expect(value).toContain('device:lookup:mac:de-ad-be-ef-00-01');
      expect(value).toContain('device:lookup:mac:de-ad-be-ef-00-02');
      expect(value.filter((k) => k === 'device:lookup:mac:de-ad-be-ef-00-01')).toHaveLength(1);
    });

    it('repoints a stale placeholder MAC pointer to the real device via an interface MAC', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(
        makeDeviceRow({ interfaces: [{ macAddress: 'de:ad:be:ef:00:01', ipAddresses: [] }] }),
      );
      atomWriter.watchAndExecMulti.mockImplementationOnce(
        async (
          _zone: string,
          _key: string,
          _schema: z.ZodSchema<unknown>,
          mutator: (current: string[] | null) => MutatorResult,
        ) => {
          lastMutatorResult = mutator(['device:lookup:mac:de-ad-be-ef-00-01']);
          return { updated: true, attempts: 1 };
        },
      );

      await publisher.writeForDevice(DEVICE_UUID);

      const delOps = lastMutatorResult!.extraOps.filter((o) => o.op === 'del');
      expect(delOps).not.toContainEqual({ op: 'del', key: 'device:lookup:mac:de-ad-be-ef-00-01' });
      const setOps = lastMutatorResult!.extraOps.filter((o) => o.op === 'set');
      expect(setOps).toContainEqual(
        expect.objectContaining({
          op: 'set',
          key: 'device:lookup:mac:de-ad-be-ef-00-01',
          value: DEVICE_UUID,
        }),
      );
    });

    it('reads the zone eastWestNetworkType into location_network_type', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());
      prisma.zone.findUnique.mockResolvedValue({ eastWestNetworkType: 'ROCE' });

      await publisher.writeForDevice(DEVICE_UUID);

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.location_network_type).toBe('roce');
    });

    it('flags is_vpc true when the device zone networkType is VPC', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ zone: { networkType: 'VPC' } }));
      prisma.zone.findUnique.mockResolvedValue({ eastWestNetworkType: 'ROCE' });

      await publisher.writeForDevice(DEVICE_UUID);

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.is_vpc).toBe(true);
      expect(value.location_network_type).toBe('roce');
    });

    it('keeps is_vpc false when the device zone networkType is not VPC', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ zone: { networkType: 'FLAT' } }));

      await publisher.writeForDevice(DEVICE_UUID);

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.is_vpc).toBe(false);
    });

    it('emits empty platform_tags and installed_os/rescue_os from the active deployment', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());
      prisma.deployment.findFirst.mockResolvedValueOnce({
        baseLayer: { slug: 'ubuntu-24.04' },
        rescueLayer: { slug: 'brokkr-discovery' },
      });

      await publisher.writeForDevice(DEVICE_UUID);

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.platform_tags).toEqual([]);
      expect(value.installed_os).toBe('ubuntu-24.04');
      expect(value.rescue_os).toBe('brokkr-discovery');
    });

    it('leaves rescue_os null when the deployment has no rescue OS', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());
      prisma.deployment.findFirst.mockResolvedValueOnce({
        baseLayer: { slug: 'ubuntu-24.04' },
        rescueLayer: null,
      });

      await publisher.writeForDevice(DEVICE_UUID);

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.installed_os).toBe('ubuntu-24.04');
      expect(value.rescue_os).toBeNull();
    });

    it('null installed_os/rescue_os + empty tags when there is no active deployment', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());

      await publisher.writeForDevice(DEVICE_UUID);

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.installed_os).toBeNull();
      expect(value.rescue_os).toBeNull();
      expect(value.platform_tags).toEqual([]);
      expect(atomWriter.writeAtomJson).toHaveBeenCalledOnce();
    });

    it('still DELs the data atom for an unmonitored role when the record write loses the stale race', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.VM }));
      atomWriter.writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: false, reason: 'stale' });
      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(ops).toEqual([{ op: 'del', key: `device:${DEVICE_UUID}:data` }]);
    });

    it('does not overwrite the data atom for a monitored role on a stale-race skip (newer publish owns it)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Server }));
      atomWriter.writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

      await publisher.writeForDevice(DEVICE_UUID);

      expect(atomWriter.writeMulti).not.toHaveBeenCalled();
    });

    it('skips pointer rotation when the record write is stale (written=false)', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow());
      atomWriter.writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: false, reason: 'stale' });
      expect(atomWriter.writeAtomJson).toHaveBeenCalledTimes(1);
      expect(atomWriter.watchAndExecMulti).not.toHaveBeenCalled();
    });

    it('returns { written: false, reason: "role-not-published" } for a non-allow-listed role', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ role: DeviceRole.Switch }));

      const result = await publisher.writeForDevice(DEVICE_UUID);

      expect(result).toEqual({ written: false, reason: 'role-not-published' });
      expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the device is missing', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(null);
      await expect(publisher.writeForDevice(DEVICE_UUID)).rejects.toThrow(/not found/i);
      expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the device has no zoneId', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(makeDeviceRow({ zoneId: null }));
      await expect(publisher.writeForDevice(DEVICE_UUID)).rejects.toThrow(/not assigned to a zone/i);
    });
  });

  describe('syncDeviceDataBatch / purgeDeviceData', () => {
    it('batches mixed set/del ops into a single writeMulti transaction and reports counts', async () => {
      const outcome = await publisher.syncDeviceDataBatch(ZONE_ID, [
        { id: 'pdu-1', role: DeviceRole.PDU, deviceModel: null, interfaces: [] },
        { id: 'vm-1', role: DeviceRole.VM, deviceModel: null, interfaces: [] },
      ]);

      expect(outcome).toEqual({ written: 1, deleted: 1 });
      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [zone, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      expect(ops).toEqual([
        expect.objectContaining({ op: 'set', key: 'device:pdu-1:data' }),
        { op: 'del', key: 'device:vm-1:data' },
      ]);
    });

    it('is a no-op for empty inputs', async () => {
      expect(await publisher.syncDeviceDataBatch(ZONE_ID, [])).toEqual({ written: 0, deleted: 0 });
      await publisher.purgeDeviceData(ZONE_ID, []);
      expect(atomWriter.writeMulti).not.toHaveBeenCalled();
    });

    it('purgeDeviceData DELs each device data atom in one transaction', async () => {
      await publisher.purgeDeviceData(ZONE_ID, ['dead-1', 'dead-2']);

      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [zone, ops] = atomWriter.writeMulti.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      expect(ops).toEqual([
        { op: 'del', key: 'device:dead-1:data' },
        { op: 'del', key: 'device:dead-2:data' },
      ]);
    });
  });

  describe('writePlaceholder', () => {
    it('writes an envelope-wrapped record under the deterministic placeholder id with placeholder TTL', async () => {
      const bundle = { mac: 'aa:bb:cc:dd:ee:ff' };
      const { id, result } = await publisher.writePlaceholder(bundle, {
        buildarch: 'amd64-x86_64',
        zoneId: ZONE_ID,
        requestId: 'req-1',
      });

      expect(id).toBe(placeholderIdFromBundle(bundle));
      expect(result).toEqual({ written: true });

      const [zone, key, value, schema, ttl, opts] = atomWriter.writeAtomJson.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      expect(key).toBe(`device:${id}:device_record`);
      expect(schema).toBe(DeviceRecordSchema);
      expect(ttl).toBe(TTL_PLACEHOLDER_DEVICE_RECORD_SECONDS);
      expect(opts).toEqual({ request_id: 'req-1' });
      expect(value.id).toBe(id);
      expect(value.is_placeholder).toBe(true);
      expect(value.buildarch).toBe('amd64-x86_64');
      expect(value.status).toBeNull();
      expect(value).not.toHaveProperty('tenant_id');
      expect(value).not.toHaveProperty('site_id');
      expect(value).not.toHaveProperty('location_id');
      expect(value.location_network_type).toBeNull();
      expect(value.is_vpc).toBe(false);
    });

    it('produces a placeholder that passes the real DeviceRecordSchema with no dropped required fields', async () => {
      await publisher.writePlaceholder(
        { mac: 'aa:bb:cc:dd:ee:ff' },
        { buildarch: 'amd64-x86_64', zoneId: ZONE_ID, requestId: 'req-1' },
      );

      const value = atomWriter.writeAtomJson.mock.calls[0][2];
      expect(value.serial_baud_recommended).toBeNull();
      expect(DeviceRecordSchema.safeParse(value).success).toBe(true);
    });

    it('writes pointers with the placeholder TTL so they expire alongside the record', async () => {
      await publisher.writePlaceholder({ mac: 'aa:bb:cc:dd:ee:ff' }, { buildarch: null, zoneId: ZONE_ID });

      const pointerSets = lastMutatorResult!.extraOps.filter((o) => o.op === 'set');
      expect(pointerSets).toHaveLength(1);
      expect(pointerSets[0].ttl).toBe(TTL_PLACEHOLDER_DEVICE_RECORD_SECONDS);
    });

    it('throws BadRequestException when the bundle has no identifiers', async () => {
      await expect(publisher.writePlaceholder({}, { buildarch: null, zoneId: ZONE_ID })).rejects.toThrow(
        /at least one identifier/i,
      );
      expect(atomWriter.writeAtomJson).not.toHaveBeenCalled();
    });

    it('surfaces a stale skip: warns and returns { written: false } without logging success', async () => {
      atomWriter.writeAtomJson.mockResolvedValueOnce({ written: false, reason: 'stale' });

      const bundle = { mac: 'aa:bb:cc:dd:ee:ff' };
      const { id, result } = await publisher.writePlaceholder(bundle, { buildarch: null, zoneId: ZONE_ID });

      expect(id).toBe(placeholderIdFromBundle(bundle));
      expect(result).toEqual({ written: false, reason: 'stale' });
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/SKIPPED placeholder device_record/i));
      expect(logger.log).not.toHaveBeenCalledWith(expect.stringMatching(/Wrote placeholder device_record/i));
    });
  });

  describe('delete', () => {
    it('deletes record + tracking key + all tracked pointers via writeMulti', async () => {
      prisma.device.findUnique.mockResolvedValueOnce({
        id: DEVICE_UUID,
        zoneId: ZONE_ID,
        serial: 'SN-100',
        systemUuid: null,
        chassisSerial: null,
        baseboardSerial: null,
        interfaces: [{ macAddress: 'aa:bb:cc:dd:ee:ff', mgmtOnly: false }],
      });
      atomWriter.readJson.mockResolvedValueOnce([
        'device:lookup:mac:aa-bb-cc-dd-ee-ff',
        'device:lookup:mac:old-old-old-old-old-old',
      ]);

      await publisher.delete(DEVICE_UUID);

      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [zone, operations] = atomWriter.writeMulti.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      const keys = operations.map((o: { key: string }) => o.key);
      expect(keys).toContain(`device:${DEVICE_UUID}:device_record`);
      expect(keys).toContain(`device:${DEVICE_UUID}:data`);
      expect(keys).toContain(`device:${DEVICE_UUID}:pointers`);
      expect(keys).toContain('device:lookup:mac:aa-bb-cc-dd-ee-ff');
      expect(keys).toContain('device:lookup:mac:old-old-old-old-old-old');
      expect(keys).toContain('device:lookup:serial:sn-100');
    });

    it('tolerates a corrupt tracking key and falls back to identifier-derived pointers', async () => {
      prisma.device.findUnique.mockResolvedValueOnce({
        id: DEVICE_UUID,
        zoneId: ZONE_ID,
        serial: null,
        systemUuid: null,
        chassisSerial: null,
        baseboardSerial: null,
        interfaces: [{ macAddress: 'aa:bb:cc:dd:ee:ff', mgmtOnly: false }],
      });
      atomWriter.readJson.mockRejectedValueOnce(new Error('malformed'));

      await publisher.delete(DEVICE_UUID);

      const [, operations] = atomWriter.writeMulti.mock.calls[0];
      const keys = operations.map((o: { key: string }) => o.key);
      expect(keys).toContain('device:lookup:mac:aa-bb-cc-dd-ee-ff');
      expect(keys).toContain(`device:${DEVICE_UUID}:device_record`);
      expect(keys).toContain(`device:${DEVICE_UUID}:pointers`);
    });

    it('tears down a soft-deleted (tombstoned) row — the deletedAt filter must NOT exclude it', async () => {
      prisma.device.findUnique.mockResolvedValueOnce({
        id: DEVICE_UUID,
        zoneId: ZONE_ID,
        serial: 'SN-100',
        systemUuid: null,
        chassisSerial: null,
        baseboardSerial: null,
        deletedAt: new Date(),
        interfaces: [{ macAddress: 'aa:bb:cc:dd:ee:ff', mgmtOnly: false }],
      });
      atomWriter.readJson.mockResolvedValueOnce(['device:lookup:mac:aa-bb-cc-dd-ee-ff']);

      await publisher.delete(DEVICE_UUID);

      const where = prisma.device.findUnique.mock.calls[0][0].where;
      expect(where).toEqual({ id: DEVICE_UUID });
      expect(atomWriter.writeMulti).toHaveBeenCalledTimes(1);
      const [zone, operations] = atomWriter.writeMulti.mock.calls[0];
      expect(zone).toBe(ZONE_ID);
      const keys = operations.map((o: { key: string }) => o.key);
      expect(keys).toContain(`device:${DEVICE_UUID}:device_record`);
      expect(keys).toContain(`device:${DEVICE_UUID}:pointers`);
      expect(keys).toContain('device:lookup:mac:aa-bb-cc-dd-ee-ff');
    });

    it('is a logged no-op (does not throw) when the device row is absent', async () => {
      prisma.device.findUnique.mockResolvedValueOnce(null);

      await expect(publisher.delete(DEVICE_UUID)).resolves.toBeUndefined();

      expect(atomWriter.writeMulti).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('row not found'));
    });

    it('is a logged no-op (does not throw) for a zoneless device — no zone-prefixed atoms exist', async () => {
      prisma.device.findUnique.mockResolvedValueOnce({
        id: DEVICE_UUID,
        zoneId: null,
        macAddress: 'aa:bb:cc:dd:ee:ff',
        mgmtMac: null,
        serial: 'SN-100',
        systemUuid: null,
        chassisSerial: null,
        baseboardSerial: null,
        interfaces: [],
      });

      await expect(publisher.delete(DEVICE_UUID)).resolves.toBeUndefined();

      expect(atomWriter.writeMulti).not.toHaveBeenCalled();
      expect(atomWriter.readJson).not.toHaveBeenCalled();
      expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('no zone assigned'));
    });
  });
});
