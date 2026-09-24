import { Module } from '@nestjs/common';

import { BrokkrLiveReadinessServiceFactory } from '../brokkr-live/brokkr-live-readiness.service';
import { BrokkrLiveModule } from '../brokkr-live/brokkr-live.module';
import { ContextLogger } from '../logger/logger.service';

import {
  disableOsBootOptions,
  disableTee,
  enableTee,
  redfishStandardize,
  verifyTee,
} from '../lifecycle-deploy/redfish-operations.js';
import { RedfishBootHandler, RedfishDevice, RedfishDiscoveryHandler, RedfishTeeHandler } from '../redfish/index.js';

import { RedisService } from '../common/redis/redis.service';

import { performIpmiWithRetry } from '../lifecycle-deploy/ipmi-operations';
import { getCipherForDevice, resolveCipher } from './ipmi/cipher';
import { createIpmiDevice, withCipher, type IPMIDevice as AdapterIpmiDevice } from './ipmi/device';
import { mcReset } from './ipmi/handlers/mc';
import { getBootParam, power, powerStatus } from './ipmi/handlers/power';
import { ipmiPing, ipmiPingWithRetry } from './ipmi/ping';
import { repairLanplusAccess } from './ipmi/rmcp-plus';
import {
  PowerManagementServiceFactory,
  type IpmiDeviceLike,
  type PowerManagementDeps,
} from './power/power-management.service';
import { createRedfishService } from './redfish.service';
import { DisableOsBootStep } from './redfish/steps/disable-os-boot.step';
import { RedfishStandardizeStep } from './redfish/steps/redfish-standardize.step';
import { TeeConfigStep } from './redfish/steps/tee-config.step';
import { SolProvisioningServiceFactory } from './sol/sol-provisioning.factory';
import { SolServiceFactory } from './sol/sol.factory';
import { DeactivateSolStep } from './sol/steps/deactivate-sol.step';
import { EnsureSolEnabledStep } from './sol/steps/ensure-sol-enabled.step';
import { SolActivationStep } from './sol/steps/sol-activation.step';
import { SolMonitorStep } from './sol/steps/sol-monitor.step';
import { EnsureLanplusAccessStep } from './steps/ensure-lanplus-access.step';
import { PcBmcResetColdStep } from './steps/pc-bmc-reset-cold.step';
import { PcPowerOffStep } from './steps/pc-power-off.step';
import { PcPowerOnStep } from './steps/pc-power-on.step';
import { PcSetBootDeviceStep } from './steps/pc-set-boot-device.step';
import { PcValidateIpmiStep } from './steps/pc-validate-ipmi.step';
import { PcVerifyBmcRecoveryStep } from './steps/pc-verify-bmc-recovery.step';
import { PcVerifyBootDeviceStep } from './steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from './steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from './steps/pc-verify-power-on.step';
import { PcWaitForOsStep } from './steps/pc-wait-for-os.step';
import { RedfishCommandStep } from './steps/redfish-command.step';

class AdapterIpmiDeviceLike implements IpmiDeviceLike {
  constructor(private readonly device: AdapterIpmiDevice) {}
  get ip(): string {
    return this.device.ip;
  }
  get username(): string {
    return this.device.username;
  }
  get password(): string {
    return this.device.password;
  }
  get raw(): AdapterIpmiDevice {
    return this.device;
  }
  withCipher(cipher: string | null): AdapterIpmiDeviceLike {
    return new AdapterIpmiDeviceLike(withCipher(this.device, cipher));
  }
}

function unwrapDevice(device: IpmiDeviceLike): AdapterIpmiDevice {
  if (device instanceof AdapterIpmiDeviceLike) return device.raw;
  return createIpmiDevice({ ip: device.ip, username: device.username, password: device.password });
}

function toResultLike(result: { ok: boolean; stdout: string; stderr: string }): {
  ok: boolean;
  stdout: string;
  stderr: string;
  error: string;
} {
  return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, error: result.stderr };
}

export function buildPowerManagementDeps(redis: RedisService, logger: ContextLogger): PowerManagementDeps {
  const redisClient = redis.connection;
  return {
    deviceFactory: {
      create: (args) =>
        new AdapterIpmiDeviceLike(
          createIpmiDevice({ ip: args.ip, username: args.username, password: args.password, jobId: args.jobId }),
        ),
    },
    cipherResolver: {
      resolveCipher: async (device, deviceId) => {
        const { found, cipher } = await resolveCipher(redisClient, unwrapDevice(device), deviceId);
        return [found, cipher];
      },
    },
    pinger: {
      ping: (bmcIp, opts) => ipmiPing(bmcIp, { jobId: opts.jobId }),
      pingWithRetry: (bmcIp, opts) => ipmiPingWithRetry(bmcIp, { jobId: opts.jobId }),
    },
    powerHandlers: {
      power: async (device, operation) => toResultLike(await power(unwrapDevice(device), operation)),
      powerStatus: async (device) => (await powerStatus(unwrapDevice(device))) ?? 'unknown',
      getBootParam: async (device, paramId) => toResultLike(await getBootParam(unwrapDevice(device), paramId)),
    },
    retry: {
      performIpmiWithRetry: (device, operation, jobId, opts) =>
        performIpmiWithRetry(unwrapDevice(device), operation, jobId, opts.maxRetries, {
          uefi: opts.uefi,
          persistent: opts.persistent,
        }),
    },
    logger: {
      info: (message, context) => logger.info(message, context),
      warning: (message, context) => logger.warning(message, context),
      error: (message, context) => logger.error(message, context),
    },
    sleeper: {
      sleep: (seconds) => new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000)),
    },
    clock: {
      monotonic: () => Number(process.hrtime.bigint()) / 1e9,
    },
  };
}

const redfishOpsDeps = {
  createRedfishService: async (jobId: string) => ({
    reliableBoot: async (device: RedfishDevice): Promise<void> => {
      const handler = new RedfishBootHandler(device, device.jobId ?? jobId);
      await handler.discover();
      await handler.reliableBoot();
    },
    setTee: async (device: RedfishDevice, newSetting: boolean): Promise<boolean> => {
      const handler = new RedfishTeeHandler(device, device.jobId ?? jobId);
      await handler.discover();
      return handler.setTee(newSetting);
    },
    verifyTee: async (device: RedfishDevice) => {
      const handler = new RedfishTeeHandler(device, device.jobId ?? jobId);
      await handler.discover();
      return handler.verifyTee();
    },
  }),
};

const redfishOpsForDisableOsBoot = {
  disableOsBootOptions: (deviceId: string, bmcIp: string, username: string, password: string, jobId: string) =>
    disableOsBootOptions(deviceId, bmcIp, username, password, jobId, redfishOpsDeps),
};

const redfishOpsForStandardize = {
  redfishStandardize: (deviceId: string, bmcIp: string, username: string, password: string, jobId: string) =>
    redfishStandardize(deviceId, bmcIp, username, password, jobId, redfishOpsDeps),
};

const redfishOpsForTee = {
  enableTee: (deviceId: string, bmcIp: string, username: string, password: string, jobId: string) =>
    enableTee(deviceId, bmcIp, username, password, jobId, redfishOpsDeps),
  disableTee: (deviceId: string, bmcIp: string, username: string, password: string, jobId: string) =>
    disableTee(deviceId, bmcIp, username, password, jobId, redfishOpsDeps),
  verifyTee: (deviceId: string, bmcIp: string, username: string, password: string, jobId: string) =>
    verifyTee(deviceId, bmcIp, username, password, jobId, redfishOpsDeps),
};

const redfishCommandFactory = {
  create: async ({ jobId }: { jobId: string }) =>
    createRedfishService(jobId, {
      bootHandlerFactory: (device, handlerJobId) => new RedfishBootHandler(device, handlerJobId),
      discoveryHandlerFactory: (device, handlerJobId) => new RedfishDiscoveryHandler(device, handlerJobId),
      teeHandlerFactory: (device, handlerJobId) => new RedfishTeeHandler(device, handlerJobId),
    }),
};

const ipmiDeviceFactory = {
  create: (args: { ip: string; username: string; password: string; port: number; jobId: string }) =>
    createIpmiDevice({
      ip: args.ip,
      username: args.username,
      password: args.password,
      port: args.port,
      jobId: args.jobId,
    }),
  withCipher: (device: AdapterIpmiDevice, cipher: string | null) => withCipher(device, cipher),
};

const ipmiPinger = {
  pingWithRetry: (bmcIp: string, port: number, opts: { jobId: string }) =>
    ipmiPingWithRetry(bmcIp, { port, jobId: opts.jobId }),
};

function buildCipherResolver(redis: RedisService): {
  getCipherForDevice(device: AdapterIpmiDevice, deviceId: string | null): Promise<string | null>;
} {
  const redisClient = redis.connection;
  return {
    getCipherForDevice: (device, deviceId) => getCipherForDevice(redisClient, device, deviceId),
  };
}

const mcHandlers = {
  mcReset: async (device: AdapterIpmiDevice, mode: string) => {
    const result = await mcReset(device, mode);
    return { ok: result.ok, stdout: result.stdout, stderr: result.stderr, error: result.stderr };
  },
};

const sleeperShim = {
  sleep: async (seconds: number) => {
    await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
  },
};

const lanplusRepair = {
  repair: (device: AdapterIpmiDevice, opts: { channel: number }) =>
    repairLanplusAccess(device, { channel: opts.channel }),
};

@Module({
  imports: [BrokkrLiveModule],
  providers: [
    SolProvisioningServiceFactory,
    SolServiceFactory,
    {
      provide: PowerManagementServiceFactory,
      useFactory: (redis: RedisService, logger: ContextLogger) =>
        new PowerManagementServiceFactory(buildPowerManagementDeps(redis, logger)),
      inject: [RedisService, ContextLogger],
    },
    {
      provide: DisableOsBootStep,
      useFactory: () => new DisableOsBootStep(redfishOpsForDisableOsBoot),
    },
    {
      provide: RedfishStandardizeStep,
      useFactory: () => new RedfishStandardizeStep(redfishOpsForStandardize),
    },
    {
      provide: TeeConfigStep,
      useFactory: (logger: ContextLogger) => new TeeConfigStep(redfishOpsForTee, logger),
      inject: [ContextLogger],
    },
    {
      provide: DeactivateSolStep,
      useFactory: (factory: SolServiceFactory) => new DeactivateSolStep(factory),
      inject: [SolServiceFactory],
    },
    {
      provide: EnsureSolEnabledStep,
      useFactory: (factory: SolProvisioningServiceFactory, logger: ContextLogger) =>
        new EnsureSolEnabledStep(factory, logger),
      inject: [SolProvisioningServiceFactory, ContextLogger],
    },
    {
      provide: SolActivationStep,
      useFactory: (factory: SolServiceFactory, logger: ContextLogger) => new SolActivationStep(factory, logger),
      inject: [SolServiceFactory, ContextLogger],
    },
    {
      provide: SolMonitorStep,
      useFactory: (factory: SolServiceFactory) => new SolMonitorStep(factory),
      inject: [SolServiceFactory],
    },
    {
      provide: EnsureLanplusAccessStep,
      useFactory: (logger: ContextLogger) => new EnsureLanplusAccessStep(ipmiDeviceFactory, lanplusRepair, logger),
      inject: [ContextLogger],
    },
    {
      provide: PcBmcResetColdStep,
      useFactory: (redis: RedisService, logger: ContextLogger) =>
        new PcBmcResetColdStep(
          ipmiDeviceFactory,
          ipmiPinger,
          buildCipherResolver(redis),
          mcHandlers,
          logger,
          sleeperShim,
        ),
      inject: [RedisService, ContextLogger],
    },
    {
      provide: PcPowerOffStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcPowerOffStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcPowerOnStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcPowerOnStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcSetBootDeviceStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcSetBootDeviceStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcValidateIpmiStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcValidateIpmiStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcVerifyBmcRecoveryStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcVerifyBmcRecoveryStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcVerifyBootDeviceStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcVerifyBootDeviceStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcVerifyPowerOffStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcVerifyPowerOffStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcVerifyPowerOnStep,
      useFactory: (factory: PowerManagementServiceFactory) => new PcVerifyPowerOnStep(factory),
      inject: [PowerManagementServiceFactory],
    },
    {
      provide: PcWaitForOsStep,
      useFactory: (factory: BrokkrLiveReadinessServiceFactory, logger: ContextLogger) =>
        new PcWaitForOsStep(factory, logger),
      inject: [BrokkrLiveReadinessServiceFactory, ContextLogger],
    },
    {
      provide: RedfishCommandStep,
      useFactory: (logger: ContextLogger) => new RedfishCommandStep(redfishCommandFactory, logger),
      inject: [ContextLogger],
    },
  ],
  exports: [
    DisableOsBootStep,
    RedfishStandardizeStep,
    TeeConfigStep,
    DeactivateSolStep,
    EnsureSolEnabledStep,
    SolActivationStep,
    SolMonitorStep,
    EnsureLanplusAccessStep,
    PcBmcResetColdStep,
    PcPowerOffStep,
    PcPowerOnStep,
    PcSetBootDeviceStep,
    PcValidateIpmiStep,
    PcVerifyBmcRecoveryStep,
    PcVerifyBootDeviceStep,
    PcVerifyPowerOffStep,
    PcVerifyPowerOnStep,
    PcWaitForOsStep,
    RedfishCommandStep,
    PowerManagementServiceFactory,
    SolProvisioningServiceFactory,
    SolServiceFactory,
  ],
})
export class OobModule {}
