
import { SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';

import { EfiCleanupStep } from '../../deprovision/steps/efi-cleanup.step';
import { EFI_BOOT_SERVICE_FACTORY } from '../efi-boot.service';
import { WipeDisksStep } from '../steps/wipe-disks.step';

interface SelfDeclaredDep {
  readonly index: number;
  readonly param: unknown;
}

function findInjectedToken(target: unknown, paramIndex: number): unknown {
  const deps = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, target) ?? []) as SelfDeclaredDep[];
  const match = deps.find((d) => d.index === paramIndex);
  return match?.param;
}

describe('— @Inject(EFI_BOOT_SERVICE_FACTORY) on saga step consumers', () => {
  it('WipeDisksStep injects EFI_BOOT_SERVICE_FACTORY at constructor param index 2', () => {
    expect(findInjectedToken(WipeDisksStep, 2)).toBe(EFI_BOOT_SERVICE_FACTORY);
  });

  it('EfiCleanupStep injects EFI_BOOT_SERVICE_FACTORY at constructor param index 0', () => {
    expect(findInjectedToken(EfiCleanupStep, 0)).toBe(EFI_BOOT_SERVICE_FACTORY);
  });
});
