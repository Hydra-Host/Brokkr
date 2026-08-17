import type { SagaContext, SagaDef, SagaStepExecutor } from '../saga-framework/saga.types';

export interface ProvisionSagaStepServices {
  brokkrLiveCheck: SagaStepExecutor;
  pcPowerOff: SagaStepExecutor;
  pcVerifyPowerOff: SagaStepExecutor;
  pcSetBootDevice: SagaStepExecutor;
  pcVerifyBootDevice: SagaStepExecutor;
  pcPowerOn: SagaStepExecutor;
  pcVerifyPowerOn: SagaStepExecutor;
  waitForBrokkrLive: SagaStepExecutor;
  disableOsBoot: SagaStepExecutor;
  teeConfig: SagaStepExecutor;
  waitForAgentSession: SagaStepExecutor;
  resolveDeployTarget: SagaStepExecutor;
  wipeDisks: SagaStepExecutor;
  prepareStorage: SagaStepExecutor;
  deployOs: SagaStepExecutor;
  armCustomIpxeBoot: SagaStepExecutor;
  ensureSolEnabled: SagaStepExecutor;
  solActivation: SagaStepExecutor;
  provisionComplete: SagaStepExecutor;
}

export function buildProvisionSaga(steps: ProvisionSagaStepServices): SagaDef {
  return {
    name: 'provision',
    steps: [
      {
        name: 'brokkr_live_check',
        operation: 'Check Brokkr Live readiness',
        execute: (ctx: SagaContext) => steps.brokkrLiveCheck.execute(ctx),
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
        name: 'disable_os_boot',
        operation: 'Disable OS boot options',
        execute: (ctx: SagaContext) => steps.disableOsBoot.execute(ctx),
      },
      {
        name: 'tee_config',
        operation: 'Configure TEE via Redfish',
        execute: (ctx: SagaContext) => steps.teeConfig.execute(ctx),
      },
      {
        name: 'wait_for_agent_session',
        operation: 'Wait for agent gRPC session',
        execute: (ctx: SagaContext) => steps.waitForAgentSession.execute(ctx),
      },
      {
        name: 'resolve_deploy_target',
        operation: 'Resolve deploy target IP',
        execute: (ctx: SagaContext) => steps.resolveDeployTarget.execute(ctx),
      },
      {
        name: 'wipe_disks',
        operation: 'Pre-deployment disk wipe (NIST SP 800-88r2)',
        execute: (ctx: SagaContext) => steps.wipeDisks.execute(ctx),
        maxAttempts: 2,
        recovery: [
          {
            rewindTo: 'wait_for_brokkr_live',
            description: 'Re-verify Brokkr Live readiness, retry disk wipe',
          },
        ],
      },
      {
        name: 'prepare_storage',
        operation: 'Partition and format disks',
        execute: (ctx: SagaContext) => steps.prepareStorage.execute(ctx),
        maxAttempts: 2,
        recovery: [
          {
            rewindTo: 'live_reboot_power_off',
            description: 'Reboot back into Brokkr Live, re-wipe, retry storage prep',
          },
        ],
      },
      {
        name: 'deploy_os',
        operation: 'Deploy operating system',
        execute: (ctx: SagaContext) => steps.deployOs.execute(ctx),
        maxAttempts: 3,
        recovery: [
          { rewindTo: 'prepare_storage', description: 'Re-partition and retry' },
          { rewindTo: 'brokkr_live_check', description: 'Reboot and full restart' },
        ],
      },
      {
        name: 'arm_custom_ipxe_boot',
        operation: 'Arm custom iPXE boot',
        execute: (ctx: SagaContext) => steps.armCustomIpxeBoot.execute(ctx),
        maxAttempts: 2,
        recovery: [{ rewindTo: 'arm_custom_ipxe_boot', description: 'Retry custom iPXE boot marker' }],
      },
      {
        name: 'power_off',
        operation: 'Power off server',
        execute: (ctx: SagaContext) => steps.pcPowerOff.execute(ctx),
      },
      {
        name: 'verify_power_off',
        operation: 'Verify server powered off',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOff.execute(ctx),
      },
      {
        name: 'set_boot_device',
        operation: 'Set boot device',
        execute: (ctx: SagaContext) => steps.pcSetBootDevice.execute(ctx),
      },
      {
        name: 'verify_boot_device',
        operation: 'Verify boot device set',
        execute: (ctx: SagaContext) => steps.pcVerifyBootDevice.execute(ctx),
      },
      {
        name: 'power_on',
        operation: 'Power on server',
        execute: (ctx: SagaContext) => steps.pcPowerOn.execute(ctx),
      },
      {
        name: 'verify_power_on',
        operation: 'Verify server powered on',
        execute: (ctx: SagaContext) => steps.pcVerifyPowerOn.execute(ctx),
      },
      {
        name: 'ensure_sol_enabled',
        operation: 'Ensure SOL is enabled on BMC',
        execute: (ctx: SagaContext) => steps.ensureSolEnabled.execute(ctx),
      },
      {
        name: 'sol_activation',
        operation: 'Activate SOL monitoring',
        execute: (ctx: SagaContext) => steps.solActivation.execute(ctx),
      },
      {
        name: 'provision_complete',
        operation: 'Signal provision complete',
        execute: (ctx: SagaContext) => steps.provisionComplete.execute(ctx),
      },
    ],
  };
}
