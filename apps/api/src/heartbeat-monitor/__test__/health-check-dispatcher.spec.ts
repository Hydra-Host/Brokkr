import { ConflictException, NotFoundException } from '@nestjs/common';
import { DeviceRole, ServerLifecycleStatus } from '@repo/database';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_CHECK_ELIGIBLE_WHERE } from '../device-health-check.dispatch';
import { HealthCheckDispatcher } from '../health-check-dispatcher';

const DEVICE = '22222222-2222-2222-2222-222222222222';
const ZONE = '11111111-1111-1111-1111-111111111111';
const ELIGIBLE_WHERE = { id: DEVICE, ...HEALTH_CHECK_ELIGIBLE_WHERE };
const BY_ID_WHERE = { id: DEVICE, deletedAt: null };

interface RequestDevice {
  id: string;
  zoneId: string | null;
  role: DeviceRole;
  networkType: null;
  server: { lifecycleStatus: ServerLifecycleStatus } | null;
  interfaces: { mgmtOnly: boolean; ipAddresses: { address: string }[] }[];
}

const eligibleDevice: RequestDevice = {
  id: DEVICE,
  zoneId: ZONE,
  role: DeviceRole.Server,
  networkType: null,
  server: { lifecycleStatus: ServerLifecycleStatus.PROVISIONED },
  interfaces: [{ mgmtOnly: true, ipAddresses: [{ address: '10.40.0.17' }] }],
};

function setup(
  opts: {
    device?: Partial<RequestDevice> | null;
    eligible?: boolean;
    claimed?: 'OK' | null;
    latest?: { bmcCredsValid: boolean | null; testedAt: Date } | null;
  } = {},
) {
  const device = opts.device === null ? null : { ...eligibleDevice, ...opts.device };
  const eligible = opts.eligible === false ? null : device;
  const prisma = {
    device: { findUnique: vi.fn().mockResolvedValueOnce(eligible).mockResolvedValueOnce(device) },
    deviceHealthCheck: { findFirst: vi.fn().mockResolvedValue(opts.latest ?? null) },
  };
  const redis = { set: vi.fn().mockResolvedValue(opts.claimed === undefined ? 'OK' : opts.claimed) };
  const deviceContext = {
    resolveFromDevice: vi.fn().mockResolvedValue({ bmcIp: '10.40.0.17', bmcSecret: { sealed: true } }),
  };
  const bridgeQueue = { enqueueSagaJob: vi.fn().mockResolvedValue(undefined) };
  const contextService = { buildAuditPayload: vi.fn().mockReturnValue({ triggeredBy: 'user:1' }) };
  const logger = { log: vi.fn() };
  const pin = vi.spyOn(BaremetalRecord, 'findByDeviceIdOrThrow');
  const dispatcher = new HealthCheckDispatcher(
    prisma as never,
    redis,
    deviceContext,
    bridgeQueue,
    contextService,
    logger,
  );
  return { dispatcher, bridgeQueue, logger, pin, prisma };
}

describe('HealthCheckDispatcher.dispatch', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enqueues the saga and writes the audit line without pinning the device to a tenant', async () => {
    const { dispatcher, bridgeQueue, logger, pin, prisma } = setup();
    const out = await dispatcher.dispatch(DEVICE);
    expect(pin).not.toHaveBeenCalled();
    expect(prisma.device.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.device.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: ELIGIBLE_WHERE }));
    expect(bridgeQueue.enqueueSagaJob).toHaveBeenCalledWith(
      ZONE,
      'device_health_check',
      out.jobId,
      expect.objectContaining({ device_id: DEVICE, bmc_ip: '10.40.0.17' }),
      DEVICE,
      expect.objectContaining({ coalesceKey: `health-cron-${DEVICE}` }),
    );
    expect(logger.log).toHaveBeenCalledWith(`Health check requested: device=${DEVICE} job=${out.jobId} actor=user:1`);
  });

  it('404s when the device row is gone', async () => {
    const { dispatcher, prisma } = setup({ device: null });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.device.findUnique).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: ELIGIBLE_WHERE }));
    expect(prisma.device.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: BY_ID_WHERE }));
  });

  it('rejects an offline device with 400 naming the status', async () => {
    const { dispatcher, bridgeQueue, prisma } = setup({
      eligible: false,
      device: { server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } },
    });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toMatchObject({
      status: 400,
      message: 'This device is offline, so the bridge cannot probe it',
    });
    expect(prisma.device.findUnique).toHaveBeenNthCalledWith(1, expect.objectContaining({ where: ELIGIBLE_WHERE }));
    expect(prisma.device.findUnique).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: BY_ID_WHERE }));
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });

  it('rejects a non-server role with 400 naming the role', async () => {
    const { dispatcher } = setup({ eligible: false, device: { role: DeviceRole.Switch } });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toMatchObject({
      status: 400,
      message: 'This device has the Switch role; only servers are probed',
    });
  });

  it('rejects a device without a management address with 400', async () => {
    const { dispatcher } = setup({
      eligible: false,
      device: { interfaces: [{ mgmtOnly: false, ipAddresses: [{ address: '10.40.0.17' }] }] },
    });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toMatchObject({
      status: 400,
      message: 'This device has no management interface address, so the bridge cannot probe it',
    });
  });

  it('rejects a device the where excludes for a reason no clause names with a generic 400', async () => {
    const { dispatcher, bridgeQueue } = setup({ eligible: false });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toMatchObject({
      status: 400,
      message: 'This device is not eligible for a bridge health check',
    });
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });

  it('rejects an eligible device without a zone with 400', async () => {
    const { dispatcher, prisma } = setup({ device: { zoneId: null } });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toMatchObject({
      status: 400,
      message: 'This device is not assigned to a zone, so no bridge can probe it',
    });
    expect(prisma.device.findUnique).toHaveBeenCalledTimes(1);
  });

  it('refuses with 409 while the last credential check failed', async () => {
    const { dispatcher, bridgeQueue } = setup({
      latest: { bmcCredsValid: false, testedAt: new Date('2026-09-16T11:21:00.000Z') },
    });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toBeInstanceOf(ConflictException);
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });

  it('refuses with 429 inside the cron interval before touching the bridge', async () => {
    const { dispatcher, bridgeQueue } = setup({ claimed: null });
    await expect(dispatcher.dispatch(DEVICE)).rejects.toMatchObject({ status: 429 });
    expect(bridgeQueue.enqueueSagaJob).not.toHaveBeenCalled();
  });
});
