import { Module } from '@nestjs/common';

import { ConnectionRegistry } from '../agent/connection-registry/connection-registry.service.js';
import { Dispatcher } from '../agent/dispatch/dispatcher.service.js';
import { ContextLogger } from '../logger/logger.service.js';

import { CloudInitModule } from './cloud-init/cloud-init.module.js';
import { diskLayoutsForAgent } from './deploy-orchestration.service.js';
import {
  EFI_BOOT_DISPATCH,
  EFI_BOOT_SERVICE_FACTORY,
  EfiBootServiceFactory,
  type EfiBootDispatchFn,
} from './efi-boot.service.js';
import { WaitForAgentSessionStep } from './steps/wait-for-agent-session.step.js';
import { WipeDisksStep } from './steps/wipe-disks.step.js';

const efiBootDispatchProvider = {
  provide: EFI_BOOT_DISPATCH,
  useFactory:
    (dispatcher: Dispatcher): EfiBootDispatchFn =>
    (deviceId, operation, input, options) =>
      dispatcher.dispatchTyped(deviceId, operation, input, {
        jobId: options?.jobId ?? null,
        timeoutS: options?.timeoutS ?? null,
        signal: options?.signal,
        workId: options?.workId,
      }),
  inject: [Dispatcher],
};

const diskLayoutNormalizer = {
  diskLayoutsForAgent: (layouts: unknown) => diskLayoutsForAgent(layouts as readonly Record<string, unknown>[]),
};

@Module({
  imports: [CloudInitModule],
  providers: [
    efiBootDispatchProvider,
    EfiBootServiceFactory,
    { provide: EFI_BOOT_SERVICE_FACTORY, useExisting: EfiBootServiceFactory },
    {
      provide: WaitForAgentSessionStep,
      useFactory: (registry: ConnectionRegistry, logger: ContextLogger) =>
        new WaitForAgentSessionStep(registry, logger, {
          now: () => Number(process.hrtime.bigint()) / 1e9,
        }),
      inject: [ConnectionRegistry, ContextLogger],
    },
    {
      provide: WipeDisksStep,
      useFactory: (dispatcher: Dispatcher, efiBootFactory: EfiBootServiceFactory, logger: ContextLogger) =>
        new WipeDisksStep(
          dispatcher,
          diskLayoutNormalizer,
          efiBootFactory,
          { environment: process.env.BROKKR_ENVIRONMENT ?? process.env.ENVIRONMENT ?? 'prod' },
          logger,
        ),
      inject: [Dispatcher, EFI_BOOT_SERVICE_FACTORY, ContextLogger],
    },
  ],
  exports: [CloudInitModule, EfiBootServiceFactory, EFI_BOOT_SERVICE_FACTORY, WaitForAgentSessionStep, WipeDisksStep],
})
export class LifecycleDeployModule {}
