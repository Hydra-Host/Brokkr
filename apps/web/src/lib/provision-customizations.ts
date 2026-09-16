import { isIpxeCustomOs, OperatingSystemSlugSchema } from '@repo/api-client';

export const DEFAULT_OPERATING_SYSTEM = 'ubuntu-noble-vanilla';

export const TEE_CHECKBOX_LABEL = 'Enable TEE';
export const TEE_CHECKBOX_DESCRIPTION = 'Enable the hardware Trusted Execution Environment (TEE) for this device.';

export type CustomizationFormValues = Record<string, string | string[]>;

export { emptyCustomizations } from '@repo/utils';

export function osCandidateForMode(baseLayers: ReadonlyArray<{ slug: string }>): string {
  return baseLayers[0]?.slug ?? '';
}

export function baseLayersToOsOptions(
  baseLayers: ReadonlyArray<{ name: string; slug: string }>,
): { label: string; value: string }[] {
  return baseLayers
    .map((layer) => ({ label: layer.name, value: layer.slug }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

export function resolveOperatingSystemSlug(candidate: string, fallback: string): string {
  return OperatingSystemSlugSchema.safeParse(candidate).data ?? fallback;
}

export function shouldShowTeeCheckbox(operatingSystem: string, isTeeCapable: boolean): boolean {
  return isIpxeCustomOs(operatingSystem) && isTeeCapable;
}

export function isClusterable(vpcCapable: boolean): boolean {
  return vpcCapable;
}

export function reprovisionTeeDefault(
  defaultOs: string,
  isTeeCapable: boolean,
  teeEnabled: boolean | null | undefined,
): boolean {
  return shouldShowTeeCheckbox(defaultOs, isTeeCapable) && (teeEnabled ?? false);
}

export function flattenCustomizationsForSubmit(
  values: CustomizationFormValues | undefined,
): Record<string, string | string[]> | null {
  if (!values) return null;
  const cleaned: Record<string, string | string[]> = {};
  for (const [key, val] of Object.entries(values)) {
    if (Array.isArray(val) && val.length > 0) cleaned[key] = val;
    else if (typeof val === 'string' && val) cleaned[key] = val;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}
