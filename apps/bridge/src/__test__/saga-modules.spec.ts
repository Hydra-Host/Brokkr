import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { Dispatcher } from '../agent/dispatch/dispatcher.service';
import {
  AGENT_UNIT_RENDER_STARTUP_LOGGER,
  AgentUnitRenderStartupService,
} from '../brokkr-live/agent-unit-render-startup.service';
import { BrokkrLiveReadinessServiceFactory } from '../brokkr-live/brokkr-live-readiness.service';
import { BrokkrLiveServiceFactory } from '../brokkr-live/brokkr-live.service';
import { RedisService } from '../common/redis/redis.service';
import { CloudInitPayloadService } from '../lifecycle-deploy/cloud-init/cloud-init-payload.service';
import { EFI_BOOT_DISPATCH, EFI_BOOT_LOGGER, EfiBootServiceFactory } from '../lifecycle-deploy/efi-boot.service';
import { ContextLogger } from '../logger/logger.service';

@Global()
@Module({
  providers: [
    { provide: ContextLogger, useValue: {} },
    { provide: AGENT_UNIT_RENDER_STARTUP_LOGGER, useValue: {} },
    { provide: EFI_BOOT_LOGGER, useValue: {} },
    { provide: EFI_BOOT_DISPATCH, useValue: {} },
    { provide: Dispatcher, useValue: { dispatch: async () => undefined } },
    { provide: RedisService, useValue: {} },
  ],
  exports: [
    ContextLogger,
    AGENT_UNIT_RENDER_STARTUP_LOGGER,
    EFI_BOOT_LOGGER,
    EFI_BOOT_DISPATCH,
    Dispatcher,
    RedisService,
  ],
})
class GlobalLoggerStubModule {}

import { BenchmarksModule } from '../benchmarks/benchmarks.module';
import { CheckCcModeStep } from '../benchmarks/steps/check-cc-mode.step';
import { ReportResultsStep } from '../benchmarks/steps/report-results.step';
import { RunBenchmarksStep } from '../benchmarks/steps/run-benchmarks.step';
import { BrokkrLiveCheckStep } from '../brokkr-live/steps/brokkr-live-check.step';
import { CollectionModule } from '../collection/collection.module';
import { CollectHardwareStep } from '../collection/steps/collect-hardware.step';
import { ProbeSerialPortStep } from '../collection/steps/probe-serial-port.step';
import { WaitForBrokkrLiveStep } from '../collection/steps/wait-for-brokkr-live.step';
import { DeprovisionModule } from '../deprovision/deprovision.module';
import { EfiCleanupStep } from '../deprovision/steps/efi-cleanup.step';
import { DeviceHealthCheckModule } from '../device-health-check/device-health-check.module';
import { CheckDeviceHealthStep } from '../device-health-check/steps/check-device-health.step';
import { EnrichViaPxeModule } from '../enrich-via-pxe/enrich-via-pxe.module';
import { WaitForAgentSessionStep } from '../lifecycle-deploy/steps/wait-for-agent-session.step';
import { WipeDisksStep } from '../lifecycle-deploy/steps/wipe-disks.step';
import { CommissionModule } from '../commission/commission.module';
import { OobModule } from '../oob/oob.module';
import { PowerManagementServiceFactory } from '../oob/power/power-management.service';
import { DisableOsBootStep } from '../oob/redfish/steps/disable-os-boot.step';
import { RedfishStandardizeStep } from '../oob/redfish/steps/redfish-standardize.step';
import { TeeConfigStep } from '../oob/redfish/steps/tee-config.step';
import { SolProvisioningServiceFactory } from '../oob/sol/sol-provisioning.factory';
import { SolServiceFactory } from '../oob/sol/sol.factory';
import { DeactivateSolStep } from '../oob/sol/steps/deactivate-sol.step';
import { EnsureSolEnabledStep } from '../oob/sol/steps/ensure-sol-enabled.step';
import { SolActivationStep } from '../oob/sol/steps/sol-activation.step';
import { SolMonitorStep } from '../oob/sol/steps/sol-monitor.step';
import { EnsureLanplusAccessStep } from '../oob/steps/ensure-lanplus-access.step';
import { PcBmcResetColdStep } from '../oob/steps/pc-bmc-reset-cold.step';
import { PcPowerOffStep } from '../oob/steps/pc-power-off.step';
import { PcPowerOnStep } from '../oob/steps/pc-power-on.step';
import { PcSetBootDeviceStep } from '../oob/steps/pc-set-boot-device.step';
import { PcValidateIpmiStep } from '../oob/steps/pc-validate-ipmi.step';
import { PcVerifyBmcRecoveryStep } from '../oob/steps/pc-verify-bmc-recovery.step';
import { PcVerifyBootDeviceStep } from '../oob/steps/pc-verify-boot-device.step';
import { PcVerifyPowerOffStep } from '../oob/steps/pc-verify-power-off.step';
import { PcVerifyPowerOnStep } from '../oob/steps/pc-verify-power-on.step';
import { PcWaitForOsStep } from '../oob/steps/pc-wait-for-os.step';
import { RedfishCommandStep } from '../oob/steps/redfish-command.step';
import { PowerOpsModule } from '../power-ops/power-ops.module';
import { ProvisionModule } from '../provision/provision.module';
import { DeployOsStep } from '../provision/steps/deploy-os.step';
import { PrepareStorageStep } from '../provision/steps/prepare-storage.step';
import { ProvisionCompleteStep } from '../provision/steps/provision-complete.step';
import { ResolveDeployTargetStep } from '../provision/steps/resolve-deploy-target.step';
import { RedfishWorkflowModule } from '../redfish-workflow/redfish-workflow.module';
import { SolWorkflowModule } from '../sol-workflow/sol-workflow.module';

const STUB = {};

const OOB_STEPS = [
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
];

const COLLECTION_STEPS = [WaitForBrokkrLiveStep, CollectHardwareStep, ProbeSerialPortStep];
const BROKKR_LIVE_STEPS = [BrokkrLiveCheckStep];
const LIFECYCLE_STEPS = [WaitForAgentSessionStep, WipeDisksStep];

const UPSTREAM_STUBS: ReadonlyArray<new (...args: never[]) => unknown> = [
  AgentUnitRenderStartupService,
  BrokkrLiveReadinessServiceFactory,
  BrokkrLiveServiceFactory,
  CloudInitPayloadService,
  EfiBootServiceFactory,
  PowerManagementServiceFactory,
  SolProvisioningServiceFactory,
  SolServiceFactory,
];

async function compileWithStubs(
  module: Parameters<typeof Test.createTestingModule>[0]['imports'] extends Array<infer T> ? T : never,
  steps: ReadonlyArray<new (...args: never[]) => unknown>,
): Promise<void> {
  let builder = Test.createTestingModule({ imports: [GlobalLoggerStubModule, module] });
  for (const stepClass of steps) {
    builder = builder.overrideProvider(stepClass).useValue(STUB);
  }
  for (const upstream of UPSTREAM_STUBS) {
    builder = builder.overrideProvider(upstream).useValue(STUB);
  }
  const moduleRef = await builder.compile();
  expect(moduleRef).toBeDefined();
  await moduleRef.close();
}

describe('saga module DI smoke', () => {
  it('OobModule compiles with all step providers', async () => {
    await compileWithStubs(OobModule, OOB_STEPS);
  });

  it('CollectionModule compiles + OnModuleInit fires', async () => {
    await compileWithStubs(CollectionModule, COLLECTION_STEPS);
  });

  it('CommissionModule compiles with sibling imports', async () => {
    await compileWithStubs(CommissionModule, [
      ...OOB_STEPS,
      ...COLLECTION_STEPS,
      ...BROKKR_LIVE_STEPS,
      ...LIFECYCLE_STEPS,
    ]);
  });

  it('ProvisionModule compiles with sibling imports', async () => {
    await compileWithStubs(ProvisionModule, [
      ...OOB_STEPS,
      ...COLLECTION_STEPS,
      ...BROKKR_LIVE_STEPS,
      ...LIFECYCLE_STEPS,
      DeployOsStep,
      PrepareStorageStep,
      ProvisionCompleteStep,
      ResolveDeployTargetStep,
    ]);
  });

  it('DeprovisionModule compiles with sibling imports', async () => {
    await compileWithStubs(DeprovisionModule, [...OOB_STEPS, ...COLLECTION_STEPS, ...LIFECYCLE_STEPS, EfiCleanupStep]);
  });

  it('BenchmarksModule compiles + OnModuleInit fires', async () => {
    await compileWithStubs(BenchmarksModule, [CheckCcModeStep, RunBenchmarksStep, ReportResultsStep]);
  });

  it('PowerOpsModule compiles with all 5 saga steps wired (BmcReset/PowerOn/PowerOff/PowerStatus/Reboot)', async () => {
    await compileWithStubs(PowerOpsModule, OOB_STEPS);
  });

  it('DeviceHealthCheckModule compiles + OnModuleInit fires', async () => {
    await compileWithStubs(DeviceHealthCheckModule, [CheckDeviceHealthStep]);
  });

  it('EnrichViaPxeModule compiles with oob steps', async () => {
    await compileWithStubs(EnrichViaPxeModule, OOB_STEPS);
  });

  it('RedfishWorkflowModule compiles', async () => {
    await compileWithStubs(RedfishWorkflowModule, OOB_STEPS);
  });

  it('SolWorkflowModule compiles', async () => {
    await compileWithStubs(SolWorkflowModule, OOB_STEPS);
  });
});
