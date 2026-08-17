import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, UefiBootEntryUpsert } from '../collector.types';
import { type EfibootmgrInput, efibootmgrSchema } from './efibootmgr.schema';

@Injectable()
export class EfibootmgrHandler implements CollectorHandler<EfibootmgrInput> {
  readonly name = 'efibootmgr' as const;
  readonly schema = efibootmgrSchema;

  async handle(input: EfibootmgrInput): Promise<DeviceMutation> {
    const current = input.boot_current;
    const order = input.boot_order ?? [];

    const entries: UefiBootEntryUpsert[] = input.boot_options.map((opt) => {
      const ref = stripBootPrefix(opt.boot_option_reference);
      const orderIndex = order.indexOf(ref);
      return {
        bootOptionReference: ref,
        displayName: opt.display_name,
        uefiDevicePath: opt.uefi_device_path ?? null,
        enabled: opt.boot_option_enabled,
        bootOrderIndex: orderIndex >= 0 ? orderIndex : null,
        isCurrent: ref === current,
      };
    });

    return { upserts: { uefiBootEntries: entries } };
  }
}

function stripBootPrefix(ref: string): string {
  return ref.startsWith('Boot') ? ref.slice(4) : ref;
}
