import { Injectable } from '@nestjs/common';
import type { CollectorHandler, DeviceMutation } from '../collector.types';
import { type VirtualizationInput, virtualizationSchema } from './virtualization.schema';

@Injectable()
export class VirtualizationHandler implements CollectorHandler<VirtualizationInput> {
  readonly name = 'virtualization' as const;
  readonly schema = virtualizationSchema;

  async handle(input: VirtualizationInput): Promise<DeviceMutation> {
    const deviceUpdate: DeviceMutation['deviceUpdate'] = {};
    if (typeof input.iommu_groups_enabled === 'boolean') deviceUpdate.iommuEnabled = input.iommu_groups_enabled;
    if (typeof input.sriov_bios_enabled === 'boolean') deviceUpdate.sriovEnabled = input.sriov_bios_enabled;
    return { deviceUpdate };
  }
}
