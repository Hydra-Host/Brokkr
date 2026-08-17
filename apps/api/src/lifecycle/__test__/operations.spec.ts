import { Test } from '@nestjs/testing';
import { ServerPowerStatus } from '@repo/database';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PowerControlOperation } from '../operations/power-control.operation';
import { RebootOperation } from '../operations/reboot.operation';

describe('lifecycle dispatch operations', () => {
  const bridge = {
    rebootDevice: vi.fn().mockResolvedValue(undefined),
    powerOnDevice: vi.fn().mockResolvedValue(undefined),
    powerOffDevice: vi.fn().mockResolvedValue(undefined),
  };
  const prisma = { device: { update: vi.fn().mockResolvedValue({}) } };

  let reboot: RebootOperation;
  let power: PowerControlOperation;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        RebootOperation,
        PowerControlOperation,
        { provide: BridgePowerControlService, useValue: bridge },
        { provide: PrismaClient, useValue: prisma },
      ],
    }).compile();
    reboot = moduleRef.get(RebootOperation);
    power = moduleRef.get(PowerControlOperation);
  });

  it('reboot: sets Server.powerStatus Rebooting and enqueues the reboot saga keyed by job id', async () => {
    await reboot.dispatch('device-1', 'job-1');
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { powerStatus: ServerPowerStatus.Rebooting },
            update: { powerStatus: ServerPowerStatus.Rebooting },
          },
        },
      },
    });
    expect(bridge.rebootDevice).toHaveBeenCalledWith('device-1', 'job-1');
  });

  it('power on: sets Server.powerStatus PoweringOn and enqueues power_on', async () => {
    await power.dispatch('device-1', 'job-1', 'on');
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { powerStatus: ServerPowerStatus.PoweringOn },
            update: { powerStatus: ServerPowerStatus.PoweringOn },
          },
        },
      },
    });
    expect(bridge.powerOnDevice).toHaveBeenCalledWith('device-1', 'job-1');
    expect(bridge.powerOffDevice).not.toHaveBeenCalled();
  });

  it('power off: sets Server.powerStatus PoweringOff and enqueues power_off', async () => {
    await power.dispatch('device-1', 'job-1', 'off');
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { powerStatus: ServerPowerStatus.PoweringOff },
            update: { powerStatus: ServerPowerStatus.PoweringOff },
          },
        },
      },
    });
    expect(bridge.powerOffDevice).toHaveBeenCalledWith('device-1', 'job-1');
    expect(bridge.powerOnDevice).not.toHaveBeenCalled();
  });
});
