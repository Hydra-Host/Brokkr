import { Module, type OnModuleInit } from '@nestjs/common';

import { Dispatcher } from '../agent/dispatch/dispatcher.service';
import { ATOM_FETCHER, type AtomFetcher } from '../bridge-network/netplan-atom.service';
import { BrokkrLiveModule } from '../brokkr-live/brokkr-live.module';
import { BrokkrLiveCheckStep } from '../brokkr-live/steps/brokkr-live-check.step';
import { CollectionModule } from '../collection/collection.module';
import { WaitForBrokkrLiveStep } from '../collection/steps/wait-for-brokkr-live.step';
import { RedisService } from '../common/redis/redis.service';
import { readAtom as readAtomFromCache } from '../device-record/atom/atom-fetcher.js';
import { NetplanAtomService } from '../device-record/netplan/netplan-atom.service';
import { createDeviceService } from '../devices/device.service.js';
import { createDeployOrchestrationService } from '../lifecycle-deploy/deploy-orchestration.service.js';
import { LifecycleDeployModule } from '../lifecycle-deploy/lifecycle-deploy.module.js';
import { WaitForAgentSessionStep } from '../lifecycle-deploy/steps/wait-for-agent-session.step';
import { WipeDisksStep } from '../lifecycle-deploy/steps/wipe-disks.step';
import { ContextLogger } from '../logger/logger.service';
import { OobModule } from '../oob/oob.module';
import { DisableOsBootStep } from '../oob/redfish/steps/disable-os-boot.step';
import { TeeConfigStep } from '../oob/redfish/steps/tee-config.step';
import { EnsureSolEnabledStep } from '../oob/sol/steps/ensure-sol-enabled.step';
import { SolActivationStep } from '../oob/sol/steps/sol-activation.step';
import { PcPowerOffStep } from '../oob/steps/pc-power-off.step';
import { PcPowerOnStep } from '../oob/steps/pc-power-on.step';
import { PcSetBootDeviceStep } from '../oob/steps/pc-set-boot-device.step';
import { PcVerifyBootDeviceStep } from '../oob/steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from '../oob/steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from '../oob/steps/pc-verify-power-on.step';
import { registerSagaDef } from '../saga-framework/saga-registry';

import { buildProvisionSaga } from './provision.workflow';
import { ArmCustomIpxeBootStep } from './steps/arm-custom-ipxe-boot.step';
import { DeployOsStep } from './steps/deploy-os.step';
import { DisarmCustomIpxeBootStep } from './steps/disarm-custom-ipxe-boot.step';
import { PrepareStorageStep } from './steps/prepare-storage.step';
import { ProvisionCompleteStep } from './steps/provision-complete.step';
import { ResolveDeployTargetStep } from './steps/resolve-deploy-target.step';

function buildDeployFactory(
  dispatcher: Dispatcher,
  redis: RedisService,
  atomFetcher: AtomFetcher,
  netplanAtom: NetplanAtomService,
): {
  create: (
    jobId: string,
    options?: { signal?: AbortSignal; workId?: string },
  ) => Promise<ReturnType<typeof createDeployOrchestrationService> extends Promise<infer T> ? T : never>;
} {
  const atomFetcherLike = {
    getAtom: atomFetcher.getAtom.bind(atomFetcher),
    readAtom: <T>(key: string, valueSchema: Parameters<typeof readAtomFromCache<T>>[2], jobId?: string) =>
      readAtomFromCache(redis, key, valueSchema, { jobId }),
  };
  return {
    create: async (jobId: string, sagaOptions?: { signal?: AbortSignal; workId?: string }) => {
      let dispatchIndex = 0;
      const deviceService = await createDeviceService(jobId, {
        cache: redis,
        atomFetcher: atomFetcherLike,
        getLiveNetplan: (id, netplanJobId) => netplanAtom.getLiveNetplan(id, { jobId: netplanJobId }),
      });
      return createDeployOrchestrationService(jobId, {
        normalizeNetplanYaml: (netplanYaml) => deviceService.normalizeNetplanYaml(netplanYaml),
        dispatch: (deviceId, operation, input, options) =>
          dispatcher.dispatchTyped(deviceId, operation, input, {
            jobId: options?.jobId ?? null,
            timeoutS: options?.timeoutS ?? null,
            signal: sagaOptions?.signal,
            workId: sagaOptions?.workId === undefined ? undefined : `${sagaOptions.workId}:${dispatchIndex++}`,
          }),
      });
    },
  };
}

@Module({
  imports: [OobModule, BrokkrLiveModule, CollectionModule, LifecycleDeployModule],
  providers: [
    {
      provide: ArmCustomIpxeBootStep,
      useFactory: (redis: RedisService) => new ArmCustomIpxeBootStep(redis),
      inject: [RedisService],
    },
    {
      provide: DisarmCustomIpxeBootStep,
      useFactory: (redis: RedisService) => new DisarmCustomIpxeBootStep(redis),
      inject: [RedisService],
    },
    {
      provide: DeployOsStep,
      useFactory: (
        dispatcher: Dispatcher,
        redis: RedisService,
        atomFetcher: AtomFetcher,
        netplanAtom: NetplanAtomService,
        logger: ContextLogger,
      ) => new DeployOsStep(buildDeployFactory(dispatcher, redis, atomFetcher, netplanAtom), logger),
      inject: [Dispatcher, RedisService, ATOM_FETCHER, NetplanAtomService, ContextLogger],
    },
    {
      provide: PrepareStorageStep,
      useFactory: (
        dispatcher: Dispatcher,
        redis: RedisService,
        atomFetcher: AtomFetcher,
        netplanAtom: NetplanAtomService,
      ) => new PrepareStorageStep(buildDeployFactory(dispatcher, redis, atomFetcher, netplanAtom)),
      inject: [Dispatcher, RedisService, ATOM_FETCHER, NetplanAtomService],
    },
    {
      provide: ProvisionCompleteStep,
      useFactory: (logger: ContextLogger) => new ProvisionCompleteStep(logger),
      inject: [ContextLogger],
    },
    {
      provide: ResolveDeployTargetStep,
      useFactory: (
        dispatcher: Dispatcher,
        redis: RedisService,
        atomFetcher: AtomFetcher,
        netplanAtom: NetplanAtomService,
        logger: ContextLogger,
      ) => new ResolveDeployTargetStep(buildDeployFactory(dispatcher, redis, atomFetcher, netplanAtom), logger),
      inject: [Dispatcher, RedisService, ATOM_FETCHER, NetplanAtomService, ContextLogger],
    },
  ],
  exports: [
    ArmCustomIpxeBootStep,
    DisarmCustomIpxeBootStep,
    DeployOsStep,
    PrepareStorageStep,
    ProvisionCompleteStep,
    ResolveDeployTargetStep,
  ],
})
export class ProvisionModule implements OnModuleInit {
  constructor(
    private readonly brokkrLiveCheck: BrokkrLiveCheckStep,
    private readonly pcPowerOff: PcPowerOffStep,
    private readonly pcVerifyPowerOff: PcVerifyPowerOffStep,
    private readonly pcSetBootDevice: PcSetBootDeviceStep,
    private readonly pcVerifyBootDevice: PcVerifyBootDeviceStep,
    private readonly pcPowerOn: PcPowerOnStep,
    private readonly pcVerifyPowerOn: PcVerifyPowerOnStep,
    private readonly waitForBrokkrLive: WaitForBrokkrLiveStep,
    private readonly disableOsBoot: DisableOsBootStep,
    private readonly teeConfig: TeeConfigStep,
    private readonly waitForAgentSession: WaitForAgentSessionStep,
    private readonly resolveDeployTarget: ResolveDeployTargetStep,
    private readonly wipeDisks: WipeDisksStep,
    private readonly prepareStorage: PrepareStorageStep,
    private readonly deployOs: DeployOsStep,
    private readonly armCustomIpxeBoot: ArmCustomIpxeBootStep,
    private readonly disarmCustomIpxeBoot: DisarmCustomIpxeBootStep,
    private readonly ensureSolEnabled: EnsureSolEnabledStep,
    private readonly solActivation: SolActivationStep,
    private readonly provisionComplete: ProvisionCompleteStep,
  ) {}

  onModuleInit(): void {
    registerSagaDef(
      buildProvisionSaga({
        disarmCustomIpxeBoot: this.disarmCustomIpxeBoot,
        brokkrLiveCheck: this.brokkrLiveCheck,
        pcPowerOff: this.pcPowerOff,
        pcVerifyPowerOff: this.pcVerifyPowerOff,
        pcSetBootDevice: this.pcSetBootDevice,
        pcVerifyBootDevice: this.pcVerifyBootDevice,
        pcPowerOn: this.pcPowerOn,
        pcVerifyPowerOn: this.pcVerifyPowerOn,
        waitForBrokkrLive: this.waitForBrokkrLive,
        disableOsBoot: this.disableOsBoot,
        teeConfig: this.teeConfig,
        waitForAgentSession: this.waitForAgentSession,
        resolveDeployTarget: this.resolveDeployTarget,
        wipeDisks: this.wipeDisks,
        prepareStorage: this.prepareStorage,
        deployOs: this.deployOs,
        armCustomIpxeBoot: this.armCustomIpxeBoot,
        ensureSolEnabled: this.ensureSolEnabled,
        solActivation: this.solActivation,
        provisionComplete: this.provisionComplete,
      }),
    );
  }
}
