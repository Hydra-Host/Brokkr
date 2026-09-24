
import { describe, expect, it } from 'vitest';

import { BUILTIN_SAGAS, DEPROVISION_SAGA, COMMISSION_SAGA, PROVISION_SAGA } from './builtin-sagas.fixture';

const stepNames = (saga: { steps: ReadonlyArray<{ name: string }> }): string[] => saga.steps.map((step) => step.name);

describe('destructive saga step-name sequences', () => {
  it('provision saga has the expected ordered step sequence', () => {
    expect(stepNames(PROVISION_SAGA)).toEqual([
      'disarm_custom_ipxe_boot',
      'brokkr_live_check',
      'live_reboot_power_off',
      'live_reboot_verify_power_off',
      'live_reboot_set_boot_device',
      'live_reboot_verify_boot_device',
      'live_reboot_power_on',
      'live_reboot_verify_power_on',
      'wait_for_brokkr_live',
      'disable_os_boot',
      'tee_config',
      'wait_for_agent_session',
      'resolve_deploy_target',
      'wipe_disks',
      'prepare_storage',
      'deploy_os',
      'arm_custom_ipxe_boot',
      'power_off',
      'verify_power_off',
      'set_boot_device',
      'verify_boot_device',
      'power_on',
      'verify_power_on',
      'ensure_sol_enabled',
      'sol_activation',
      'provision_complete',
    ]);
  });

  it('retries the custom iPXE boot marker at the same step', () => {
    const step = PROVISION_SAGA.steps.find((candidate) => candidate.name === 'arm_custom_ipxe_boot');

    expect(step?.maxAttempts).toBe(2);
    expect(step?.recovery).toEqual([
      { rewindTo: 'arm_custom_ipxe_boot', description: 'Retry custom iPXE boot marker' },
    ]);
  });

  it('commission saga has the expected ordered step sequence', () => {
    expect(stepNames(COMMISSION_SAGA)).toEqual([
      'ipmi_validation',
      'redfish_standardize',
      'brokkr_live_check',
      'disable_os_boot',
      'live_reboot_power_off',
      'live_reboot_verify_power_off',
      'live_reboot_set_boot_device',
      'live_reboot_verify_boot_device',
      'live_reboot_power_on',
      'live_reboot_verify_power_on',
      'wait_for_brokkr_live',
      'wait_for_agent_session',
      'disk_wipe',
      'collect_hardware',
    ]);
  });

  it('commission retries the disk wipe once via a reboot cycle rewind', () => {
    const step = COMMISSION_SAGA.steps.find((candidate) => candidate.name === 'disk_wipe');

    expect(step?.maxAttempts).toBe(2);
    expect(step?.recovery).toEqual([
      { rewindTo: 'live_reboot_power_off', description: 'Reboot and retry wipe' },
    ]);
  });

  it('deprovision saga has the expected ordered step sequence', () => {
    expect(stepNames(DEPROVISION_SAGA)).toEqual([
      'disable_os_boot',
      'ensure_sol_enabled',
      'sol_activation',
      'power_off',
      'verify_power_off',
      'set_boot_device',
      'verify_boot_device',
      'power_on',
      'verify_power_on',
      'wait_for_brokkr_live',
      'disk_wipe',
      'efi_cleanup',
      'collect_hardware',
    ]);
  });

  it('deprovision retries the disk wipe in place then falls back to a full reboot cycle', () => {
    const step = DEPROVISION_SAGA.steps.find((candidate) => candidate.name === 'disk_wipe');

    expect(step?.maxAttempts).toBe(3);
    expect(step?.recovery).toEqual([
      { rewindTo: 'disk_wipe', description: 'Retry disk wipe' },
      { rewindTo: 'power_off', description: 'Reboot and retry disk wipe' },
    ]);
  });
});

describe('saga recovery rewindTo targets the same or an earlier step', () => {
  it.each(BUILTIN_SAGAS.map((saga) => [saga.name, saga] as const))(
    '%s: no recovery.rewindTo is a forward reference',
    (_name, saga) => {
      saga.steps.forEach((step, index) => {
        for (const recovery of step.recovery ?? []) {
          const targetIndex = saga.steps.findIndex((s) => s.name === recovery.rewindTo);
          expect(
            targetIndex,
            `${saga.name}.${step.name} rewindTo '${recovery.rewindTo}' must name a declared step`,
          ).toBeGreaterThanOrEqual(0);
          expect(
            targetIndex,
            `${saga.name}.${step.name} rewindTo '${recovery.rewindTo}' must be this step or an earlier one`,
          ).toBeLessThanOrEqual(index);
        }
      });
    },
  );
});
