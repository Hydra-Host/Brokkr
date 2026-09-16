import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation, PciDeviceUpsert } from '../collector.types';
import { type GhwPciInput, ghwPciDeviceSchema, ghwPciSchema } from './ghw_pci.schema';

@Injectable()
export class GhwPciHandler implements CollectorHandler<GhwPciInput> {
  readonly name = 'ghw_pci' as const;
  readonly schema = ghwPciSchema;

  async handle(input: GhwPciInput): Promise<DeviceMutation> {
    const devices: PciDeviceUpsert[] = [];
    const failures: string[] = [];

    input.pci.Devices.forEach((raw, idx) => {
      const parsed = ghwPciDeviceSchema.safeParse(raw);
      if (!parsed.success) {
        failures.push(`Devices[${idx}]`);
        return;
      }
      const dev = parsed.data;
      devices.push({
        address: dev.address,
        vendorId: dev.vendor.id,
        vendorName: dev.vendor.name || null,
        productId: dev.product.id,
        productName: dev.product.name || null,
        className: dev.class?.name || null,
        subclassName: dev.subclass?.name || null,
        driver: dev.driver || null,
        subsystemVendorId: null,
        subsystemProductId: dev.subsystem?.id || null,
      });
    });

    const warnings =
      failures.length > 0
        ? [`ghw_pci: ${failures.length}/${input.pci.Devices.length} devices skipped (malformed)`]
        : undefined;

    return {
      upserts: devices.length ? { pciDevices: devices } : undefined,
      warnings,
      pciDevicesPartial: failures.length > 0,
    };
  }
}
