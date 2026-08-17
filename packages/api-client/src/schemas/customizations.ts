import { z } from 'zod';

export const CustomizationOptionRelationSchema = z.object({
  relatedOptionValue: z.string().describe('The value of the related option in another layer'),
  type: z
    .enum(['CONFLICTS', 'REQUIRES'])
    .describe('Relation type: CONFLICTS disables the related option, REQUIRES demands it'),
  groupId: z
    .string()
    .nullable()
    .optional()
    .describe('OR group ID — relations sharing a groupId mean any one satisfies the requirement'),
});
export type CustomizationOptionRelation = z.infer<typeof CustomizationOptionRelationSchema>;

export const CustomizationOptionAvailabilitySchema = z.object({
  os_distro: z.string().optional().describe('OS distribution filter (e.g. "ubuntu", "debian")'),
  os_variant: z.string().optional().describe('OS variant filter (e.g. "vanilla", "hpc")'),
  os_codename: z.string().optional().describe('OS codename filter (e.g. "jammy", "noble")'),
});
export type CustomizationOptionAvailability = z.infer<typeof CustomizationOptionAvailabilitySchema>;

export const CustomizationHardwareCompatibilitySchema = z
  .object({
    gpuFamilies: z
      .array(z.string())
      .describe(
        'GPU family identifiers this option supports (e.g. ["h100", "h200", "b200"]). Matched against device GPU model.',
      ),
  })
  .describe('Hardware compatibility constraints for this option');
export type CustomizationHardwareCompatibility = z.infer<typeof CustomizationHardwareCompatibilitySchema>;

export const CustomizationOptionSchema = z.object({
  value: z.string().describe('Unique slug value submitted in the customizations record'),
  label: z.string().describe('Human-readable label for display'),
  availability: z
    .array(CustomizationOptionAvailabilitySchema)
    .nullable()
    .describe('OS matchers (AND within entry, OR across entries). Null means available for all OSes.'),
  relations: z.array(CustomizationOptionRelationSchema).describe('Cross-layer relations (conflicts and requirements)'),
  hardwareCompatibility: CustomizationHardwareCompatibilitySchema.nullable()
    .optional()
    .describe('GPU hardware compatibility. Null means compatible with all hardware.'),
});
export type CustomizationOption = z.infer<typeof CustomizationOptionSchema>;

export const CustomizationLayerSchema = z.object({
  slug: z.string().describe('Layer key used in the customizations record'),
  name: z.string().describe('Human-readable layer name'),
  selectionType: z.enum(['SINGLE_SELECT', 'MULTI_SELECT']).describe('Whether the user picks one option or many'),
  options: z.array(CustomizationOptionSchema).describe('Available options within this layer'),
});
export type CustomizationLayer = z.infer<typeof CustomizationLayerSchema>;

export const BaseLayerSchema = z.object({
  id: z.string().describe('Layer ID for the base image'),
  slug: z.string().describe('Base layer slug — submitted as the operatingSystem field at provision time'),
  name: z.string().describe('Display name for the base image'),
  family: z.string().nullable().describe('Stack-ordering family (typically "base")'),
});
export type BaseLayer = z.infer<typeof BaseLayerSchema>;

export const availableLayersFields = {
  availableBaseLayers: z
    .array(BaseLayerSchema)
    .describe('Modern base OS layers (kind=BASE) sourced from the layer catalog — device-agnostic'),
  availableComponentLayersByBase: z
    .record(z.string(), z.array(CustomizationLayerSchema))
    .describe(
      'Per-base customization layer catalog, keyed by base layer slug. Each value is the form-ready layer list for that base, intersected with the device hardware-eligible set and carrying artifact-scoped relations.',
    ),
} as const;

export const LAYER_DISPLAY_ORDER: Record<string, number> = {
  tee: -1,
  gpuFramework: 0,
  gpuDriver: 1,
  mlFramework: 2,
  miscSoftware: 3,
};

export function compareCustomizationLayers(a: { slug: string }, b: { slug: string }): number {
  const ao = LAYER_DISPLAY_ORDER[a.slug] ?? 99;
  const bo = LAYER_DISPLAY_ORDER[b.slug] ?? 99;
  return ao - bo;
}
