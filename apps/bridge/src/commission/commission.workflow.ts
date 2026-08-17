import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface CommissionSagaStepServices {
  validateIpmi: SagaStepExecutor;
  redfishStandardize: SagaStepExecutor;
  brokkrLiveCheck: SagaStepExecutor;
  disableOsBoot: SagaStepExecutor;
  pcPowerOff: SagaStepExecutor;
  pcVerifyPowerOff: SagaStepExecutor;
  pcSetBootDevice: SagaStepExecutor;
  pcVerifyBootDevice: SagaStepExecutor;
  pcPowerOn: SagaStepExecutor;
  pcVerifyPowerOn: SagaStepExecutor;
  waitForBrokkrLive: SagaStepExecutor;
  waitForAgentSession: SagaStepExecutor;
  wipeDisks: SagaStepExecutor;
  collectHardware: SagaStepExecutor;
}

export function buildCommissionSaga(steps: CommissionSagaStepServices): SagaDef {
  return {
    name: 'commission',
    steps: [
      {
        name: 'ipmi_validation',
        operation: 'Validate IPMI credentials',
        execute: (ctx: SagaContext) => steps.validateIpmi.execute(ctx),
      },
      {
        name: 'redfish_standardize',
        operation: 'Standardize BIOS via Redfish',
        execute: (ctx: SagaContext) => steps.redfishStandardize.execute(ctx),
      },
      {
        name: 'brokkr_live_check',
        operation: 'Check Brokkr Live readiness',
        execute: (ctx: SagaContext) => steps.brokkrLiveCheck.execute(ctx),
      },
      {
        name: 'disable_os_boot',
        operation: 'Disable OS boot options',
        execute: (ctx: SagaContext) => steps.disableOsBoot.execute(ctx),
      },
      {
        name: 'live_reboot_power_off',
        operation: 'Power off server',
        execute: (ctx: SagaContext) => steps.pcPowerOff.execute(ctx),
      },
      {
        name: 'live_reboot_verify_power_off',
        operation: 'Verify server powered off',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOff.execute(ctx),
      },
      {
        name: 'live_reboot_set_boot_device',
        operation: 'Set boot device',
        execute: (ctx: SagaContext) => steps.pcSetBootDevice.execute(ctx),
      },
      {
        name: 'live_reboot_verify_boot_device',
        operation: 'Verify boot device set',
        execute: (ctx: SagaContext) => steps.pcVerifyBootDevice.execute(ctx),
      },
      {
        name: 'live_reboot_power_on',
        operation: 'Power on server',
        execute: (ctx: SagaContext) => steps.pcPowerOn.execute(ctx),
      },
      {
        name: 'live_reboot_verify_power_on',
        operation: 'Verify server powered on',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOn.execute(ctx),
      },
      {
        name: 'wait_for_brokkr_live',
        operation: 'Wait for Brokkr Live OS',
        execute: (ctx: SagaContext) => steps.waitForBrokkrLive.execute(ctx),
      },
      {
        name: 'wait_for_agent_session',
        operation: 'Wait for agent gRPC session',
        execute: (ctx: SagaContext) => steps.waitForAgentSession.execute(ctx),
      },
      {
        name: 'disk_wipe',
        operation: 'Wipe all disks',
        execute: (ctx: SagaContext) => steps.wipeDisks.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'live_reboot_power_off', description: 'Reboot and retry wipe' }],
      },
      {
        name: 'collect_hardware',
        operation: 'Collect hardware facts',
        execute: (ctx: SagaContext) => steps.collectHardware.execute(ctx),
      },
    ],
  };
}
