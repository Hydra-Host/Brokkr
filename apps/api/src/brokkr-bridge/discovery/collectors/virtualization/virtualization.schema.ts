import { z } from 'zod';

export const virtualizationSchema = z
  .object({
    hypervisor_enabled: z.boolean().nullable().optional(),
    iommu_groups_enabled: z.boolean().nullable().optional(),
    sriov_bios_enabled: z.boolean().nullable().optional(),
  })
  .passthrough();

export type VirtualizationInput = z.infer<typeof virtualizationSchema>;
